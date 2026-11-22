// t85u (Liviu 22 Nov): P&L by strategy since a scoreboard start, reconciled against the equity change.
// Read-only: it never changes balances, positions, exits or sizes.
//
// Source of closed trades: the append-only trades.jsonl (complete), unioned with the in-memory lists
// (state.trades is capped at 100 legacy trades, which is why the books-v1 per-strategy sums on
// /api/trades fell 0.018 SOL short of the equity change). Deduplicated by id + closedAt.
//
// Counting (one identity, cost basis):
//   equity(t)        = cash + cost basis still locked in open positions
//   equity change    = sum of realised P&L booked in the window, where
//     book trades    -> every sell leg with leg.at in the window (partial sells are booked when they
//                       happen, so a position carried across a start only counts its in-window legs);
//                       leg.pnlSol = solOut - basis - 1.1% x basis (costs inside, pro rata per leg)
//     legacy trades  -> pnlSol at closedAt (one full close; 1.1% inside pnlSol)
//     open positions -> their partial legs already sold in the window (realisedOpenSol)
//   residual         = equity change - that sum (should be ~0)
//   marked           = equity + unrealised (open tokens at the Jupiter sell quote, net of 1.1%).
const fs = require('fs');

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r = (v, d) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d == null ? 6 : d));

function keyOf(t) {
  const isBook = !!t.book && !t.legacy;
  const sid = t.strategyId || t.book || 'unknown';
  return { key: isBook ? sid + ' v' + (t.bookVersion || 1) : sid + ' legacy', strategyId: sid, kind: isBook ? 'book' : 'legacy', version: isBook ? (t.bookVersion || 1) : null };
}
function compact(t) {
  return { id: t.id || null, symbol: t.symbol || null, strategyId: t.strategyId || t.book || null, book: t.book || null, bookVersion: t.bookVersion || null, legacy: !!t.legacy || !t.book,
    sizeSol: num(t.sizeSol), pnlSol: num(t.pnlSol), closedAt: t.closedAt || null, entryTime: t.entryTime || null, exitReason: t.exitReason || null,
    legs: Array.isArray(t.legs) ? t.legs.map(l => ({ at: l.at, pnlSol: num(l.pnlSol), costSol: num(l.costSol), basisSol: num(l.basisSol), solOut: num(l.solOut), reason: l.reason, sellPctOfOriginal: l.sellPctOfOriginal })) : null };
}

