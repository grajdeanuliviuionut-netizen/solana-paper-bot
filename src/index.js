// Redact secrets from every log line before anything else runs.
require('./live/redact').installConsoleRedaction();
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade, readTrades } = require('./logger');
const { getCandidatePairs, getPairsByAddress } = require('./dataFetcher');
const { generateSignals } = require('./buyAgent');
const { decide, legPnlSol, judgeExit, isProfitReason, awaitQuoteGate } = require('./sellAgent');
const fillModel = require('./fillModel');
const { fillGapPct } = fillModel;
const { equityOf, slotStatus, orderCandidates, formatSkips, maxOpenFor, pickBumpVictim, ownSlotBlocked } = require('./slots');
const quoteSanity = require('./quoteSanity');
const shadow = require('./shadow');
const jup = require('./jupiterQuote');
const rugGate = require('./rugGate');
const memory = require('./marketMemory');
const rej = require('./rejections');
const denylist = require('./denylist');
const { initLive } = require('./live/executor');

// Never let one bad promise or exception kill the process / scan loop.
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.stack || err));
process.on('uncaughtException', err => { console.error('[uncaughtException] exiting so Railway restarts', err && err.stack || err); process.exit(1); });

// Persisted across restarts and deploys (Railway volume at /app/data); a new buildId keeps balance + open positions.
let state = loadState(config.startingSol, config.buildId);
state.cooldowns = state.cooldowns || {};
state.guards = state.guards || {};
// Live-mode risk state survives restarts AND build resets (kill switch stays on until cleared).
const liveStateFile = require('path').join(require('path').dirname(config.stateFile), 'live-state.json');
function loadLiveState() {
  try { return JSON.parse(fs.readFileSync(liveStateFile, 'utf8')); } catch (e) { return { day: null, dayPnlSol: 0, consecLosses: 0, killed: false, txLog: [] }; }
}
function saveLiveState() {
  try { fs.writeFileSync(liveStateFile, JSON.stringify(liveState, null, 2)); } catch (e) { console.error('live state save failed', e.message); }
}
const liveState = loadLiveState();
let liveExec = null;
let liveStatus = { mode: 'paper', reasons: ['not initialised'] };
saveState(state);
console.log(`Boot build=${config.buildId} balance=${state.balance.toFixed(4)} open=${state.openPositions.length} hashes=${JSON.stringify(config.strategyHashes)}`);

const app = express();
app.use(express.json({ limit: '10kb' }));
let lastScanSummary = 'none yet';
let tickRunning = false;
let tickCount = 0;
const MAX_RUG_CHECKS_PER_TICK = parseInt(process.env.MAX_RUG_CHECKS_PER_TICK || '8', 10);

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortAddr(a) {
  return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
}
function addActivity(msg) {
  state.activity.unshift({ time: new Date().toISOString(), msg });
  if (state.activity.length > 50) state.activity.pop();
}
function strategyById(id) {
  return config.strategies.find(s => s.id === id);
}
function equitySol() {
  return state.balance + state.openPositions.reduce((a, p) => a + p.sizeSol * (p.remainingFrac == null ? 1 : p.remainingFrac), 0);
}
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}
function guardFor(id) {
  const g = state.guards[id] || (state.guards[id] = { consecLosses: 0, pausedUntil: 0, day: dayKey(), dayPnlSol: 0 });
  if (g.day !== dayKey()) { g.day = dayKey(); g.dayPnlSol = 0; }
  return g;
}
function strategyBlocked(strat) {
  const rg = strat.riskGuards;
  if (!rg) return null;
  const g = guardFor(strat.id);
  if (g.pausedUntil > Date.now()) return 'paused-consecutive-losses';
  if (rg.dailyLossHaltPct && g.dayPnlSol <= -(config.startingSol * rg.dailyLossHaltPct / 100)) return 'daily-loss-halt';
  return null;
}
function shadowSummary(sq, modelledPriceUsd) {
  if (!sq) return null;
  return {
    ok: !!sq.ok, noRoute: !!sq.noRoute, error: sq.error || null,
    quotedPriceUsd: sq.quotedPriceUsd || null, modelledPriceUsd,
    deltaPct: sq.quotedPriceUsd && modelledPriceUsd ? ((sq.quotedPriceUsd - modelledPriceUsd) / modelledPriceUsd) * 100 : null,
    priceImpactPct: sq.priceImpactPct != null ? sq.priceImpactPct : null,
    route: sq.routeLabels || null, ms: sq.ms
  };
}

function canOpenGlobal() {
  if (equityOf(state) < config.fullStopBalance) return false; // equity, not cash (see src/slots.js)
  if (state.openPositions.length >= maxOpenFor(state, config)) return false;
  return true;
}

// ---- LIVE path (off by default). Every live swap goes through the same quote sanity rules as paper:
// a buy or sell whose fresh Jupiter quote fails sanity is refused (position/entry skipped and retried
// later), except emergency sells, which proceed and log the override.
function isEmergencyReason(reason) { return /^emergency/.test(String(reason || '')); }

// Sanity check for a live SELL quote (raw Jupiter quote for `raw` tokens of pos.mint).
function liveSellCheck(pos, d, solUsd, q) {
  return async quote => {
    const decimals = pos.decimals;
    const tokens = jup.fromRaw(quote.inAmount, decimals);
    const quotedPriceUsd = tokens > 0 ? (jup.fromRaw(quote.outAmount, 9) * solUsd) / tokens : null;
    const liq = (q && q.liquidityUsd) || pos.entryLiquidityUsd || 0;
    const mid = d.fillPrice;
    const model = fillModel.fillExit({ midPrice: mid, valueUsd: tokens * mid, liquidityUsd: liq, reason: 'judge', rng: () => 1 }).price;
    const chk = quoteSanity.checkExit({ sell: { ok: true, priceImpactPct: quote.priceImpactPct }, quotedAdj: quotedPriceUsd, modelPrice: model });
    return { pass: !chk.insane, reasons: chk.reasons, quotedPriceUsd, modelPriceUsd: model };
  };
}

// Sanity check for a live BUY quote: same entry rules as paper (impact, per-strategy gap cap,
// reverse route + impact, round trip) at the LIVE size.
function liveBuyCheck({ strat, sig, q, rug, solUsd }) {
  return async quote => {
    const decimals = rug.facts.decimals;
    const solIn = jup.fromRaw(quote.inAmount, 9);
    const tokens = Number.isInteger(decimals) ? jup.fromRaw(quote.outAmount, decimals) : 0;
    const buy = { ok: true, priceImpactPct: quote.priceImpactPct, quotedPriceUsd: tokens > 0 ? (solIn * solUsd) / tokens : null };
    let reverse = null;
    try { reverse = await jup.sellRawQuote({ mint: sig.mint, raw: quote.outAmount, decimals, solUsd }); } catch (e) { reverse = { ok: false, error: e.message }; }
    const model = fillModel.fillEntry({ midPrice: q.priceUsd, sizeSol: solIn, solUsd, liquidityUsd: q.liquidityUsd }).price;
    const jt = denylist.cachedToken(sig.mint);
    const chk = quoteSanity.checkEntry({ buy, reverse, modelPrice: model, decimals, jupDecimals: jt ? jt.decimals : null, sizeSol: solIn }, config.quoteSanityFor(strat));
    return { pass: chk.pass, reasons: chk.reasons, quotedPriceUsd: buy.quotedPriceUsd, modelPriceUsd: model, roundTripLossPct: chk.roundTripLossPct };
  };
}

async function liveSellLeg(pos, d, q, solUsd) {
  const remaining = pos.remainingFrac == null ? 1 : pos.remainingFrac;
  let raw;
  try {
    const bal = await liveExec.tokenBalanceRaw(pos.mint);
    raw = d.action === 'close' || d.sellFrac >= remaining - 1e-9 ? bal : (bal * BigInt(Math.round((d.sellFrac / remaining) * 1e6))) / 1000000n;
  } catch (e) {
    rej.event('live-balance-failed', { mint: pos.mint, error: e.message });
    return null;
  }
  const emergency = isEmergencyReason(d.reason);
  const r = await liveExec.sell(pos.mint, raw, { check: liveSellCheck(pos, d, solUsd, q), emergency });
  saveLiveState();
  if (!r.ok) {
    pos.exitQuoteFailures = (pos.exitQuoteFailures || 0) + 1;
    rej.event(r.refused ? 'live-sell-refused-quoteSanity' : 'live-sell-failed', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: d.reason, error: r.error });
    return null; // position stays open; retried next check
  }
  const received = r.solDeltaLamports != null ? r.solDeltaLamports : Number(r.quotedOutAmount || 0);
  pos.live.sellSignatures.push(r.signature);
  pos.live.solReceivedLamports += received;
  const spentShare = pos.live.solSpentLamports * d.sellFrac;
  const leg = {
    time: new Date().toISOString(), reason: d.reason, sellFrac: d.sellFrac, midPrice: d.fillPrice, fillSource: 'live',
    signature: r.signature, tokensRaw: raw.toString(), solReceivedLamports: received, pnlSol: (received - spentShare) / 1e9, txCostSol: 0,
    fillPrice: d.fillPrice, sanityOverride: r.sanityOverride || undefined
  };
  pos.legs = pos.legs || [];
  pos.legs.push(leg);
  pos.remainingFrac = Math.max(0, remaining - d.sellFrac);
  return leg;
}

