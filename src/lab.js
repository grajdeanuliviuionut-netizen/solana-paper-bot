// Scores extra rules on every scan. Does not spend the real balance or the 3 live slots.
const COST_PCT = 1.1;

const RULES = [
  {
    id: 'lab-dip',
    minLiq: 20000, maxLiq: 400000, minAge: 0.5, maxAge: 45,
    entry: [
      { field: 'h1', op: '<=', value: -4 },
      { field: 'h1', op: '>=', value: -15 },
      { field: 'm5', op: '>=', value: 0 },
      { field: 'bsr', op: '>=', value: 1.3 },
      { field: 'vl', op: '>=', value: 0.05 }
    ],
    tp: 9, sl: 6, earlyMin: 8, earlyPeak: 1.5, maxHold: 25
  },
  {
    id: 'lab-buyers',
    minLiq: 20000, maxLiq: 800000, minAge: 0.05, maxAge: 40,
    entry: [
      { field: 'h1', op: '>=', value: -8 },
      { field: 'h1', op: '<=', value: 8 },
      { field: 'm5', op: '>=', value: 0 },
      { field: 'bsr', op: '>=', value: 1.6 },
      { field: 'vl', op: '>=', value: 0.08 }
    ],
    tp: 8, sl: 6, earlyMin: 8, earlyPeak: 1.5, maxHold: 20
  },
  {
    id: 'lab-fresh',
    minLiq: 15000, maxLiq: 180000, minAge: 0.02, maxAge: 3,
    entry: [
      { field: 'h1', op: '>=', value: 2 },
      { field: 'h1', op: '<=', value: 25 },
      { field: 'm5', op: '>=', value: 0 },
      { field: 'bsr', op: '>=', value: 1.5 },
      { field: 'vl', op: '>=', value: 0.12 }
    ],
    tp: 10, sl: 7, earlyMin: 6, earlyPeak: 1.5, maxHold: 15
  },
  {
    id: 'lab-quiet',
    minLiq: 40000, maxLiq: 500000, minAge: 2, maxAge: 60,
    entry: [
      { field: 'h1', op: '<=', value: -3 },
      { field: 'h1', op: '>=', value: -10 },
      { field: 'm5', op: '>=', value: 0.4 },
      { field: 'bsr', op: '>=', value: 1.2 },
      { field: 'vl', op: '>=', value: 0.04 }
    ],
    tp: 8, sl: 6, earlyMin: 10, earlyPeak: 1.2, maxHold: 30
  }
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function field(pair, name) {
  const change = pair.priceChange || {};
  if (name === 'h1') return num(change.h1);
  if (name === 'm5') return num(change.m5);
  if (name === 'bsr') {
    const buys = num(pair.txns && pair.txns.buys);
    const sells = num(pair.txns && pair.txns.sells) || 1;
    return buys / sells;
  }
  if (name === 'vl') return num(pair.volumeH1) / (num(pair.liquidityUsd) || 1);
  return 0;
}

function match(pair, rule) {
  const liq = num(pair.liquidityUsd);
  const age = num(pair.ageDays);
  if (liq < rule.minLiq || liq > rule.maxLiq) return false;
  if (age < rule.minAge || age > rule.maxAge) return false;
  if (!(num(pair.priceUsd) > 0)) return false;
  for (const cond of rule.entry) {
    const value = field(pair, cond.field);
    if (cond.op === '>=' && !(value >= cond.value)) return false;
    if (cond.op === '<=' && !(value <= cond.value)) return false;
  }
  return true;
}

function step(state, pairs) {
  const notes = [];
  if (!state.lab || typeof state.lab !== 'object') state.lab = {};
  const lab = state.lab;
  if (!Array.isArray(lab.open)) lab.open = [];
  if (!Array.isArray(lab.closed)) lab.closed = [];
  const list = Array.isArray(pairs) ? pairs : [];
  const by = {};
  for (const pair of list) {
    if (pair && pair.pairAddress) by[pair.pairAddress] = pair;
  }

  const still = [];
  for (const pos of lab.open) {
    const pair = by[pos.pairAddress];
    const price = pair && num(pair.priceUsd) > 0 ? num(pair.priceUsd) : num(pos.entryPrice);
    const mins = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
    const change = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    if (price > (pos.high || 0)) pos.high = price;
    const peak = ((pos.high - pos.entryPrice) / pos.entryPrice) * 100;
    let reason = '';
    if (change >= pos.tp) reason = 'tp';
    else if (change <= -pos.sl) reason = 'sl';
    else if (mins >= pos.earlyMin && peak < pos.earlyPeak) reason = 'stall';
    else if (mins >= pos.maxHold) reason = 'time';
    if (!reason) {
      still.push(pos);
      continue;
    }
    const pnl = 0.1 * ((change - COST_PCT) / 100);
    lab.closed.unshift({ rule: pos.rule, symbol: pos.symbol, pnl: pnl, reason: reason, at: new Date().toISOString() });
    if (lab.closed.length > 200) lab.closed.pop();
  }
  lab.open = still;

  for (const rule of RULES) {
    for (const pair of list) {
      if (lab.open.filter(function (pos) { return pos.rule === rule.id; }).length >= 3) break;
      if (lab.open.some(function (pos) { return pos.rule === rule.id && pos.symbol === pair.symbol; })) continue;
      if (!match(pair, rule)) continue;
      lab.open.push({
        rule: rule.id,
        symbol: pair.symbol,
        pairAddress: pair.pairAddress,
        entryPrice: num(pair.priceUsd),
        entryTime: new Date().toISOString(),
        high: num(pair.priceUsd),
        tp: rule.tp,
        sl: rule.sl,
        earlyMin: rule.earlyMin,
        earlyPeak: rule.earlyPeak,
        maxHold: rule.maxHold
      });
    }
  }
  if (lab.open.length > 40) lab.open = lab.open.slice(0, 40);

  const scores = {};
  for (const trade of lab.closed) {
    const row = scores[trade.rule] || (scores[trade.rule] = { n: 0, pnl: 0, wins: 0, best: 0 });
    row.n += 1;
    row.pnl += num(trade.pnl);
    if (trade.pnl > 0) row.wins += 1;
    if (trade.pnl > row.best) row.best = trade.pnl;
  }
  let lead = null;
  for (const id of Object.keys(scores)) {
    const row = scores[id];
    const without = row.pnl - (row.best > 0 ? row.best : 0);
    if (row.n >= 12 && row.pnl > 0 && without > 0 && (!lead || row.pnl > lead.pnl)) {
      lead = { id: id, n: row.n, pnl: row.pnl, without: without };
    }
  }
  if (lead && state.labLead !== lead.id) {
    state.labLead = lead.id;
    notes.push('LAB lead ' + lead.id + ': ' + lead.n + ' trades, ' + lead.pnl.toFixed(4) + ' SOL, still up without the best trade');
  }
  const ids = Object.keys(scores);
  lab.lines = ids.length
    ? ids.map(function (id) {
      const row = scores[id];
      return id + ' ' + row.n + ' trades ' + (row.pnl >= 0 ? '+' : '') + row.pnl.toFixed(3) + ' SOL';
    })
    : ['scanner on, ' + lab.open.length + ' ideas open, 0 scored yet'];
  lab.watching = lab.open.length;
  return notes;
}

module.exports = { step: step, RULES: RULES };
