// Shadow mode for disabled strategies: would-be entries are logged (mint, pair, price, Jupiter
// quote) and tracked on paper with the strategy's own exit rules (TP / SL / trail / time), using the
// depth fill model. Never touches the real balance or the real open-position slots.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const fillModel = require('./fillModel');
const { decide, legPnlSol } = require('./sellAgent');

const DATA_DIR = process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : './data';
const SHADOW_FILE = process.env.SHADOW_FILE || path.join(DATA_DIR, 'shadow.jsonl');

function isShadow(strat) {
  const ops = config.opsFor(strat.id);
  return !ops.enabled && !!ops.shadow;
}
function isDisabled(strat) {
  return !config.opsFor(strat.id).enabled;
}

// Split strategy signals: disabled strategies never reach real entries; shadow ones are tracked.
function splitSignals(signals) {
  const real = [], shadowSigs = [], disabled = [];
  for (const sig of signals) {
    if (!isDisabled(sig.strategy)) real.push(sig);
    else if (isShadow(sig.strategy)) shadowSigs.push(sig);
    else disabled.push(sig);
  }
  return { real, shadow: shadowSigs, disabled };
}

function ensure(state) {
  state.shadow = state.shadow || {};
  const sh = state.shadow;
  sh.open = sh.open || [];
  sh.closed = sh.closed || [];
  sh.rejected = sh.rejected || [];
  sh.cooldowns = sh.cooldowns || {};
  return sh;
}

function append(row) {
  try {
    fs.mkdirSync(path.dirname(SHADOW_FILE), { recursive: true });
    fs.appendFileSync(SHADOW_FILE, JSON.stringify(row) + '\n');
  } catch (e) {
    console.error('shadow append failed', e.message);
  }
}

// Can we open a new shadow position for this strategy/mint?
function canOpen(state, strat, mint, now = Date.now()) {
  const sh = ensure(state);
  if (sh.open.some(p => p.strategyId === strat.id && p.mint === mint)) return false;
  if ((sh.cooldowns[`${strat.id}:${mint}`] || 0) > now) return false;
  const max = config.opsFor(strat.id).maxOpen || strat.maxOpen || config.maxOpen;
  return sh.open.filter(p => p.strategyId === strat.id).length < max;
}