// Returns the booked leg, or null when a take-profit would book a loss (the exit is cancelled and
// re-judged on the next loop).
async function sellLeg(pos, d, q, solUsd) {
  if (pos.live) return liveSellLeg(pos, d, q, solUsd);
  const liq = (q && q.liquidityUsd) || pos.entryLiquidityUsd || 0;
  const valueUsd = pos.sizeSol * d.sellFrac * solUsd * (d.fillPrice / pos.entryFillPrice);
  const fill = fillModel.fillExit({ midPrice: d.fillPrice, valueUsd, liquidityUsd: liq, reason: d.reason, m5Pct: q ? q.priceChange.m5 : 0 });
  const tokens = (pos.tokens || 0) * d.sellFrac; // pos.tokens = tokens bought for the full original size
  const trigger = d.judge && d.judge.source === 'jupiter' ? d.judge : null;
  let sq = null;
  if (trigger) sq = trigger.quote; // the sell quote that triggered the exit (remaining size; no extra call)
  else {
    try {
      sq = await jup.shadowSellQuote({ mint: pos.mint, decimals: pos.decimals, tokens, solUsd });
    } catch (e) { sq = { ok: false, error: e.message }; }
  }
  const shadow = shadowSummary(sq, fill.price);
  if (sq && !sq.ok) {
    pos.exitQuoteFailures = (pos.exitQuoteFailures || 0) + 1;
    rej.event('exit-quote-failed', { source: 'jupiter', mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: d.reason, noRoute: !!sq.noRoute, error: sq.error });
  }
  // Conservative fill: the worse of the depth model and the real Jupiter quote at the same size
  // (quote also gets the stop/failed-exit delay drift).
  // An insane quote (absurd impact/gap, see src/quoteSanity.js) is ignored: model price is used and logged.
  let fillPrice = fill.price, fillSource = 'depth', exitSanity = null;
  if (trigger) {
    // Exit judged on the Jupiter sell quote: book that quote (stops/failed exits still get delay drift).
    fillPrice = trigger.execPrice * (1 - (fill.driftPct || 0) / 100);
    fillSource = 'jupiter-trigger';
  } else if (sq && sq.ok && sq.quotedPriceUsd > 0) {
    const quotedAdj = sq.quotedPriceUsd * (1 - (fill.driftPct || 0) / 100);
    exitSanity = quoteSanity.checkExit({ sell: sq, quotedAdj, modelPrice: fill.price });
    if (exitSanity.insane) {
      fillSource = 'depth-quote-insane';
      rej.event('exit-quote-insane', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: d.reason, reasons: exitSanity.reasons, quotedPriceUsd: sq.quotedPriceUsd, modelPriceUsd: fill.price, priceImpactPct: sq.priceImpactPct });
    } else if (config.fills.useWorseOfQuote && quotedAdj < fillPrice) { fillPrice = quotedAdj; fillSource = 'jupiter'; }
  }
  const gapPct = sq && sq.ok ? fillGapPct('sell', sq.quotedPriceUsd * (1 - (fill.driftPct || 0) / 100), fill.price) : null;
  const pnl = legPnlSol(pos, fillPrice, d.sellFrac);
  // A take-profit never books a loss: if the leg is negative after costs, cancel and re-judge next loop.
  if (isProfitReason(d.reason) && pnl - fill.txCostSol - (pos.entryTxCostSol || 0) * d.sellFrac < 0) {
    rej.event('tp-cancelled', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: d.reason, fillPrice, fillSource, judgedNetPct: d.judge ? +d.judge.netPct.toFixed(2) : null, legPnlSol: +pnl.toFixed(5) });
    return null;
  }
  const leg = {
    time: new Date().toISOString(), reason: d.reason, sellFrac: d.sellFrac, tokens,
    midPrice: d.fillPrice, fillPrice, fillSource, modelPrice: fill.price, impactPct: fill.impactPct, slippagePct: fill.slippagePct,
    feePct: fill.feePct, driftPct: fill.driftPct, stop: fill.stop, failedFirst: fill.failedFirst,
    txCostSol: fill.txCostSol, pnlSol: pnl, fillGapPct: gapPct,
    judgedOn: d.judge ? d.judge.source : 'mid', judgedNetPct: d.judge ? +d.judge.netPct.toFixed(3) : null, quoteSanity: exitSanity && exitSanity.insane ? exitSanity.reasons : undefined, shadow
  };
  if (fill.failedFirst) rej.event('exit-failed-retried', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: d.reason, driftPct: fill.driftPct });
  pos.legs = pos.legs || [];
  pos.legs.push(leg);
  state.balance += pos.sizeSol * d.sellFrac + pnl - fill.txCostSol;
  pos.remainingFrac = Math.max(0, (pos.remainingFrac == null ? 1 : pos.remainingFrac) - d.sellFrac);
  return leg;
}