let cache = { key: null, trades: [] };
function readTradesFile(file) {
  try {
    const st = fs.statSync(file);
    const key = file + ':' + st.size + ':' + st.mtimeMs;
    if (cache.key === key) return { ok: true, trades: cache.trades };
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { const t = JSON.parse(line); if (t && t.closedAt) out.push(compact(t)); } catch (e) { /* skip a torn line */ }
    }
    cache = { key, trades: out };
    return { ok: true, trades: out };
  } catch (e) { return { ok: false, trades: [], error: String(e.message || e).slice(0, 80) }; }
}
function mergeTrades(fileTrades, memTrades) {
  const seen = new Set(), out = [];
  for (const t of fileTrades.concat((memTrades || []).map(compact))) {
    const k = (t.id || t.symbol + ':' + t.entryTime) + '@' + t.closedAt;
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out;
}

// Unrealised P&L of one open position, net of the 1.1% round-trip cost on what is still held.
function unrealisedOf(p, costPct) {
  const isBook = !!p.book && !p.legacyOpen;
  if (isBook) {
    if (!p.lastQuote || p.lastQuote.outAmount == null) return null;
    return Number(p.lastQuote.outAmount) / 1e9 - num(p.costBasisRemainingSol) * (1 + costPct / 100);
  }
  if (p.markPct != null) return num(p.sizeSol) * (num(p.markPct) / 100 - costPct / 100);
  const e = num(p.entryPrice), x = num(p.lastPrice);
  return e > 0 && x > 0 ? num(p.sizeSol) * (x / e - 1 - costPct / 100) : null;
}
function lockedOf(p) { return (!!p.book && !p.legacyOpen) ? num(p.costBasisRemainingSol) : num(p.sizeSol); }

// Pure reconciliation. win = { since, until|null, startEquity, startBalance? }.
function reconcile({ trades, openBook, openLegacy, balance, win, costPct, now }) {
  costPct = costPct == null ? 1.1 : costPct;
  const s = Date.parse(win.since), u = win.until ? Date.parse(win.until) : Infinity;
  const inWin = at => { const x = Date.parse(at); return x >= s && x < u; };
  const rows = {};
  const row = t => { const k = keyOf(t); return rows[k.key] || (rows[k.key] = { key: k.key, strategyId: k.strategyId, kind: k.kind, version: k.version, trades: 0, wins: 0, realisedSol: 0, costsSol: 0, partialLegs: 0, carriedTrades: 0, realisedOpenSol: 0, open: 0, lockedSol: 0, unrealisedSol: 0, unmarked: 0 }); };
  for (const t of trades) {
    if (Array.isArray(t.legs) && t.legs.length) {
      const legs = t.legs.filter(l => l.at && inWin(l.at));
      if (!legs.length) continue;
      const x = row(t);
      const p = legs.reduce((a, l) => a + l.pnlSol, 0);
      x.realisedSol += p; x.costsSol += legs.reduce((a, l) => a + l.costSol, 0);
      x.partialLegs += legs.filter(l => /partial/.test(String(l.reason))).length;
      if (inWin(t.closedAt)) { x.trades++; if (t.pnlSol > 0) x.wins++; }
      if (legs.length < t.legs.length) x.carriedTrades++;
    } else {
      if (!t.closedAt || !inWin(t.closedAt)) continue;
      const x = row(t);
      x.realisedSol += t.pnlSol; x.costsSol += t.sizeSol * costPct / 100; x.trades++; if (t.pnlSol > 0) x.wins++;
    }
  }
  const openNow = !win.until;
  for (const p of (openBook || []).concat(openLegacy || [])) {
    const x = row(Object.assign({}, p, { legacy: !p.book }));
    const legs = (p.legs || []).filter(l => l.at && inWin(l.at));
    x.realisedOpenSol += legs.reduce((a, l) => a + num(l.pnlSol), 0);
    x.costsSol += legs.reduce((a, l) => a + num(l.costSol), 0);
    x.partialLegs += legs.filter(l => /partial/.test(String(l.reason))).length;
    if (openNow) {
      x.open++; x.lockedSol += lockedOf(p);
      const un = unrealisedOf(p, costPct);
      if (un == null) x.unmarked++; else x.unrealisedSol += un;
    }
  }
  const list = Object.values(rows).map(x => Object.assign(x, {
    realisedSol: r(x.realisedSol), costsSol: r(x.costsSol), realisedOpenSol: r(x.realisedOpenSol), lockedSol: r(x.lockedSol), unrealisedSol: r(x.unrealisedSol),
    totalRealisedSol: r(x.realisedSol + x.realisedOpenSol), totalSol: r(x.realisedSol + x.realisedOpenSol + x.unrealisedSol),
    winRatePct: x.trades ? +((100 * x.wins) / x.trades).toFixed(1) : null
  })).sort((a, b) => a.totalSol - b.totalSol);
  const byStrategy = {};
  for (const x of list) {
    const g = byStrategy[x.strategyId] || (byStrategy[x.strategyId] = { strategyId: x.strategyId, trades: 0, realisedSol: 0, unrealisedSol: 0, totalSol: 0, costsSol: 0, open: 0 });
    g.trades += x.trades; g.realisedSol = r(g.realisedSol + x.totalRealisedSol); g.unrealisedSol = r(g.unrealisedSol + x.unrealisedSol); g.totalSol = r(g.totalSol + x.totalSol); g.costsSol = r(g.costsSol + x.costsSol); g.open += x.open;
  }
  const realised = list.reduce((a, x) => a + x.totalRealisedSol, 0);
  const unrealised = list.reduce((a, x) => a + x.unrealisedSol, 0);
  const locked = (openBook || []).concat(openLegacy || []).reduce((a, p) => a + lockedOf(p), 0);
  const equityNow = win.until ? num(win.endEquity) : num(balance) + locked;
  const change = equityNow - num(win.startEquity);
  return {
    window: { since: win.since, until: win.until || null, epoch: win.epoch || null },
    startEquity: r(num(win.startEquity)), startBalance: win.startBalance == null ? null : r(num(win.startBalance)), startMarkedEquity: win.startMarkedEquity == null ? null : r(num(win.startMarkedEquity)),
    equity: r(equityNow), equityChangeSol: r(change),
    realisedSol: r(realised), unrealisedSol: openNow ? r(unrealised) : null,
    markedEquity: openNow ? r(equityNow + unrealised) : null, markedChangeSol: openNow ? r(change + unrealised) : null,
    residualSol: r(change - realised), reconciled: Math.abs(change - realised) < 1e-6 * 50,
    costPctRoundTrip: costPct, rows: list, byStrategy: Object.values(byStrategy).sort((a, b) => a.totalSol - b.totalSol),
    tradesCounted: list.reduce((a, x) => a + x.trades, 0), at: new Date(now || Date.now()).toISOString()
  };
}

// Full report for the live state. epochs: current scoreboard + state.scoreboardHistory (closed epochs).
function report(state, config, opts) {
  opts = opts || {};
  const costPct = config.costRoundtripPct || 1.1;
  const file = readTradesFile(opts.tradesFile);
  const mem = (state.trades || []).concat((state.books && state.books.trades) || []);
  const trades = mergeTrades(file.trades, mem);
  const sb = state.scoreboard || {};
  const hist = state.scoreboardHistory || [];
  const pick = opts.epoch && opts.epoch !== sb.epoch ? hist.find(h => h.epoch === opts.epoch) : null;
  const win = pick || { epoch: sb.epoch, since: sb.since, startEquity: sb.startEquity, startBalance: sb.startBalance, startMarkedEquity: sb.startMarkedEquity };
  if (!win.since) return { error: 'no scoreboard start', epochs: hist.map(h => h.epoch).concat(sb.epoch ? [sb.epoch] : []) };
  const out = reconcile({ trades, openBook: (state.books && state.books.open) || [], openLegacy: state.openPositions || [], balance: state.balance, win, costPct, now: opts.now });
  out.source = { tradesJsonl: file.ok, tradesJsonlCount: file.trades.length, inMemory: mem.length, merged: trades.length, error: file.error || null };
  out.epochs = hist.map(h => ({ epoch: h.epoch, since: h.since, until: h.until, startEquity: h.startEquity, endEquity: h.endEquity })).concat(sb.epoch ? [{ epoch: sb.epoch, since: sb.since, until: null, startEquity: sb.startEquity }] : []);
  return out;
}

module.exports = { reconcile, report, readTradesFile, mergeTrades, unrealisedOf, compact };