// rec: { strat, sig, q (pair quote), modelFill, entryFill, entryFillSource, quote, sanity, sizeSol, decimals }
function open(state, rec, now = new Date()) {
  const sh = ensure(state);
  const { strat, sig, q } = rec;
  const pos = {
    id: `sh-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    shadow: true,
    configHash: config.strategyHashes[strat.id],
    strategyId: strat.id,
    strategyType: strat.type,
    symbol: sig.symbol,
    mint: sig.mint,
    pairAddress: sig.pairAddress,
    dexId: sig.dexId,
    decimals: rec.decimals,
    entryTime: now.toISOString(),
    entryPrice: q.priceUsd,
    entryLiquidityUsd: q.liquidityUsd,
    entryModelPrice: rec.modelFill.price,
    entryFillPrice: rec.entryFill,
    entryFillSource: rec.entryFillSource,
    entryTxCostSol: rec.modelFill.txCostSol,
    quote: rec.quote,
    sizeSol: rec.sizeSol,
    remainingFrac: 1,
    exit: strat.exit,
    highest: q.priceUsd,
    lastPrice: q.priceUsd,
    legs: []
  };
  sh.open.push(pos);
  const row = { type: 'shadow-entry', time: pos.entryTime, ...pos };
  append(row);
  console.log(`[shadow] ENTRY ${pos.symbol} ${pos.mint} pair=${pos.pairAddress} (${pos.strategyId}) mid=${pos.entryPrice} fill=${Number(pos.entryFillPrice).toPrecision(6)}(${pos.entryFillSource}) jup=${rec.quote && rec.quote.quotedPriceUsd ? Number(rec.quote.quotedPriceUsd).toPrecision(6) : 'n/a'} impact=${rec.quote && rec.quote.priceImpactPct != null ? rec.quote.priceImpactPct.toFixed(2) + '%' : 'n/a'} size=${pos.sizeSol} (no balance change)`);
  return pos;
}

function reject(state, rec) {
  const sh = ensure(state);
  const row = { type: 'shadow-reject', time: new Date().toISOString(), ...rec };
  sh.rejected.unshift(row);
  if (sh.rejected.length > 100) sh.rejected.pop();
  append(row);
}

// quotes: pairAddress -> normalized pair (from getPairsByAddress). Returns closed shadow trades.
function processExits(state, quotes, solUsd, now = Date.now(), rng = Math.random) {
  const sh = ensure(state);
  const closed = [];
  const still = [];
  for (const pos of sh.open) {
    const q = quotes[pos.pairAddress];
    const fresh = !!(q && q.mint === pos.mint && q.priceUsd > 0);
    if (fresh) {
      pos.lastPrice = q.priceUsd;
      if (q.priceUsd > (pos.highest || 0)) pos.highest = q.priceUsd;
    }
    const price = fresh ? q.priceUsd : (pos.lastPrice || pos.entryPrice);
    const d = decide(pos, price, fresh, fresh ? q : null, now);
    if (!d) { still.push(pos); continue; }
    const liq = (q && q.liquidityUsd) || pos.entryLiquidityUsd || 0;
    const valueUsd = pos.sizeSol * d.sellFrac * solUsd * (d.fillPrice / pos.entryFillPrice);
    const fill = fillModel.fillExit({ midPrice: d.fillPrice, valueUsd, liquidityUsd: liq, reason: d.reason, m5Pct: q ? q.priceChange.m5 : 0, rng });
    const pnl = legPnlSol(pos, fill.price, d.sellFrac);
    pos.legs.push({ time: new Date(now).toISOString(), reason: d.reason, sellFrac: d.sellFrac, midPrice: d.fillPrice, fillPrice: fill.price, txCostSol: fill.txCostSol, pnlSol: pnl });
    pos.remainingFrac = Math.max(0, pos.remainingFrac - d.sellFrac);
    if (d.action === 'partial') pos.tp1Done = true;
    if (d.action === 'close' || pos.remainingFrac <= 1e-9) {
      const legPnl = pos.legs.reduce((a, l) => a + l.pnlSol, 0);
      const costs = (pos.entryTxCostSol || 0) + pos.legs.reduce((a, l) => a + l.txCostSol, 0);
      const trade = { ...pos, exitReason: d.reason, exitPrice: d.fillPrice, closedAt: new Date(now).toISOString(), pnlSol: legPnl - costs, pnlPct: ((legPnl - costs) / pos.sizeSol) * 100 };
      sh.closed.unshift(trade);
      if (sh.closed.length > 200) sh.closed.pop();
      const strat = config.strategies.find(s => s.id === pos.strategyId) || {};
      sh.cooldowns[`${pos.strategyId}:${pos.mint}`] = now + (strat.reentryCooldownMinutes || config.reentryCooldownMinutes || 10) * 60000;
      append({ type: 'shadow-exit', time: trade.closedAt, ...trade });
      console.log(`[shadow] EXIT ${pos.symbol} ${pos.mint} (${pos.strategyId}) ${d.reason} hypothetical pnl=${trade.pnlSol.toFixed(4)} SOL`);
      closed.push(trade);
    } else {
      still.push(pos);
    }
  }
  sh.open = still;
  for (const [k, until] of Object.entries(sh.cooldowns)) if (until <= now) delete sh.cooldowns[k];
  return closed;
}

function summary(state) {
  const sh = ensure(state);
  const out = {};
  for (const s of config.strategies.filter(isShadow)) out[s.id] = { trades: 0, wins: 0, pnlSol: 0, open: 0, rejected: 0 };
  for (const t of sh.closed) {
    const s = out[t.strategyId] || (out[t.strategyId] = { trades: 0, wins: 0, pnlSol: 0, open: 0, rejected: 0 });
    s.trades++; if (t.pnlSol > 0) s.wins++; s.pnlSol += t.pnlSol;
  }
  for (const p of sh.open) if (out[p.strategyId]) out[p.strategyId].open++;
  for (const r of sh.rejected) if (out[r.strategyId]) out[r.strategyId].rejected++;
  return out;
}

module.exports = { splitSignals, isShadow, isDisabled, ensure, canOpen, open, reject, processExits, summary, SHADOW_FILE };