function finalizeTrade(pos, finalReason, fresh) {
  const legs = pos.legs || [];
  const legPnl = legs.reduce((a, l) => a + l.pnlSol, 0);
  const txCosts = (pos.entryTxCostSol || 0) + legs.reduce((a, l) => a + l.txCostSol, 0);
  const pnl = pos.live
    ? (pos.live.solReceivedLamports - pos.live.solSpentLamports) / 1e9 // actual on-chain SOL in/out (fees included)
    : legPnl - (pos.entryTxCostSol || 0) - legs.reduce((a, l) => a + l.txCostSol, 0);
  const soldFrac = legs.reduce((a, l) => a + l.sellFrac, 0) || 1;
  const last = legs[legs.length - 1] || {};
  const gapLegs = legs.filter(l => l.fillGapPct != null || (l.shadow && l.shadow.ok && l.shadow.deltaPct != null));
  const legGap = l => (l.fillGapPct != null ? l.fillGapPct : -l.shadow.deltaPct);
  const gapFrac = gapLegs.reduce((a, l) => a + l.sellFrac, 0);
  const exitFillGapPct = gapFrac > 0 ? +(gapLegs.reduce((a, l) => a + legGap(l) * l.sellFrac, 0) / gapFrac).toFixed(4) : null;
  const entryFillGapPct = pos.entryFillGapPct != null ? pos.entryFillGapPct
    : (pos.entryShadow && pos.entryShadow.ok && pos.entryShadow.deltaPct != null ? +pos.entryShadow.deltaPct.toFixed(4) : null);
  const trade = {
    id: pos.id,
    build: config.buildId,
    configHash: pos.configHash,
    strategyId: pos.strategyId,
    strategyName: pos.strategyName,
    tier: pos.tier || null,
    symbol: pos.symbol,
    mint: pos.mint,
    pairAddress: pos.pairAddress,
    dexId: pos.dexId || null,
    sizeSol: pos.sizeSol,
    entryPrice: pos.entryPrice,
    entryFillPrice: pos.entryFillPrice,
    entryFillSource: pos.entryFillSource || 'depth',
    entryModelPrice: pos.entryModelPrice,
    entryTime: pos.entryTime,
    entryLiquidityUsd: pos.entryLiquidityUsd || null,
    entryImpactPct: pos.entryImpactPct,
    entryShadow: pos.entryShadow || null,
    entryFillGapPct,
    exitFillGapPct,
    entryGates: pos.entryGates || null,
    priceBeforeExit: pos.prevPrice != null ? { price: pos.prevPrice, at: pos.prevPriceAt, movePct: pos.entryPrice ? +(((pos.prevPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2) : null } : null,
    priceChecks: pos.priceChecks || 0,
    rug: pos.rug || null,
    exitPrice: last.midPrice,
    exitFillPrice: legs.reduce((a, l) => a + l.fillPrice * l.sellFrac, 0) / soldFrac,
    exitTime: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    exitReason: finalReason,
    legs,
    priceFreshAtExit: fresh,
    highest: pos.highest,
    maxLiqDropPct: pos.maxLiqDropPct || 0,
    exitQuoteFailures: pos.exitQuoteFailures || 0,
    pairQuoteFailures: pos.pairQuoteFailures || 0,
    txCostsSol: txCosts,
    pnlSol: pnl,
    pnlPct: (pnl / pos.sizeSol) * 100,
    // MFE / MAE on the judged (sell-quote, net of costs) PnL while open.
    mfeNetPct: pos.judgedHigh ? +((pos.judgedHigh / pos.entryPrice - 1) * 100).toFixed(2) : null,
    maeNetPct: pos.judgedLow ? +((pos.judgedLow / pos.entryPrice - 1) * 100).toFixed(2) : null,
    heldSec: Math.round((Date.now() - Date.parse(pos.entryTime)) / 1000),
    fillModel: pos.live ? 'live' : 'depth-v1',
    mode: pos.live ? 'live' : 'paper',
    live: pos.live || null
  };
  if (pos.live && liveExec) { liveExec.recordResult(pnl); saveLiveState(); }
  state.trades.unshift(trade);
  if (state.trades.length > 100) state.trades.pop();
  logTrade(trade);
  state.cooldowns[pos.mint] = Date.now() + ((strategyById(pos.strategyId) || {}).reentryCooldownMinutes || config.reentryCooldownMinutes) * 60000;
  const g = guardFor(pos.strategyId);
  g.dayPnlSol += pnl;
  if (finalReason !== 'bumped') g.consecLosses = pnl < 0 ? g.consecLosses + 1 : 0; // a bump is an allocator decision, not a strategy loss streak
  const rg = (strategyById(pos.strategyId) || {}).riskGuards;
  if (rg && g.consecLosses >= rg.consecutiveLosses) {
    g.pausedUntil = Date.now() + rg.pauseMinutes * 60000;
    g.consecLosses = 0;
    rej.event('strategy-paused', { strategyId: pos.strategyId, minutes: rg.pauseMinutes });
  }
  const line = `EXIT ${pos.symbol} ${pos.mint} (${pos.strategyId}) ${finalReason} pnl=${pnl.toFixed(4)} SOL`;
  addActivity(line);
  console.log(`[trade] ${line}`);
  return trade;
}

// ---- Exit judging on Jupiter sell quotes (strategy exit.judgeOn = 'sell-quote').
const exitQuoteCache = new Map(); // position id -> { at, sq, remainingFrac }
const judgeFallbackLogged = new Map(); // position id -> ts of last fallback log
// First real sell quote per position in this process (the cache is empty after a restart).
const quoteWait = new Map(); // position id -> { since, got, expiredLogged, heldLogged }
function judgesOnQuote(pos) {
  const strat = strategyById(pos.strategyId);
  return ((strat && strat.exit && strat.exit.judgeOn) || (pos.exit && pos.exit.judgeOn)) === 'sell-quote';
}
async function judgeOnQuote(pos, q, mid, solUsd, budget) {
  const now = Date.now();
  const frac = pos.remainingFrac == null ? 1 : pos.remainingFrac;
  let c = exitQuoteCache.get(pos.id);
  if (c && c.remainingFrac !== frac) c = null; // size changed (partial TP): re-quote
  const stale = !c || now - c.at >= config.exitQuotes.ttlMs;
  if (stale && budget.allowed.has(pos.id) && pos.tokens > 0 && Number.isInteger(pos.decimals)) {
    budget.allowed.delete(pos.id);
    let sq;
    try { sq = await jup.shadowSellQuote({ mint: pos.mint, decimals: pos.decimals, tokens: pos.tokens * frac, solUsd }); } catch (e) { sq = { ok: false, error: e.message }; }
    c = { at: now, sq, remainingFrac: frac };
    exitQuoteCache.set(pos.id, c);
  }
  let quote = c && now - c.at <= config.exitQuotes.maxAgeMs ? c.sq : null;
  let why = !c ? 'no-quote-yet' : !quote ? 'quote-too-old' : !quote.ok ? (quote.noRoute ? 'no-route' : `quote-failed ${quote.error || ''}`.trim()) : null;
  if (quote && quote.ok) {
    // Same sanity bounds as the fill path: an absurd quote is not used for judging either.
    const liq = (q && q.liquidityUsd) || pos.entryLiquidityUsd || 0;
    const model = fillModel.fillExit({ midPrice: mid, valueUsd: pos.sizeSol * frac * solUsd * (mid / pos.entryFillPrice), liquidityUsd: liq, reason: 'judge', rng: () => 1 }).price;
    const chk = quoteSanity.checkExit({ sell: quote, quotedAdj: quote.quotedPriceUsd, modelPrice: model });
    if (chk.insane) { why = `quote-insane ${chk.reasons.join(',')}`; quote = null; }
  } else quote = null;
  let w = quoteWait.get(pos.id);
  if (!w) { w = { since: now, got: false }; quoteWait.set(pos.id, w); }
  if (quote) w.got = true;
  const waiting = !w.got && now - w.since < config.exitQuotes.firstQuoteWaitMs;
  if (!w.got && !waiting && !w.expiredLogged) {
    w.expiredLogged = true;
    rej.event('exit-quote-wait-expired', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, why, waitedMs: now - w.since, note: 'no sell quote yet, judging on the model price' });
  }
  const judge = judgeExit(pos, { quote, midPrice: mid, liquidityUsd: q ? q.liquidityUsd : null, solUsd });
  if (judge) { judge.quote = quote; judge.waitingForQuote = waiting; judge.why = why; }
  if (judge && judge.source === 'model' && now - (judgeFallbackLogged.get(pos.id) || 0) > 5 * 60000) {
    judgeFallbackLogged.set(pos.id, now);
    rej.event('exit-judge-fallback', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, why, mid, modelExecPrice: judge.execPrice, netPct: +judge.netPct.toFixed(2) });
  }
  return judge;
}

async function processExits(solUsd) {
  const sh = shadow.ensure(state);
  if (!state.openPositions.length && !sh.open.length) return 0;
  // Exit pricing always uses the pair pinned at entry, quoted directly by pairAddress.
  let quotes = {};
  try {
    quotes = await getPairsByAddress(state.openPositions.map(p => p.pairAddress).concat(sh.open.map(p => p.pairAddress)));
  } catch (e) {
    console.error('[exit] quote fetch failed', e.message);
  }
  try { shadow.processExits(state, quotes, solUsd); } catch (e) { console.error('[shadow] exit error', e.message); }
  // Jupiter sell quotes for exit judging: at most maxPerLoop calls, stalest positions first.
  const quoteAt = id => (exitQuoteCache.get(id) || {}).at || 0;
  const quoteBudget = { allowed: new Set(state.openPositions.filter(judgesOnQuote)
    .filter(p => Date.now() - quoteAt(p.id) >= config.exitQuotes.ttlMs)
    .sort((a, b) => quoteAt(a.id) - quoteAt(b.id)).slice(0, config.exitQuotes.maxPerLoop).map(p => p.id)) };
  let exits = 0;
  const stillOpen = [];
  for (const pos of state.openPositions) {
    try {
      const q = quotes[pos.pairAddress];
      const fresh = !!(q && q.mint === pos.mint && q.priceUsd > 0);
      if (fresh) {
        // Keep the previous check so a stop's overshoot can be split into "gap between polls" vs fill costs.
        pos.prevPrice = pos.lastPrice; pos.prevPriceAt = pos.lastPriceAt;
        pos.priceChecks = (pos.priceChecks || 0) + 1;
        pos.lastPrice = q.priceUsd;
        pos.lastPriceAt = new Date().toISOString();
        if (q.priceUsd > (pos.highest || 0)) pos.highest = q.priceUsd;
        if (pos.entryLiquidityUsd > 0) {
          const drop = ((pos.entryLiquidityUsd - q.liquidityUsd) / pos.entryLiquidityUsd) * 100;
          if (drop > (pos.maxLiqDropPct || 0)) pos.maxLiqDropPct = drop;
          if (drop > config.liqDropAlertPct && !pos.liqDropLogged) {
            pos.liqDropLogged = true;
            rej.event('liquidity-drop', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, entryLiquidityUsd: pos.entryLiquidityUsd, nowLiquidityUsd: q.liquidityUsd, dropPct: +drop.toFixed(1) });
          }
        }
      } else {
        pos.pairQuoteFailures = (pos.pairQuoteFailures || 0) + 1;
        rej.event('exit-quote-failed', { source: 'dexscreener-pair', mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, failures: pos.pairQuoteFailures });
      }
      const mid = fresh ? q.priceUsd : (pos.lastPrice || pos.entryPrice);
      let price = mid, judgeFresh = fresh, judge = null;
      if (judgesOnQuote(pos)) {
        judge = await judgeOnQuote(pos, fresh ? q : null, mid, solUsd, quoteBudget);
        if (judge) {
          price = judge.price;
          judgeFresh = fresh || judge.source === 'jupiter';
          if (judgeFresh) { pos.judgedHigh = Math.max(pos.judgedHigh || 0, price); pos.judgedLow = Math.min(pos.judgedLow || price, price); }
          pos.lastJudge = { at: new Date().toISOString(), source: judge.source, netPct: +judge.netPct.toFixed(3), execPrice: judge.execPrice, mid };
        }
      }
      let d = decide(pos, price, judgeFresh, fresh ? q : null);
      if (judge && judge.waitingForQuote) {
        // No real sell quote yet since boot: SL/trail/TP/time wait for one (max firstQuoteWaitMs);
        // a hard stop or an emergency exit may still fire on the model price (logged).
        const g = awaitQuoteGate(pos, d, judge, { waiting: true, hardStopPct: config.entryGrace.hardStopPct });
        const w = quoteWait.get(pos.id) || {};
        if (g.held && w.heldLogged !== g.held) {
          w.heldLogged = g.held;
          rej.event('exit-held-awaiting-quote', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, heldReason: g.held, modelNetPct: +judge.netPct.toFixed(2), why: judge.why, waitedMs: Date.now() - (w.since || Date.now()) });
        }
        if (g.modelExit) rej.event('exit-on-model-awaiting-quote', { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: g.d.reason, modelNetPct: +judge.netPct.toFixed(2), why: judge.why });
        d = g.d;
      }
      if (d) { d.judge = judge; d.judgedPrice = d.fillPrice; d.fillPrice = mid; }

      // NCS emergency: RugCheck flips (authority re-enabled / danger). Cached 5 min.
      if (!d && pos.strategyType === 'ncs' && fresh) {
        const strat = strategyById(pos.strategyId);
        const rc = await rugGate.checkToken({ mint: pos.mint, symbol: pos.symbol, pairAddress: pos.pairAddress, dexLiquidityUsd: q.liquidityUsd, extra: strat && strat.extraRug });
        if (rc.reasons.some(r => /mint-authority|freeze-authority|rugcheck-danger|rugged/.test(r))) {
          d = { action: 'close', reason: 'emergency-rug', sellFrac: pos.remainingFrac == null ? 1 : pos.remainingFrac, fillPrice: mid };
        }
      }
      if (!d) { stillOpen.push(pos); continue; }
      if (pos.live && !liveExec) { stillOpen.push(pos); rej.event('live-position-no-executor', { mint: pos.mint }); continue; }
      const leg = await sellLeg(pos, d, fresh ? q : null, solUsd);
      if (!leg) { stillOpen.push(pos); continue; }
      if (d.action === 'partial') {
        pos.tp1Done = true;
        addActivity(`PARTIAL ${pos.symbol} (${pos.strategyId}) ${d.reason} ${Math.round(d.sellFrac * 100)}%`);
        console.log(`[trade] PARTIAL ${pos.symbol} ${pos.mint} (${pos.strategyId}) ${d.reason}`);
      }
      if (d.action === 'close' || pos.remainingFrac <= 1e-9) {
        finalizeTrade(pos, d.reason, fresh);
        exits++;
      } else {
        stillOpen.push(pos);
      }
    } catch (e) {
      console.error('[exit] position error', pos && pos.mint, e.stack || e.message);
      stillOpen.push(pos);
    }
  }
  state.openPositions = stillOpen;
  for (const id of exitQuoteCache.keys()) if (!stillOpen.some(p => p.id === id)) { exitQuoteCache.delete(id); judgeFallbackLogged.delete(id); }
  for (const id of quoteWait.keys()) if (!stillOpen.some(p => p.id === id)) quoteWait.delete(id);
  return exits;
}

