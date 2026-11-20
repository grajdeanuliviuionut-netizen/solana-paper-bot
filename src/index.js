const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade, readTrades } = require('./logger');
const { getCandidatePairs, getPairsByAddress } = require('./dataFetcher');
const { generateSignals } = require('./buyAgent');
const { decide, legPnlSol } = require('./sellAgent');
const fillModel = require('./fillModel');
const { fillGapPct } = fillModel;
const { slotStatus, formatSkips } = require('./slots');
const jup = require('./jupiterQuote');
const rugGate = require('./rugGate');
const memory = require('./marketMemory');
const rej = require('./rejections');
const denylist = require('./denylist');

// Never let one bad promise or exception kill the process / scan loop.
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.stack || err));
process.on('uncaughtException', err => { console.error('[uncaughtException] exiting so Railway restarts', err && err.stack || err); process.exit(1); });

// Persisted across restarts and deploys (Railway volume at /app/data); a new buildId keeps balance + open positions.
let state = loadState(config.startingSol, config.buildId);
state.cooldowns = state.cooldowns || {};
state.guards = state.guards || {};
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
  if (state.balance < config.fullStopBalance) return false;
  if (state.openPositions.length >= config.maxOpen) return false;
  return true;
}

async function sellLeg(pos, d, q, solUsd) {
  const liq = (q && q.liquidityUsd) || pos.entryLiquidityUsd || 0;
  const valueUsd = pos.sizeSol * d.sellFrac * solUsd * (d.fillPrice / pos.entryFillPrice);
  const fill = fillModel.fillExit({ midPrice: d.fillPrice, valueUsd, liquidityUsd: liq, reason: d.reason, m5Pct: q ? q.priceChange.m5 : 0 });
  const tokens = (pos.tokens || 0) * d.sellFrac; // pos.tokens = tokens bought for the full original size
  let sq = null;
  try {
    sq = await jup.shadowSellQuote({ mint: pos.mint, decimals: pos.decimals, tokens, solUsd });
  } catch (e) { sq = { ok: false, error: e.message }; }
  const shadow = shadowSummary(sq, fill.price);
  if (sq && !sq.ok) {
    pos.exitQuoteFailures = (pos.exitQuoteFailures || 0) + 1;
    rej.event('exit-quote-failed', { source: 'jupiter', mint: pos.mint, pairAddress: pos.pairAddress, strategyId: pos.strategyId, reason: d.reason, noRoute: !!sq.noRoute, error: sq.error });
  }
  // Conservative fill: the worse of the depth model and the real Jupiter quote at the same size
  // (quote also gets the stop/failed-exit delay drift).
  let fillPrice = fill.price, fillSource = 'depth';
  if (config.fills.useWorseOfQuote && sq && sq.ok && sq.quotedPriceUsd > 0) {
    const quotedAdj = sq.quotedPriceUsd * (1 - (fill.driftPct || 0) / 100);
    if (quotedAdj < fillPrice) { fillPrice = quotedAdj; fillSource = 'jupiter'; }
  }
  const gapPct = sq && sq.ok ? fillGapPct('sell', sq.quotedPriceUsd * (1 - (fill.driftPct || 0) / 100), fill.price) : null;
  const pnl = legPnlSol(pos, fillPrice, d.sellFrac);
  const leg = {
    time: new Date().toISOString(), reason: d.reason, sellFrac: d.sellFrac, tokens,
    midPrice: d.fillPrice, fillPrice, fillSource, modelPrice: fill.price, impactPct: fill.impactPct, slippagePct: fill.slippagePct,
    feePct: fill.feePct, driftPct: fill.driftPct, stop: fill.stop, failedFirst: fill.failedFirst,
    txCostSol: fill.txCostSol, pnlSol: pnl, fillGapPct: gapPct, shadow
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
  const pnl = legPnl - (pos.entryTxCostSol || 0) - legs.reduce((a, l) => a + l.txCostSol, 0);
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
    fillModel: 'depth-v1'
  };
  state.trades.unshift(trade);
  if (state.trades.length > 100) state.trades.pop();
  logTrade(trade);
  state.cooldowns[pos.mint] = Date.now() + ((strategyById(pos.strategyId) || {}).reentryCooldownMinutes || config.reentryCooldownMinutes) * 60000;
  const g = guardFor(pos.strategyId);
  g.dayPnlSol += pnl;
  g.consecLosses = pnl < 0 ? g.consecLosses + 1 : 0;
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

async function processExits(solUsd) {
  if (!state.openPositions.length) return 0;
  // Exit pricing always uses the pair pinned at entry, quoted directly by pairAddress.
  let quotes = {};
  try {
    quotes = await getPairsByAddress(state.openPositions.map(p => p.pairAddress));
  } catch (e) {
    console.error('[exit] quote fetch failed', e.message);
  }
  let exits = 0;
  const stillOpen = [];
  for (const pos of state.openPositions) {
    try {
      const q = quotes[pos.pairAddress];
      const fresh = !!(q && q.mint === pos.mint && q.priceUsd > 0);
      if (fresh) {
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
      const price = fresh ? q.priceUsd : (pos.lastPrice || pos.entryPrice);
      let d = decide(pos, price, fresh, fresh ? q : null);

      // NCS emergency: RugCheck flips (authority re-enabled / danger). Cached 5 min.
      if (!d && pos.strategyType === 'ncs' && fresh) {
        const strat = strategyById(pos.strategyId);
        const rc = await rugGate.checkToken({ mint: pos.mint, symbol: pos.symbol, pairAddress: pos.pairAddress, dexLiquidityUsd: q.liquidityUsd, extra: strat && strat.extraRug });
        if (rc.reasons.some(r => /mint-authority|freeze-authority|rugcheck-danger|rugged/.test(r))) {
          d = { action: 'close', reason: 'emergency-rug', sellFrac: pos.remainingFrac == null ? 1 : pos.remainingFrac, fillPrice: price };
        }
      }
      if (!d) { stillOpen.push(pos); continue; }
      await sellLeg(pos, d, fresh ? q : null, solUsd);
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
  return exits;
}

// Per-tick record of signals that passed but were skipped (shown in the scan line).
let tickSkips = [];
function noteSkip(rec, opts) {
  tickSkips.push(rec);
  rej.skip(rec, opts);
}

async function processEntries(signals, solUsd) {
  let entries = 0, rugChecks = 0;
  const openMints = new Set(state.openPositions.map(p => p.mint));
  for (const [m, until] of Object.entries(state.cooldowns)) if (until <= Date.now()) delete state.cooldowns[m];
  const seen = new Set();
  const candidates = [];
  for (const sig of signals) {
    if (!sig.mint || openMints.has(sig.mint) || seen.has(sig.mint)) continue;
    if (state.cooldowns[sig.mint]) { rej.count(sig.strategyId, 'cooldown'); continue; }
    const blocked = strategyBlocked(sig.strategy);
    if (blocked) { rej.count(sig.strategyId, blocked); continue; }
    seen.add(sig.mint);
    candidates.push(sig);
  }
  // Interleave strategies so one strategy can't use up the per-tick rug-check budget.
  const byStrat = {};
  candidates.forEach(c => (byStrat[c.strategyId] = byStrat[c.strategyId] || []).push(c));
  const queues = Object.values(byStrat);
  candidates.length = 0;
  while (queues.some(q => q.length)) queues.forEach(q => { if (q.length) candidates.push(q.shift()); });
  if (!candidates.length) return 0;
  if (!canOpenGlobal()) {
    const st = slotStatus(state, null, config);
    for (const sig of candidates) noteSkip({ strategyId: sig.strategyId, ...st, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
    return 0;
  }
  const quotes = await getPairsByAddress(candidates.slice(0, 30).map(s => s.pairAddress));
  for (const sig of candidates.slice(0, 30)) {
    if (entries >= 5) break;
    const strat = sig.strategy;
    // Signal passed its gates; if no slot is free, log it as a "slot-full skip".
    const slot = slotStatus(state, strat, config);
    if (slot) {
      noteSkip({ strategyId: strat.id, ...slot, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
      continue;
    }
    const openForStrat = state.openPositions.filter(p => p.strategyId === strat.id);
    const q = quotes[sig.pairAddress];
    if (!q || q.mint !== sig.mint || !(q.priceUsd > 0)) { rej.count(strat.id, 'entry-quote-missing'); continue; }
    // Tokenized equities (Jupiter tags / issuer). The static denylist already ran in buyAgent.
    const eq = await denylist.check({ mint: sig.mint, symbol: sig.symbol, name: sig.name });
    if (eq) {
      noteSkip({ strategyId: strat.id, reason: denylist.REASON, detail: eq, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol });
      continue;
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
      rej.nearMiss({ strategyId: strat.id, gate, reasons: rug.reasons, mint: sig.mint, pairAddress: sig.pairAddress, symbol: sig.symbol, liquidityUsd: q.liquidityUsd, priceUsd: q.priceUsd });
      continue;
    }
    // Size
    let sizeSol = strat.sizeSol || config.positionSizeSol;
    if (strat.sizing) {
      const eq = equitySol();
      sizeSol = eq * (strat.sizing.basePctOfEquity / 100) * (sig.sizeMult || 1);
      sizeSol = Math.min(sizeSol, (q.liquidityUsd * strat.sizing.maxPctOfPoolLiquidity / 100) / solUsd);
      const exposure = openForStrat.reduce((a, p) => a + p.sizeSol * (p.remainingFrac == null ? 1 : p.remainingFrac), 0);
      const room = eq * (strat.sizing.maxTotalExposurePct / 100) - exposure;
      sizeSol = Math.min(sizeSol, room);
      if (!(sizeSol >= 0.01)) { rej.count(strat.id, 'exposure-cap'); continue; }
    }
    sizeSol = +sizeSol.toFixed(4);
    const fill = fillModel.fillEntry({ midPrice: q.priceUsd, sizeSol, solUsd, liquidityUsd: q.liquidityUsd });
    let sq = null;
    try {
      sq = await jup.shadowBuyQuote({ mint: sig.mint, decimals: rug.facts.decimals, sizeSol, solUsd });
    } catch (e) { sq = { ok: false, error: e.message }; }
    const entryShadow = shadowSummary(sq, fill.price);
    const entryFillGapPct = sq && sq.ok ? fillGapPct('buy', sq.quotedPriceUsd, fill.price) : null;
    let entryFill = fill.price, entryFillSource = 'depth';
    if (config.fills.useWorseOfQuote && sq && sq.ok && sq.quotedPriceUsd > entryFill) { entryFill = sq.quotedPriceUsd; entryFillSource = 'jupiter'; }
    if (sq && !sq.ok) rej.event('entry-quote-failed', { source: 'jupiter', mint: sig.mint, strategyId: strat.id, noRoute: !!sq.noRoute, error: sq.error });
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
      tokens: (sizeSol * solUsd) / entryFill,
      sizeSol,
      remainingFrac: 1,
      entryTime: new Date().toISOString(),
      exit: strat.exit,
      highest: q.priceUsd,
      lastPrice: q.priceUsd,
      rug: rug.facts
    };
    state.openPositions.push(pos);
    state.balance -= sizeSol + fill.txCostSol;
    openMints.add(sig.mint);
    entries++;
    const line = `ENTRY ${sig.symbol} ${sig.mint} pair=${sig.pairAddress} (${strat.id}${sig.tier ? ' tier ' + sig.tier : ''}) mid=${q.priceUsd} fill=${entryFill.toPrecision(6)}(${entryFillSource}) size=${sizeSol} jup=${entryShadow && entryShadow.quotedPriceUsd ? entryShadow.quotedPriceUsd.toPrecision(6) : 'n/a'} gap=${entryFillGapPct == null ? 'n/a' : entryFillGapPct.toFixed(2) + '%'}`;
    addActivity(line);
    console.log(`[trade] ${line}`);
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

    const { signals, rejections, gateStats } = generateSignals(pairs, { count: rej.count, nearMiss: rej.nearMiss, skip: noteSkip });
    signalsCount = signals.length;
    gateLine = Object.entries(gateStats).map(([id, st]) => {
      const fails = Object.entries(st.fails).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(',');
      return `${id} pass=${st.passed}/${st.scanned} fails{${fails}}`;
    }).join(' | ');
    if (rejections.length) addActivity(`Rejections: ${rejections.slice(0, 2).join(' | ')}`);

    entries = await processEntries(signals, solUsd);
  } catch (e) {
    addActivity(`Tick error: ${e.message}`);
    console.error('[scan] tick error', e && e.stack || e);
  } finally {
    lastScanSummary = `${new Date().toISOString()} pairs=${pairsCount} signals=${signalsCount} entries=${entries} exits=${exits}`;
    const skipLine = formatSkips(tickSkips);
    console.log(`[scan] #${tickCount} ${Date.now() - t0}ms mints=${discovered} pairs=${pairsCount} signals=${signalsCount} entries=${entries} exits=${exits} open=${state.openPositions.length} bal=${state.balance.toFixed(4)} || ${gateLine}${skipLine ? ' || ' + skipLine : ''}`);
    try { saveState(state); } catch (e) { console.error('[scan] save error', e.message); }
    tickRunning = false;
  }
}

// Fast exit checks for open positions between full scans (NCS spec: recheck every 15s).
async function exitTick() {
  if (tickRunning || !state.openPositions.length) return;
  tickRunning = true;
  try {
    const solUsd = await jup.getSolUsd(state.lastSolUsd || null);
    if (solUsd) {
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

function summarize(trades) {
  const byStrategy = {};
  for (const s of config.strategies) {
    byStrategy[s.id] = { configHash: config.strategyHashes[s.id], trades: 0, wins: 0, pnlSol: 0, best: null, olderHashTrades: 0 };
  }
  for (const t of trades) {
    const s = byStrategy[t.strategyId] || (byStrategy[t.strategyId] = { configHash: null, trades: 0, wins: 0, pnlSol: 0, best: null, olderHashTrades: 0 });
    // The go-live count resets whenever the strategy's config hash changes.
    if (s.configHash && t.configHash !== s.configHash) { s.olderHashTrades++; continue; }
    s.trades++;
    if (t.pnlSol > 0) s.wins++;
    s.pnlSol += t.pnlSol;
    s.best = s.best == null ? t.pnlSol : Math.max(s.best, t.pnlSol);
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
      openPositions: state.openPositions,
      lastScan: lastScanSummary,
      trades
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rejections', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  res.json({ build: config.buildId, ...rej.snapshot(),
    slotFullSkips: rej.skips.filter(k => k.reason === 'slot-full skip').slice(0, limit),
    tokenizedEquity: rej.skips.filter(k => k.reason === denylist.REASON).slice(0, limit),
    nearMisses: rej.nearMisses.slice(0, parseInt(req.query.limit || '100', 10)) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, build: config.buildId, ticks: tickCount, lastScan: lastScanSummary, lastUpdate: state.lastUpdate, balance: state.balance, openPositions: state.openPositions.length, accountSince: state.startedAt || null, buildHistory: (state.buildHistory || []).slice(-5), configHashes: config.strategyHashes });
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
    <td>${s.pnlSol.toFixed(4)}</td><td>${Number(s.pnlExBestSol).toFixed(4)}</td><td>${esc(strategyBlocked(strategyById(id) || {}) || 'ok')}</td></tr>`).join('');

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
      <h1>Solana Paper Bot</h1>
      <div class="balance">Balance: ${state.balance.toFixed(4)} SOL</div>
      <p>Open positions: ${state.openPositions.length} / ${config.maxOpen} | Last update: ${new Date(state.lastUpdate).toLocaleString()}</p>
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

app.listen(config.port, () => {
  console.log(`Dashboard running on port ${config.port}`);
  tick();
  setInterval(() => { tick().catch(e => console.error('[scan] interval error', e)); }, config.pollIntervalMs);
  setInterval(() => { exitTick().catch(e => console.error('[exit-check] interval error', e)); }, config.exitCheckMs);
});