// Per-tick record of signals that passed but were skipped (shown in the scan line).
let tickSkips = [];
function noteSkip(rec, opts) {
  tickSkips.push(rec);
  rej.skip(rec, opts);
}

// Model fill + Jupiter buy quote + reverse (token -> SOL) quote at the expected size, then the
// quote-sanity rules. Worse-of only ever sees a quote that passed sanity.
async function quoteAndCheck({ sig, q, rug, sizeSol, solUsd, strat }) {
  const qsCfg = config.quoteSanityFor(strat || sig.strategy);
  const decimals = rug.facts.decimals;
  const jupTok = denylist.cachedToken(sig.mint);
  const fill = fillModel.fillEntry({ midPrice: q.priceUsd, sizeSol, solUsd, liquidityUsd: q.liquidityUsd });
  let sq = null, rev = null;
  try {
    sq = await jup.shadowBuyQuote({ mint: sig.mint, decimals, sizeSol, solUsd });
  } catch (e) { sq = { ok: false, error: e.message }; }
  if (sq && sq.ok && (qsCfg.requireReverseRoute || qsCfg.maxRoundTripLossPct != null)) {
    try {
      rev = await jup.sellRawQuote({ mint: sig.mint, raw: sq.rawOut, decimals, solUsd });
    } catch (e) { rev = { ok: false, error: e.message }; }
  }
  const sanity = quoteSanity.checkEntry({ buy: sq, reverse: rev, modelPrice: fill.price, decimals, jupDecimals: jupTok ? jupTok.decimals : null, sizeSol }, qsCfg);
  const entryShadow = shadowSummary(sq, fill.price);
  if (entryShadow) {
    entryShadow.reverse = rev ? { ok: !!rev.ok, noRoute: !!rev.noRoute, error: rev.error || null, priceImpactPct: rev.priceImpactPct != null ? rev.priceImpactPct : null, quotedPriceUsd: rev.quotedPriceUsd || null } : null;
    entryShadow.sanity = { pass: sanity.pass, reasons: sanity.reasons, maxQuoteGapPct: qsCfg.maxQuoteGapPct, roundTripLossPct: sanity.roundTripLossPct != null ? +sanity.roundTripLossPct.toFixed(3) : null };
  }
  const entryFillGapPct = sq && sq.ok ? fillGapPct('buy', sq.quotedPriceUsd, fill.price) : null;
  let entryFill = fill.price, entryFillSource = 'depth';
  if (sanity.pass && config.fills.useWorseOfQuote && sq.quotedPriceUsd > entryFill) { entryFill = sq.quotedPriceUsd; entryFillSource = 'jupiter'; }
  return { fill, sq, rev, sanity, entryShadow, entryFillGapPct, entryFill, entryFillSource, decimals };
}

function sizeFor(strat, sig, q, solUsd) {
  let sizeSol = strat.sizeSol || config.positionSizeSol;
  if (strat.sizing) {
    const openForStrat = state.openPositions.filter(p => p.strategyId === strat.id);
    const eq = equitySol();
    sizeSol = eq * (strat.sizing.basePctOfEquity / 100) * (sig.sizeMult || 1);
    sizeSol = Math.min(sizeSol, (q.liquidityUsd * strat.sizing.maxPctOfPoolLiquidity / 100) / solUsd);
    const exposure = openForStrat.reduce((a, p) => a + p.sizeSol * (p.remainingFrac == null ? 1 : p.remainingFrac), 0);
    const room = eq * (strat.sizing.maxTotalExposurePct / 100) - exposure;
    sizeSol = Math.min(sizeSol, room);
    if (!(sizeSol >= 0.01)) return null;
  }
  return +sizeSol.toFixed(4);
}

function quoteSanitySkip(strat, sig, q, qc) {
  const rec = {
    strategyId: strat.id, reason: quoteSanity.reasonLabel(qc.sanity.reasons), detail: qc.sanity.reasons.join('; '), mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol,
    midPriceUsd: q.priceUsd, modelPriceUsd: qc.fill.price, quotedPriceUsd: qc.sq && qc.sq.quotedPriceUsd || null,
    priceImpactPct: qc.sq && qc.sq.priceImpactPct != null ? qc.sq.priceImpactPct : null, gapPct: qc.sanity.gapPct,
    reverseOk: qc.rev ? !!qc.rev.ok : null, roundTripLossPct: qc.sanity.roundTripLossPct, shadow: shadow.isShadow(strat) || undefined
  };
  noteSkip(rec);
  console.log(`[${rec.reason}] REJECT ${sig.symbol} ${sig.mint} pair=${sig.pairAddress} (${strat.id}${rec.shadow ? ' shadow' : ''}) ${rec.detail} mid=${q.priceUsd} model=${qc.fill.price.toPrecision(6)} jup=${rec.quotedPriceUsd ? Number(rec.quotedPriceUsd).toPrecision(6) : 'n/a'}`);
  return rec;
}

// Shadow strategies (disabled): log would-be entries and track them on paper. Uses whatever
// RugCheck budget the real entries left this tick (RugCheck/Jupiter results are cached).
async function processShadowEntries(signals, quotes, solUsd, budget) {
  let opened = 0, checks = 0;
  for (const sig of signals) {
    if (opened >= 3 || checks >= budget) break;
    const strat = sig.strategy;
    if (!shadow.canOpen(state, strat, sig.mint)) continue;
    if ((shadowRugFail.get(sig.mint) || 0) > Date.now()) continue; // failed the rug gate recently
    const q = quotes[sig.pairAddress];
    if (!q || q.mint !== sig.mint || !(q.priceUsd > 0)) continue;
    const eq = await denylist.check({ mint: sig.mint, symbol: sig.symbol, name: sig.name });
    if (eq) { noteSkip({ strategyId: strat.id, reason: denylist.REASON, detail: eq, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol }); continue; }
    checks++;
    const rug = await rugGate.checkToken({ mint: sig.mint, symbol: sig.symbol, name: sig.name, pairAddress: sig.pairAddress, dexLiquidityUsd: q.liquidityUsd, extra: null });
    if (!rug.pass) {
      rej.count(strat.id, 'rug:' + String(rug.reasons[0] || 'unknown').split(' ')[0]);
      shadowRugFail.set(sig.mint, Date.now() + 10 * 60 * 1000);
      if (shadowRugFail.size > 5000) shadowRugFail.clear();
      continue;
    }
    const sizeSol = sizeFor(strat, sig, q, solUsd);
    if (!sizeSol) continue;
    const qc = await quoteAndCheck({ sig, q, rug, sizeSol, solUsd, strat });
    if (!qc.sanity.pass) {
      const rec = quoteSanitySkip(strat, sig, q, qc);
      shadow.reject(state, rec);
      continue;
    }
    shadow.open(state, {
      strat, sig, q, modelFill: qc.fill, entryFill: qc.entryFill, entryFillSource: qc.entryFillSource, sizeSol, decimals: qc.decimals,
      quote: { quotedPriceUsd: qc.sq.quotedPriceUsd, priceImpactPct: qc.sq.priceImpactPct, route: qc.sq.routeLabels, gapPct: qc.entryFillGapPct, reverseImpactPct: qc.sanity.reverseImpactPct }
    });
    tickShadowOpened.push(`${strat.id}:${sig.mint}(${sig.symbol})`);
    opened++;
  }
  return opened;
}

let tickShadowOpened = [];
const shadowRugFail = new Map(); // mint -> retry-after ts (shadow path only)

// Close `pos` (a weaker aggressive-flow position) at a fresh Jupiter sell quote to free a slot for
// `forStrat` (momentum-entry). Exit reason 'bumped'. Returns true when the slot was freed.
async function bumpPosition(pos, solUsd, forStrat, sig) {
  let q = null;
  try { q = (await getPairsByAddress([pos.pairAddress]))[pos.pairAddress]; } catch (e) { q = null; }
  const fresh = !!(q && q.mint === pos.mint && q.priceUsd > 0);
  const mid = fresh ? q.priceUsd : (pos.lastPrice || pos.entryPrice);
  exitQuoteCache.delete(pos.id); // always a fresh sell quote at the position's size
  const judge = await judgeOnQuote(pos, fresh ? q : null, mid, solUsd, { allowed: new Set([pos.id]) });
  const base = { mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, symbol: pos.symbol, forStrategyId: forStrat.id, forMint: sig.mint, forSymbol: sig.symbol };
  if (!judge || judge.source !== 'jupiter') {
    rej.event('bump-skipped', { ...base, why: judge ? (judge.why || 'model-only') : 'no-price' });
    return false;
  }
  const d = { action: 'close', reason: 'bumped', sellFrac: pos.remainingFrac == null ? 1 : pos.remainingFrac, fillPrice: mid, judge, judgedPrice: judge.price };
  pos.bumping = true;
  let leg = null;
  try { leg = await sellLeg(pos, d, fresh ? q : null, solUsd); } finally { pos.bumping = false; }
  if (!leg) { rej.event('bump-skipped', { ...base, why: 'sell-failed' }); return false; }
  const trade = finalizeTrade(pos, 'bumped', fresh);
  state.openPositions = state.openPositions.filter(p => p !== pos);
  exitQuoteCache.delete(pos.id); judgeFallbackLogged.delete(pos.id); quoteWait.delete(pos.id);
  rej.event('bumped', { ...base, judgedNetPct: +judge.netPct.toFixed(2), pnlSol: trade ? +trade.pnlSol.toFixed(5) : null, heldSec: Math.round((Date.now() - Date.parse(pos.entryTime)) / 1000) });
  console.log(`[trade] BUMP ${pos.symbol} (${pos.strategyId}) for ${sig.symbol} (${forStrat.id}) net=${judge.netPct.toFixed(2)}%`);
  return true;
}

async function processEntries(signals, solUsd) {
  let entries = 0, rugChecks = 0, bumps = 0;
  const openMints = new Set(state.openPositions.map(p => p.mint));
  for (const [m, until] of Object.entries(state.cooldowns)) if (until <= Date.now()) delete state.cooldowns[m];
  const seen = new Set();
  const candidates = [];
  const shadowSignals = [];
  // Disabled strategies never open real positions; shadow ones are logged + tracked on paper.
  const split = shadow.splitSignals(signals.filter(s => s.mint));
  for (const sig of split.shadow) { shadowSignals.push(sig); rej.count(sig.strategyId, 'disabled-shadow'); }
  for (const sig of split.disabled) rej.count(sig.strategyId, 'disabled');
  // One candidate per mint, claimed in priority order (momentum-entry before aggressive-flow), and a
  // strategy that has no slot of its own (strategy/tier cap or the momentum reserve) doesn't claim the
  // mint: before this, aggressive-flow (first in config order) took every mint both strategies passed
  // and then hit its cap, starving momentum-entry.
  for (const sig of orderCandidates(split.real, config)) {
    if (openMints.has(sig.mint) || seen.has(sig.mint)) continue;
    if (state.cooldowns[sig.mint]) { rej.count(sig.strategyId, 'cooldown'); continue; }
    const blocked = strategyBlocked(sig.strategy);
    if (blocked) { rej.count(sig.strategyId, blocked); continue; }
    if (!ownSlotBlocked(slotStatus(state, sig.strategy, config, sig.tier))) seen.add(sig.mint);
    candidates.push(sig);
  }
  // Free slots go to higher-priority strategies/tiers first (config.strategyOps).
  const ordered = orderCandidates(candidates, config);
  const realSlice = ordered.slice(0, 30);
  const shadowSlice = shadowSignals.filter(sg => (shadowRugFail.get(sg.mint) || 0) <= Date.now() && shadow.canOpen(state, sg.strategy, sg.mint)).slice(0, 10);
  if (!realSlice.length && !shadowSlice.length) return 0;
  const quotes = await getPairsByAddress(realSlice.concat(shadowSlice).map(s => s.pairAddress));
  // Full stop (equity) skips everything; a full book is handled per signal (momentum-entry may bump).
  if (realSlice.length && equityOf(state) < config.fullStopBalance) {
    const st = slotStatus(state, null, config);
    for (const sig of realSlice) noteSkip({ strategyId: sig.strategyId, ...st, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
  } else for (const sig of realSlice) {
    if (entries >= 5) break;
    if (openMints.has(sig.mint)) continue; // another strategy just entered this mint
    const strat = sig.strategy;
    // Signal passed its gates; if no slot is free, log it as a "slot-full skip".
    let slot = slotStatus(state, strat, config, sig.tier);
    let bumpVictim = null;
    if (slot && slot.reason === 'slot-full skip' && slot.scope === 'global' && config.allocator && bumps < config.allocator.bump.maxPerTick) {
      const v = pickBumpVictim(state, config, strat.id);
      // Only if this strategy would have a slot once the victim is gone (its own cap still applies).
      if (v && !slotStatus({ ...state, openPositions: state.openPositions.filter(p => p !== v) }, strat, config, sig.tier)) { bumpVictim = v; slot = null; }
    }
    if (slot) {
      noteSkip({ strategyId: strat.id, ...slot, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
      continue;
    }
    const q = quotes[sig.pairAddress];
    if (!q || q.mint !== sig.mint || !(q.priceUsd > 0)) { rej.count(strat.id, 'entry-quote-missing'); continue; }
    // Tokenized equities (Jupiter tags / issuer). The static denylist already ran in buyAgent.
    const eq = await denylist.check({ mint: sig.mint, symbol: sig.symbol, name: sig.name });
    if (eq) {
      noteSkip({ strategyId: strat.id, reason: denylist.REASON, detail: eq, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
      continue;
    }
    // NCS spec universe.token_first_seen_max_hours: token creation time (Jupiter firstPool/createdAt,
    // fetched by denylist.check above). Unknown age fails closed.
    const maxH = strat.universe && strat.universe.tokenFirstSeenMaxHours;
    if (maxH) {
      const tok = denylist.cachedToken(sig.mint);
      const created = tok && tok.createdAt ? Date.parse(tok.createdAt) : NaN;
      const ageH = Number.isFinite(created) ? (Date.now() - created) / 3600000 : null;
      if (ageH == null || ageH > maxH) {
        const gate = ageH == null ? 'tokenAgeUnknown' : `tokenFirstSeen>${maxH}h`;
        rej.count(strat.id, gate);
        rej.detail({ strategyId: strat.id, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol, gate, value: ageH == null ? null : +ageH.toFixed(2) });
        continue;
      }
      sig.gateInputs = Object.assign({}, sig.gateInputs, { tokenAgeHours: +ageH.toFixed(2) });
    }
    if (rugChecks >= MAX_RUG_CHECKS_PER_TICK) break;
    rugChecks++;
    const rug = await rugGate.checkToken({
      mint: sig.mint, symbol: sig.symbol, name: sig.name, pairAddress: sig.pairAddress,
      dexLiquidityUsd: q.liquidityUsd, extra: strat.type === 'ncs' ? strat.extraRug : null
    });
    if (!rug.pass) {
      const gate = 'rug:' + String(rug.reasons[0] || 'unknown').split(' ')[0];
      rej.count(strat.id, gate);
      rej.detail({ strategyId: strat.id, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol, gate, value: rug.reasons.join('; ') });
      rej.nearMiss({ strategyId: strat.id, gate, reasons: rug.reasons, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol, liquidityUsd: q.liquidityUsd, priceUsd: q.priceUsd });
      continue;
    }
    const sizeSol = sizeFor(strat, sig, q, solUsd);
    if (!sizeSol) { rej.count(strat.id, 'exposure-cap'); continue; }
    const qc = await quoteAndCheck({ sig, q, rug, sizeSol, solUsd, strat });
    const { fill, sq, entryShadow, entryFillGapPct, entryFill, entryFillSource } = qc;
    if (sq && !sq.ok) rej.event('entry-quote-failed', { source: 'jupiter', mint: sig.mint, strategyId: strat.id, noRoute: !!sq.noRoute, error: sq.error });
    // Hard reject: absurd/unroutable quote (see src/quoteSanity.js).
    if (!qc.sanity.pass) { quoteSanitySkip(strat, sig, q, qc); continue; }
    // Valid signal (gates, rug, quote sanity passed) and the book is full: bump the weakest AF position.
    if (bumpVictim) {
      if (!state.openPositions.includes(bumpVictim) || !(await bumpPosition(bumpVictim, solUsd, strat, sig))) {
        noteSkip({ strategyId: strat.id, reason: 'slot-full skip', scope: 'global-bump-failed', open: state.openPositions.length, max: maxOpenFor(state, config), mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
        continue;
      }
      bumps++;
      if (slotStatus(state, strat, config, sig.tier)) { rej.event('bump-no-slot', { strategyId: strat.id, mint: sig.mint }); continue; }
    }
    // LIVE path (off by default): only when live mode is active and this strategy is enabled for live.
    let live = null, liveSize = sizeSol;
    if (liveExec) {
      const block = liveExec.entryBlock(state.openPositions.filter(p => p.live).length, strat.id);
      if (!block) {
        liveSize = Math.min(sizeSol, liveExec.cfg.maxSolPerTrade);
        const r = await liveExec.buy(sig.mint, liveSize, { check: liveBuyCheck({ strat, sig, q, rug, solUsd }) });
        saveLiveState();
        if (!r.ok) {
          if (r.refused) noteSkip({ strategyId: strat.id, reason: quoteSanity.reasonLabel(r.reasons), detail: `live: ${(r.reasons || []).join('; ')}`, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
          rej.event(r.refused ? 'live-buy-refused-quoteSanity' : 'live-buy-failed', { mint: sig.mint, strategyId: strat.id, error: r.error });
          continue;
        }
        const tokensRaw = r.tokenDeltaRaw && BigInt(r.tokenDeltaRaw) > 0n ? r.tokenDeltaRaw : r.quotedOutAmount;
        live = { buySignature: r.signature, tokensRaw, solSpentLamports: r.solDeltaLamports != null ? -r.solDeltaLamports : Math.round(liveSize * 1e9), sellSignatures: [], solReceivedLamports: 0 };
      } else if (liveExec.cfg.liveStrategies.includes(strat.id)) {
        rej.count(strat.id, `live-blocked:${block}`);
      }
    }
    const posSize = live ? liveSize : sizeSol;
    const pos = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      build: config.buildId,
      configHash: config.strategyHashes[strat.id],
      strategyId: strat.id,
      strategyName: strat.name,
      strategyType: strat.type,
      tier: sig.tier,
      symbol: sig.symbol,
      mint: sig.mint,
      pairAddress: sig.pairAddress,
      dexId: sig.dexId,
      decimals: rug.facts.decimals,
      entryLiquidityUsd: q.liquidityUsd,
      entryPrice: q.priceUsd,
      entryFillPrice: entryFill,
      entryFillSource,
      entryModelPrice: fill.price,
      entryImpactPct: fill.impactPct,
      entryTxCostSol: fill.txCostSol,
      entryShadow,
      entryFillGapPct,
      entryGates: sig.gateInputs || null,
      tokens: live && Number.isInteger(rug.facts.decimals) ? jup.fromRaw(live.tokensRaw, rug.facts.decimals) : (posSize * solUsd) / entryFill,
      sizeSol: posSize,
      remainingFrac: 1,
      entryTime: new Date().toISOString(),
      exit: strat.exit,
      highest: q.priceUsd,
      lastPrice: q.priceUsd,
      rug: rug.facts,
      live
    };
    state.openPositions.push(pos);
    if (!live) state.balance -= sizeSol + fill.txCostSol; // live positions don't touch the paper balance
    openMints.add(sig.mint);
    entries++;
    const line = `${live ? 'LIVE ' : ''}ENTRY ${sig.symbol} ${sig.mint} pair=${sig.pairAddress} (${strat.id}${sig.tier ? ' tier ' + sig.tier : ''}) mid=${q.priceUsd} fill=${entryFill.toPrecision(6)}(${entryFillSource}) size=${sizeSol} jup=${entryShadow && entryShadow.quotedPriceUsd ? entryShadow.quotedPriceUsd.toPrecision(6) : 'n/a'} gap=${entryFillGapPct == null ? 'n/a' : entryFillGapPct.toFixed(2) + '%'}`;
    addActivity(line);
    console.log(`[trade] ${line}`);
  }
  if (shadowSlice.length) {
    try { await processShadowEntries(shadowSlice, quotes, solUsd, Math.max(4, MAX_RUG_CHECKS_PER_TICK - rugChecks)); } catch (e) { console.error('[shadow] entry error', e.message); }
  }
  return entries;
}

async function tick() {
  if (tickRunning) {
    console.log('[scan] previous cycle still running, skipping');
    return;
  }
  tickRunning = true;
  tickCount++;
  const t0 = Date.now();
  let pairsCount = 0, discovered = 0, signalsCount = 0, entries = 0, exits = 0;
  let gateLine = '';
  tickSkips = [];
  tickShadowOpened = [];
  try {
    rej.maybeLogHourly();
    const solUsd = await jup.getSolUsd(state.lastSolUsd || null);
    if (!solUsd) throw new Error('no SOL/USD price available');
    state.lastSolUsd = solUsd;

    exits = await processExits(solUsd);

    const { pairs, discoveredMints } = await getCandidatePairs();
    memory.record(pairs);
    pairsCount = pairs.length;
    discovered = discoveredMints;
    addActivity(`Scanned ${pairs.length} pairs (${discoveredMints} mints known, liq >= $${config.scanMinLiquidityUsd})`);

    const { signals, rejections, gateStats } = generateSignals(pairs, { count: rej.count, nearMiss: rej.nearMiss, skip: noteSkip, detail: rej.detail });
    signalsCount = signals.length;
    gateLine = Object.entries(gateStats).map(([id, st]) => {
      const fails = Object.entries(st.fails).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(',');
      const mode = shadow.isShadow(strategyById(id) || { id }) ? '(shadow)' : shadow.isDisabled(strategyById(id) || { id }) ? '(disabled)' : '';
      return `${id}${mode} pass=${st.passed}/${st.scanned} fails{${fails}}`;
    }).join(' | ');
    if (rejections.length) addActivity(`Rejections: ${rejections.slice(0, 2).join(' | ')}`);

    entries = await processEntries(signals, solUsd);
  } catch (e) {
    addActivity(`Tick error: ${e.message}`);
    console.error('[scan] tick error', e && e.stack || e);
  } finally {
    lastScanSummary = `${new Date().toISOString()} pairs=${pairsCount} signals=${signalsCount} entries=${entries} exits=${exits}`;
    const shOpen = shadow.ensure(state).open.length;
    const skipLine = [formatSkips(tickSkips), tickShadowOpened.length || shOpen ? `shadow: opened ${tickShadowOpened.length ? tickShadowOpened.join(', ') : 0} open=${shOpen}` : ''].filter(Boolean).join(' | ');
    console.log(`[scan] #${tickCount} ${Date.now() - t0}ms mints=${discovered} pairs=${pairsCount} signals=${signalsCount} entries=${entries} exits=${exits} open=${state.openPositions.length} bal=${state.balance.toFixed(4)} || ${gateLine}${skipLine ? ' || ' + skipLine : ''}`);
    try { saveState(state); } catch (e) { console.error('[scan] save error', e.message); }
    tickRunning = false;
  }
}

// Fast exit checks for open positions between full scans (NCS spec: recheck every 15s).
let exitChecks = 0, lastExitCheckAt = null;
async function exitTick() {
  if (tickRunning || (!state.openPositions.length && !shadow.ensure(state).open.length)) return;
  tickRunning = true;
  try {
    const solUsd = await jup.getSolUsd(state.lastSolUsd || null);
    if (solUsd) {
      exitChecks++; lastExitCheckAt = new Date().toISOString();
      if (exitChecks % 30 === 1) console.log(`[exit-check] heartbeat #${exitChecks} every ${config.exitCheckMs}ms open=${state.openPositions.length} shadowOpen=${shadow.ensure(state).open.length}`);
      const n = await processExits(solUsd);
      if (n) console.log(`[exit-check] exits=${n} open=${state.openPositions.length} bal=${state.balance.toFixed(4)}`);
    }
  } catch (e) {
    console.error('[exit-check] error', e && e.stack || e);
  } finally {
    try { saveState(state); } catch (e) { /* logged in saveState */ }
    tickRunning = false;
  }
}

const NCS_STOP_RE = /^(sl|emergency)/;
function expectancyOf(list, strategyId) {
  const n = list.length;
  if (!n) return { trades: 0 };
  const isNcs = (strategyById(strategyId) || {}).type === 'ncs';
  const actualSol = list.reduce((a, t) => a + (t.pnlSol || 0), 0) / n;
  const actualPct = list.reduce((a, t) => a + (t.pnlPct || 0), 0) / n;
  const out = { trades: n, winRate: +(list.filter(t => t.pnlSol > 0).length / n).toFixed(3), actualSolPerTrade: +actualSol.toFixed(5), actualPctPerTrade: +actualPct.toFixed(2) };
  if (isNcs) {
    const stops = list.filter(t => NCS_STOP_RE.test(t.exitReason || ''));
    const rp = t => (NCS_STOP_RE.test(t.exitReason || '') ? config.ncsRealisticStopPct : (t.pnlPct || 0));
    const rs = t => (NCS_STOP_RE.test(t.exitReason || '') ? (t.sizeSol || 0) * config.ncsRealisticStopPct / 100 : (t.pnlSol || 0));
    Object.assign(out, {
      stopAssumedPct: config.ncsRealisticStopPct, stops: stops.length,
      actualAvgStopPct: stops.length ? +(stops.reduce((a, t) => a + (t.pnlPct || 0), 0) / stops.length).toFixed(2) : null,
      realisticSolPerTrade: +(list.reduce((a, t) => a + rs(t), 0) / n).toFixed(5),
      realisticPctPerTrade: +(list.reduce((a, t) => a + rp(t), 0) / n).toFixed(2)
    });
  }
  return out;
}

function summarize(trades) {
  const byStrategy = {};
  for (const s of config.strategies) {
    byStrategy[s.id] = { configHash: config.strategyHashes[s.id], trades: 0, wins: 0, pnlSol: 0, best: null, olderHashTrades: 0 };
  }
  for (const t of trades) {
    if (t.mode === 'live') continue; // live trades are reported separately (/api/live)
    const s = byStrategy[t.strategyId] || (byStrategy[t.strategyId] = { configHash: null, trades: 0, wins: 0, pnlSol: 0, best: null, olderHashTrades: 0 });
    // The go-live count resets whenever the strategy's config hash changes.
    if (s.configHash && t.configHash !== s.configHash) { s.olderHashTrades++; continue; }
    s.trades++;
    if (t.pnlSol > 0) s.wins++;
    s.pnlSol += t.pnlSol;
    s.best = s.best == null ? t.pnlSol : Math.max(s.best, t.pnlSol);
  }
  // Expectancy per trade: actual, and "realistic" where NCS stop-outs are re-priced at
  // config.ncsRealisticStopPct (-25%: observed stop fills gap well past the -12% stop).
  const mine = (id, sameHash) => trades.filter(t => t.strategyId === id && (!sameHash || t.configHash === config.strategyHashes[id]));
  for (const [id, s] of Object.entries(byStrategy)) {
    s.expectancy = { currentHash: expectancyOf(mine(id, true), id), session: expectancyOf(mine(id, false), id) };
  }
  for (const s of Object.values(byStrategy)) {
    s.winRate = s.trades ? s.wins / s.trades : 0;
    s.pnlExBestSol = s.trades ? s.pnlSol - s.best : 0;
    s.goLiveProgress = `${s.trades}/${config.goLiveTradeTarget}`;
  }
  return byStrategy;
}

// Trades of the current paper account (since state.startedAt; survives deploys).
function sessionTrades(all) {
  const since = state.startedAt ? Date.parse(state.startedAt) : 0;
  return all.filter(t => Date.parse(t.closedAt || t.exitTime || 0) >= since);
}

// GET /api/trades            -> closed trades of the current paper account (newest first)
// GET /api/trades?all=1      -> every trade in the log, including older accounts/builds
// GET /api/trades?strategy=id
app.get('/api/trades', (req, res) => {
  try {
    const all = readTrades().reverse();
    let trades = req.query.all ? all : sessionTrades(all);
    if (req.query.strategy) trades = trades.filter(t => t.strategyId === req.query.strategy);
    res.json({
      build: config.buildId,
      configHashes: config.strategyHashes,
      since: state.startedAt || null,
      balance: state.balance,
      count: trades.length,
      summary: summarize(sessionTrades(all)),
      strategies: strategyModes(),
      shadow: { summary: shadow.summary(state), open: shadow.ensure(state).open.length, endpoint: '/api/shadow' },
      openPositions: state.openPositions,
      lastScan: lastScanSummary,
      trades
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Near-miss feed: in-memory (newest first) + tail of data/nearmiss.jsonl (survives restarts).
function nearMissFeed(req, res) {
  const limit = Math.min(1000, parseInt(req.query.limit || '200', 10));
  let fileTail = [];
  try {
    const f = rej.snapshot().nearMissFile;
    if (fs.existsSync(f)) {
      const st = fs.statSync(f);
      const len = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      fileTail = buf.toString('utf8').split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
    }
  } catch (e) { /* file optional */ }
  if (req.path.endsWith('.jsonl')) return res.type('text/plain').send(fileTail.slice().reverse().map(r => JSON.stringify(r)).join('\n') + '\n');
  res.json({ build: config.buildId, count: rej.nearMisses.length, nearMisses: rej.nearMisses.slice(0, limit), fromFile: fileTail });
}
app.get(['/api/nearmiss', '/api/nearmisses', '/api/near-misses', '/api/near-miss', '/api/rejections/nearmiss', '/api/rejections/near-misses', '/data/nearmiss.jsonl'], nearMissFeed);

// GET /api/rejections?detail=1 -> last 200 per-mint rejections (mint, strategy, failed gate, value).
app.get('/api/rejections', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  if (req.query.detail === '1' || req.query.detail === 'true') {
    return res.json({ build: config.buildId, count: rej.details.length, rejections: rej.details.slice(0, 200) });
  }
  res.json({ build: config.buildId, ...rej.snapshot(),
    slotFullSkips: rej.skips.filter(k => k.reason === 'slot-full skip').slice(0, limit),
    tokenizedEquity: rej.skips.filter(k => k.reason === denylist.REASON).slice(0, limit),
    quoteSanity: rej.skips.filter(k => String(k.reason).startsWith(quoteSanity.REASON)).slice(0, limit),
    quoteSanityLimits: Object.assign({}, config.quoteSanity, { perStrategy: Object.fromEntries(config.strategies.map(st => [st.id, config.quoteSanityFor(st)])) }),
    nearMisses: rej.nearMisses.slice(0, parseInt(req.query.limit || '100', 10)) });
});

function allocatorStatus() {
  const a = config.allocator;
  const byStrategy = {};
  for (const p of state.openPositions) byStrategy[p.strategyId] = (byStrategy[p.strategyId] || 0) + 1;
  const bumps = state.trades.filter(t => t.exitReason === 'bumped').slice(0, 10).map(t => ({ symbol: t.symbol, strategyId: t.strategyId, pnlSol: +t.pnlSol.toFixed(5), at: t.closedAt }));
  return { maxOpen: maxOpenFor(state, config), baseMaxOpen: a.baseMaxOpen, targetMaxOpen: a.targetMaxOpen, cashBufferSol: a.cashBufferSol,
    reserve: a.reserve, caps: Object.fromEntries(config.strategies.map(s => [s.id, config.opsFor(s.id).maxOpen || s.maxOpen])), open: state.openPositions.length, openByStrategy: byStrategy, recentBumps: bumps };
}

function strategyModes() {
  return Object.fromEntries(config.strategies.map(s => {
    const ops = config.opsFor(s.id);
    return [s.id, { mode: ops.enabled ? 'live-paper' : ops.shadow ? 'shadow' : 'disabled', maxOpen: ops.maxOpen || s.maxOpen || config.maxOpen, priority: ops.priority, tierMaxOpen: ops.tierMaxOpen, tierPriority: ops.tierPriority }];
  }));
}

// GET /api/shadow -> shadow-mode strategies: would-be entries (open), hypothetical exits (closed),
// quote-sanity rejections, per-strategy summary. Never affects balance.
app.get('/api/shadow', (req, res) => {
  const sh = shadow.ensure(state);
  const limit = parseInt(req.query.limit || '100', 10);
  res.json({ build: config.buildId, modes: strategyModes(), summary: shadow.summary(state), open: sh.open, closed: sh.closed.slice(0, limit), rejected: sh.rejected.slice(0, limit), file: shadow.SHADOW_FILE });
});

function tokenOk(given) {
  const want = process.env.KILL_TOKEN;
  if (!want || want.length < 16 || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// POST /api/kill  (Authorization: Bearer <KILL_TOKEN>)  -> stops all new LIVE entries (paper unaffected).
// Without a KILL_TOKEN (>= 16 chars) configured every request is rejected (403).
app.post('/api/kill', (req, res) => {
  const auth = String(req.headers.authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : (req.body && req.body.token);
  if (!tokenOk(given)) {
    const configured = !!(process.env.KILL_TOKEN && process.env.KILL_TOKEN.length >= 16);
    return res.status(403).json({ ok: false, error: 'forbidden', killTokenConfigured: configured });
  }
  liveState.killed = true;
  liveState.killReason = `api:${String((req.body && req.body.reason) || 'manual').slice(0, 80)}`;
  liveState.killedAt = new Date().toISOString();
  saveLiveState();
  console.error(`[live] KILL SWITCH via /api/kill (${liveState.killReason})`);
  res.json({ ok: true, killed: true, killedAt: liveState.killedAt, mode: liveStatus.mode });
});

app.get('/api/live', (req, res) => {
  res.json({
    live: liveStatus.mode === 'live', mode: liveStatus.mode, reasons: liveStatus.reasons, config: liveStatus.config || null,
    publicKey: liveStatus.publicKey || null, walletSolAtStart: liveStatus.walletSol || null,
    killed: !!liveState.killed, killReason: liveState.killReason || null, dayPnlSol: liveState.dayPnlSol || 0,
    consecLosses: liveState.consecLosses || 0, recentTx: (liveState.txLog || []).slice(0, 20),
    openLivePositions: state.openPositions.filter(p => p.live).length,
    killEndpoint: { path: 'POST /api/kill', auth: 'Authorization: Bearer <KILL_TOKEN>', configured: !!(process.env.KILL_TOKEN && process.env.KILL_TOKEN.length >= 16), effect: 'blocks new live entries only (persists in data/live-state.json); paper trading unaffected' }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, build: config.buildId, mode: liveStatus.mode, ticks: tickCount, lastScan: lastScanSummary, lastUpdate: state.lastUpdate, balance: state.balance, openPositions: state.openPositions.length, accountSince: state.startedAt || null, buildHistory: (state.buildHistory || []).slice(-5), configHashes: config.strategyHashes, strategies: strategyModes(), allocator: allocatorStatus(), shadowOpen: shadow.ensure(state).open.length, exitCheck: { everyMs: config.exitCheckMs, runs: exitChecks, last: lastExitCheckAt } });
});

app.get('/', (req, res) => {
  const open = state.openPositions.map(p => `
    <tr>
      <td>${esc(p.symbol)} <a href="https://dexscreener.com/solana/${esc(p.pairAddress)}" style="color:#64748b">${shortAddr(p.mint)}</a></td>
      <td>${esc(p.strategyName)}</td>
      <td>${Number(p.entryPrice).toPrecision(6)}</td>
      <td>${p.sizeSol}</td>
      <td>${new Date(p.entryTime).toLocaleTimeString()}</td>
    </tr>`).join('');

  const closed = state.trades.slice(0, 20).map(t => `
    <tr class="${t.pnlSol >= 0 ? 'win' : 'loss'}">
      <td>${esc(t.symbol)} <a href="https://dexscreener.com/solana/${esc(t.pairAddress)}" style="color:#64748b">${shortAddr(t.mint)}</a></td>
      <td>${esc(t.strategyName)}</td>
      <td>${esc(t.exitReason)}</td>
      <td>${Number(t.pnlSol).toFixed(4)}</td>
      <td>${new Date(t.closedAt).toLocaleTimeString()}</td>
    </tr>`).join('');

  let summary = {};
  try { summary = summarize(sessionTrades(readTrades())); } catch (e) { summary = {}; }
  const stratRows = Object.entries(summary).map(([id, s]) => `
    <tr><td>${esc(id)}</td><td>${esc(s.configHash)}</td><td>${esc(s.goLiveProgress)}</td><td>${(s.winRate * 100).toFixed(0)}%</td>
    <td>${s.pnlSol.toFixed(4)}</td><td>${Number(s.pnlExBestSol).toFixed(4)}</td><td>${esc(shadow.isShadow(strategyById(id) || { id }) ? 'SHADOW (paused)' : strategyBlocked(strategyById(id) || {}) || 'ok')}</td></tr>`).join('');

  const activityHtml = (state.activity || []).slice(0, 30).map(a => `
    <div class="log-line">${new Date(a.time).toLocaleTimeString()} — ${esc(a.msg)}</div>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Paper Trading Dashboard</title>
      <meta http-equiv="refresh" content="30">
      <style>
        body { font-family: system-ui; background: #0f172a; color: #e2e8f0; padding: 20px; }
        h1 { color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #334155; }
        th { background: #1e293b; }
        .win { color: #4ade80; }
        .loss { color: #f87171; }
        .balance { font-size: 2em; color: #38bdf8; }
        .log { background: #1e293b; padding: 12px; border-radius: 8px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.9em; }
        .log-line { margin: 4px 0; border-bottom: 1px solid #334155; padding-bottom: 4px; }
      </style>
    </head>
    <body>
      <h1>Solana Paper Bot <span style="font-size:0.5em;color:${liveStatus.mode === 'live' ? '#f87171' : '#4ade80'}">${esc(liveStatus.mode.toUpperCase())}${liveState.killed ? ' (KILLED)' : ''}</span></h1>
      <div class="balance">Balance: ${state.balance.toFixed(4)} SOL</div>
      <p>Open positions: ${state.openPositions.length} / ${maxOpenFor(state, config)} | Last update: ${new Date(state.lastUpdate).toLocaleString()}</p>
      <p style="color:#64748b">Build ${esc(config.buildId)} | since ${new Date(state.startedAt || state.lastUpdate).toLocaleString()} | last scan: ${esc(lastScanSummary)} | <a href="/api/trades" style="color:#38bdf8">/api/trades</a> | <a href="/api/rejections" style="color:#38bdf8">/api/rejections</a></p>
      <h2>Strategies (go-live count resets on config change)</h2>
      <table>
        <tr><th>Strategy</th><th>Config</th><th>Trades</th><th>Win rate</th><th>PnL (SOL)</th><th>PnL ex best</th><th>Guard</th></tr>
        ${stratRows}
      </table>
      <h2>Open Positions</h2>
      <table>
        <tr><th>Symbol</th><th>Strategy</th><th>Entry</th><th>Size</th><th>Time</th></tr>
        ${open || '<tr><td colspan="5">None</td></tr>'}
      </table>
      <h2>Recent Closed Trades</h2>
      <table>
        <tr><th>Symbol</th><th>Strategy</th><th>Exit</th><th>PnL (SOL)</th><th>Time</th></tr>
        ${closed || '<tr><td colspan="5">None yet</td></tr>'}
      </table>
      <h2>Activity Log</h2>
      <div class="log">
        ${activityHtml || '<div>No activity yet</div>'}
      </div>
      <p style="color:#64748b">Auto-refreshes every 30s. Paper only.</p>
    </body>
    </html>
  `);
});

app.listen(config.port, async () => {
  console.log(`Dashboard running on port ${config.port}`);
  try {
    const r = await initLive({ liveState, strategyIds: config.strategies.map(s => s.id) });
    liveStatus = r.status;
    liveExec = r.executor;
  } catch (e) {
    liveStatus = { mode: 'paper', reasons: [`live init error: ${e.message}`] };
    liveExec = null;
    console.error('[live] init error, staying in PAPER', e.message);
  }
  console.log(`[mode] ${liveStatus.mode.toUpperCase()}${liveStatus.mode === 'paper' ? ' (' + liveStatus.reasons.join('; ') + ')' : ''}`);
  if (state.openPositions.some(p => p.live) && !liveExec) console.error('[live] WARNING: open LIVE positions exist but live mode is off; they will not be sold automatically');
  tick();
  setInterval(() => { tick().catch(e => console.error('[scan] interval error', e)); }, config.pollIntervalMs);
  setInterval(() => { exitTick().catch(e => console.error('[exit-check] interval error', e)); }, config.exitCheckMs);
});
