const express = require('express');
const config = require('./config');
const loggerMod = require('./logger');
const { loadState } = loggerMod;
const botsMod = require('./bots');
// t79u Bots panel: real activity signals per runtime component (read-only bookkeeping).
const botTracker = botsMod.makeTracker();
let tradesWritten = 0;
function saveState(s) { const ok = loggerMod.saveState(s); if (ok === false) botTracker.error('logger', 'state.json write failed'); else botTracker.work('logger', 1); return ok; }
function logTrade(t) { const ok = loggerMod.logTrade(t); if (ok === false) botTracker.error('logger', 'trades.jsonl append failed'); else tradesWritten += 1; return ok; }
const legacyRug = { checks: 0, passed: 0, rejected: 0 };
const { scan } = require('./agents/scanner');
const { rugCheck } = require('./agents/rugCheck');
const { sizePosition } = require('./agents/sizer');
const { executeEntry } = require('./agents/executor');
const { logDecision } = require('./agents/logger');
const { generateSignals } = require('./buyAgent');
const sellAgent = require('./sellAgent');
const { render } = require('./dashboard');
const { review, sizeFor } = require('./manager');
const reentry = require('./reentry');
const httpBackoff = require('./httpBackoff');
const poolPrice = require('./poolPrice');
const dataFetcher = require('./dataFetcher');
const { step: labStep } = require('./lab');
const fs = require('fs');
const path = require('path');
const { Limiter } = require('./books/limiter');
const { makeQuotes } = require('./books/quotes');
const { makeMintAuth } = require('./books/mintAuth');
const { makeBooks } = require('./books/engine');
const { classifyBlocked } = require('./books/blocklist');
const { makeDashboardApi, equityLog } = require('./dashboardApi');
const newPools = require('./newPools');
const { makeLegacyExits, nextDelayMs, makeStats } = require('./exitLoop');
const stopFillsMod = require('./stopFills');
const pnlMod = require('./pnl');
const SERVER_STARTED_AT = new Date().toISOString();

const BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || null;
// PR11 books: Jupiter (read-only quote API) and read-only Solana RPC get their own limiter buckets.
const booksLimiter = new Limiter({
  buckets: {
    jupiter: { minGapMs: 1100, maxRetries: 1, cooldownMs: 20000 },   // <= ~55 requests/min (lite-api free 60/min)
    rpc: { minGapMs: 400, maxRetries: 1, cooldownMs: 30000 },
    rugcheck: { minGapMs: 3000, maxRetries: 0, cooldownMs: 600000 }   // grad sniper v2: free RugCheck report, no retries, 10 min pause on 429
  },
  baseBackoffMs: 1000, maxBackoffMs: 10000
});
const quotes = makeQuotes(booksLimiter);
const mintAuth = makeMintAuth(booksLimiter);
const { makeHolderCheck } = require('./books/holderCheck');
const holderCheck = makeHolderCheck(booksLimiter);

const shouldExit = sellAgent.shouldExit;
const computePnl = sellAgent.computePnl || function (pos, exitPrice) {
  const gross = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const net = gross - (config.costRoundtripPct || 1.1) / 100;
  return net * pos.sizeSol;
};

let state = loadState();
if (!state || typeof state !== 'object') state = {};
if (!Array.isArray(state.activity)) state.activity = [];
if (!Array.isArray(state.openPositions)) state.openPositions = [];
if (!Array.isArray(state.trades)) state.trades = [];
if (typeof state.balance !== 'number') state.balance = config.startingSol;
if (!Array.isArray(state.decisions)) state.decisions = [];
console.log('Re-entry cooldowns seeded from closed trades: ' + reentry.seed(state, config));

const books = makeBooks({
  config, quotes, mintAuth, reentry, holderCheck,
  log: function (type, symbol, reason) {
    state.decisions.unshift(logDecision(type, symbol, reason));
    if (type !== 'SKIP') addActivity(type + ' ' + symbol + ' ' + reason);
  },
  saveTrade: function (trade) { logTrade(trade); }
});
books.ensure(state);

// PR11 scoreboard reset (once per epoch): the old trades are archived on the volume (state copy +
// trades.jsonl copy; nothing is deleted), the scoreboard restarts empty from `since` with the build hash.
// Balance carries over unchanged (same balance). Open legacy positions stay open and score on the new board.
function resetScoreboard(extra) {
  const epoch = config.books.epoch;
  if (state.scoreboard && state.scoreboard.epoch === epoch) return null;
  const prev = state.scoreboard || null;
  const dir = path.dirname(process.env.STATE_FILE || './data/state.json');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(dir, 'archive', 'pre-' + epoch + '-' + stamp + '.json');
  const tradesFile = process.env.TRADES_FILE || path.join(dir, 'trades.jsonl');
  const tradesCopy = path.join(dir, 'archive', 'trades-pre-' + epoch + '-' + stamp + '.jsonl');
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  fs.writeFileSync(archiveFile, JSON.stringify({ archivedAt: new Date().toISOString(), epochBefore: (state.scoreboard && state.scoreboard.epoch) || 'legacy', balance: state.balance, equity: equity(), openPositions: state.openPositions, trades: state.trades, bookTrades: books.ensure(state).trades, bookOpen: books.ensure(state).open, strategyStats: state.strategyStats || null, fetchStats: state.fetchStats || null, poolChecks: state.poolChecks || null }, null, 1));
  let copied = 0;
  try { if (fs.existsSync(tradesFile)) { fs.copyFileSync(tradesFile, tradesCopy); copied = fs.readFileSync(tradesCopy, 'utf8').split('\n').filter(Boolean).length; } } catch (e) { console.error('trades.jsonl archive copy failed', e.message); }
  const archivedTrades = (state.trades || []).length;
  state.managerHistory = (state.trades || []).slice(0, 100).map(function (t) { return { strategyId: t.strategyId, pnlSol: t.pnlSol, closedAt: t.closedAt }; });
  state.trades = [];
  state.riskResetAt = Date.now();
  // t85u: a board started right after leftover closes begins 1 ms after the last close (never counts them).
  const nowIso = (extra && extra.since) || new Date().toISOString();
  // t85u: the closed epoch is kept (window + start/end equity) so /api/pnl?epoch=<old> still reconciles it.
  if (prev && prev.epoch && prev.since) {
    if (!Array.isArray(state.scoreboardHistory)) state.scoreboardHistory = [];
    state.scoreboardHistory.push({ epoch: prev.epoch, since: prev.since, until: nowIso, startEquity: prev.startEquity, startBalance: prev.startBalance, endEquity: equity(), endBalance: state.balance, endMarkedEquity: markedEquityNow(), build: prev.build || null });
  }
  const carried = (state.openPositions || []).concat(books.ensure(state).open).map(function (p) { return { id: p.id, symbol: p.symbol, strategyId: p.strategyId || p.book, strategyVersion: p.strategyVersion || null, costBasisSol: p.book ? p.costBasisRemainingSol : p.sizeSol, entryTime: p.entryTime }; });
  state.scoreboard = Object.assign({ epoch: epoch, since: nowIso, build: BUILD, startBalance: state.balance, startEquity: equity(), startMarkedEquity: markedEquityNow(), archiveFile: archiveFile, tradesJsonlCopy: copied ? tradesCopy : null, archivedStateTrades: archivedTrades, archivedJsonlTrades: copied, archivedBookTrades: books.ensure(state).trades.length, legacyOpenCarried: (state.openPositions || []).length, carriedOpen: carried, onlyStrategies: config.onlyStrategies || null }, extra || {});
  addActivity('SCOREBOARD reset (' + epoch + '): ' + archivedTrades + ' trades archived to ' + path.basename(archiveFile) + ', balance unchanged ' + Number(state.balance).toFixed(4));
  return state.scoreboard;
}
// t85u: an epoch with epochCloseout (runner-v2) first closes every open position of a strategy that is not
// in config.onlyStrategies (paper close at a Jupiter sell quote, in the exit loop), then starts the board, so
// the new board's equity change is the allowed strategies' P&L alone. Entries wait while it is pending.
function leftovers() {
  if (!Array.isArray(config.onlyStrategies)) return [];
  const ok = function (p) { return config.onlyStrategies.indexOf(p.strategyId || p.book) >= 0; };
  return (state.openPositions || []).filter(function (p) { return !ok(p); }).concat(books.ensure(state).open.filter(function (p) { return !ok(p); }));
}
function markedEquityNow() {
  const c = config.costRoundtripPct || 1.1;
  let un = 0;
  for (const p of (state.openPositions || []).concat(books.ensure(state).open)) { const u = pnlMod.unrealisedOf(p, c); if (u != null) un += u; }
  return equity() + un;
}
function startEpoch() {
  const epoch = config.books.epoch;
  if (state.scoreboard && state.scoreboard.epoch === epoch) { if (state.epochSwitch && state.epochSwitch.pending) state.epochSwitch.pending = false; return null; }
  if (state.scoreboard && config.books.epochCloseout && leftovers().length) {
    if (!state.epochSwitch || state.epochSwitch.to !== epoch) state.epochSwitch = { to: epoch, from: state.scoreboard.epoch, requestedAt: new Date().toISOString(), build: BUILD, pending: true, closes: [] };
    state.epochSwitch.pending = true;
    return null;
  }
  const sw = state.epochSwitch && state.epochSwitch.to === epoch ? state.epochSwitch : null;
  const lastClose = sw ? sw.closes.reduce(function (a, c) { return Math.max(a, Date.parse(c.closedAt) || 0); }, 0) : 0;
  const sinceIso = new Date(Math.max(Date.now(), lastClose + 1)).toISOString();
  const sb = resetScoreboard(sw ? { since: sinceIso, leftoverCloses: sw.closes, switchRequestedAt: sw.requestedAt } : null);
  if (sw) { sw.pending = false; sw.doneAt = sb ? sb.since : new Date().toISOString(); }
  return sb;
}
async function closeLeftovers() {
  const sw = state.epochSwitch;
  if (!sw || !sw.pending) return 0;
  let closed = 0;
  for (const pos of leftovers()) {
    const tr = pos.book ? await books.locked(function () { return books.closeNowInner(state, pos, 'epoch-close'); }) : await legacyExits.closeNow(state, pos, 'epoch-close');
    if (tr) { closed++; sw.closes.push({ symbol: tr.symbol, strategyId: tr.strategyId, strategyVersion: tr.strategyVersion, sizeSol: tr.sizeSol, entryTime: tr.entryTime, closedAt: tr.closedAt, pnlSol: +Number(tr.pnlSol).toFixed(6), pnlPct: tr.pnlPct, source: 'jupiter-sell-quote' }); addActivity('EPOCH close ' + tr.symbol + ' (' + tr.strategyId + ') pnl ' + Number(tr.pnlSol).toFixed(5)); }
  }
  if (!leftovers().length) { const sb = startEpoch(); if (sb) addActivity('SCOREBOARD ' + sb.epoch + ' started at equity ' + Number(sb.startEquity).toFixed(4) + ' after ' + sw.closes.length + ' leftover closes'); }
  return closed;
}
try { startEpoch(); } catch (e) { console.error('Scoreboard reset failed', e.message); }
if (state.scoreboard) state.scoreboard.build = BUILD || state.scoreboard.build;

const app = express();

function addActivity(msg) {
  state.activity.unshift({ time: new Date().toISOString(), msg });
  if (state.activity.length > 50) state.activity.pop();
}

function lockedSol() {
  return (state.openPositions || []).reduce(function (sum, pos) { return sum + (Number(pos.sizeSol) || 0); }, 0) + books.lockedSol(state);
}

function equity() {
  return (Number(state.balance) || 0) + lockedSol();
}

function sessionPnl() {
  const since = state.riskResetAt || 0;
  return (state.trades || []).reduce(function (sum, trade) {
    if (new Date(trade.closedAt).getTime() < since) return sum;
    return sum + (Number(trade.pnlSol) || 0);
  }, 0);
}

function skipSummary(rejections) {
  const counts = {};
  for (const line of rejections || []) {
    const raw = String(line);
    const match = raw.match(/:\s*([a-zA-Z0-9]+)\s+[-\d.]+\s+not\s+([<>]=?)\s+([-\d.]+)/);
    const key = match ? match[1] + ' not ' + match[2] + ' ' + match[3] : raw.split(':').slice(1).join(':').trim().slice(0, 60);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 4).map(function (key) {
    return counts[key] + ' missed: ' + key;
  });
}

function canOpen() {
  if (equity() < config.fullStopBalance) { state.blockReason = 'equity under 2.5'; return false; }
  if ((state.openPositions || []).length >= config.maxOpen) { state.blockReason = 'slots full'; return false; }
  if (state.coolUntil && Date.now() < state.coolUntil) { state.blockReason = 'cooldown'; return false; }
  if (sessionPnl() <= -config.dailyLossLimitSol) {
    state.coolUntil = Date.now() + 15 * 60 * 1000;
    state.riskResetAt = state.coolUntil;
    state.blockReason = 'cooldown 15m after -0.2';
    return false;
  }
  state.blockReason = '';
  return true;
}

// Slot reserve: strategies without a reserve may not take the slots reserved for others
// (config.slotReserve, e.g. { 'dip-hold': 1 }); the global config.maxOpen cap is unchanged.
function slotFree(strategyId) {
  const reserve = config.slotReserve || {};
  const open = state.openPositions || [];
  let held = 0;
  for (const [id, n] of Object.entries(reserve)) {
    if (id === strategyId) continue;
    held += Math.max(0, n - open.filter(function (p) { return p.strategyId === id; }).length);
  }
  if (open.length + 1 + held > config.maxOpen) {
    state.decisions.unshift(logDecision('SKIP', '-', 'slot reserved for ' + Object.keys(reserve).join(',')));
    return false;
  }
  return true;
}

// Entry pool check (PR8, fail closed): the entry price (fresh stored-pool price) vs the token's main
// pool (highest liquidity). Unverified -> skip; more than config.maxPoolDivergencePct (5%) off -> skip.
function poolChecks() {
  if (!state.poolChecks || state.poolChecks.v !== 3) state.poolChecks = { v: 3, bySource: {}, since: new Date().toISOString(), checked: 0, verified: 0, divergenceSkips: 0, unverifiedSkips: 0, noPriceSkips: 0, lastSkips: [], lastVerified: [] };
  return state.poolChecks;
}
function recordSkip(st, row) {
  st.lastSkips = st.lastSkips.concat([Object.assign({ at: new Date().toISOString() }, row)]).slice(-20);
}
function poolGate(sig, entryPrice, pairs) {
  const st = poolChecks();
  st.checked += 1;
  const main = sig.mint ? poolPrice.mainPoolFor(sig.mint, pairs) : { pool: null, verified: false };
  if (!main.verified || !main.pool) {
    st.unverifiedSkips += 1;
    recordSkip(st, { reason: 'unverified', mainSource: main.source || null, symbol: sig.symbol, strategyId: sig.strategyId, pairAddress: sig.pairAddress, mint: sig.mint || null });
    state.decisions.unshift(logDecision('SKIP', sig.symbol, 'main pool unverified'));
    return { ok: false, reason: 'unverified' };
  }
  // Main pool (independently found) == entry pool: no gap to apply. Otherwise the 5% rule.
  const samePool = main.pool.pairAddress === sig.pairAddress;
  const gap = samePool ? 0 : poolPrice.divergencePct(entryPrice, main.pool.priceUsd);
  const max = config.maxPoolDivergencePct || 5;
  if (gap == null || gap > max) {
    st.divergenceSkips += 1;
    recordSkip(st, { reason: 'divergence', symbol: sig.symbol, strategyId: sig.strategyId, pairAddress: sig.pairAddress, mainPool: main.pool.pairAddress, mainSource: main.source, price: entryPrice, mainPrice: main.pool.priceUsd, gapPct: gap == null ? null : +gap.toFixed(2) });
    state.decisions.unshift(logDecision('SKIP', sig.symbol, 'pool price ' + (gap == null ? '?' : gap.toFixed(1)) + '% off main pool'));
    addActivity('SKIP ' + sig.symbol + ' pool price ' + (gap == null ? '?' : gap.toFixed(1)) + '% off main pool ' + String(main.pool.pairAddress).slice(0, 6));
    return { ok: false, reason: 'divergence', gap };
  }
  st.verified += 1;
  st.bySource = st.bySource || {};
  st.bySource[main.source] = (st.bySource[main.source] || 0) + 1;
  st.lastVerified = st.lastVerified.concat([{ symbol: sig.symbol, pairAddress: sig.pairAddress, mainPool: main.pool.pairAddress, mainSource: main.source, samePool: samePool, gapPct: +gap.toFixed(2), at: new Date().toISOString() }]).slice(-10);
  return { ok: true, gap };
}

// PR10: the scan runs on DexScreener (shared limiter). fetchStats keeps the same top-level fields as
// before (requests, rateLimited, retries, skipped, last429At) now counting the SCAN's requests, plus
// since (counter start), per-host counters across both limiters, the GeckoTerminal fallback limiter, and
// scan pass stats (candidates per pass).
function fetchStats() {
  const ds = poolPrice.mainLimiter.stats;
  const gt = httpBackoff.stats;
  const scanTag = (ds.byTag && ds.byTag.scan) || { requests: 0, rateLimited: 0, failures: 0, skipped: 0 };
  const byHost = {};
  // PR13: the new_pools feed is its own host entry (api.geckoterminal.com/new_pools), separate from the
  // legacy GeckoTerminal /pools/multi fallback (api.geckoterminal.com).
  const feedHost = {}; feedHost[newPools.HOST] = newPools.hostStats();
  const rc = booksLimiter.stats().rugcheck || {};
  feedHost['api.rugcheck.xyz'] = { requests: rc.requests || 0, rateLimited: rc.http429 || 0, failures: rc.errors || 0, skipped: rc.cooldownSkips || 0 };
  const jl = booksLimiter.stats().jupiter || {};
  feedHost['lite-api.jup.ag'] = { requests: jl.requests || 0, rateLimited: jl.http429 || 0, failures: jl.errors || 0, skipped: jl.cooldownSkips || 0 };
  for (const src of [ds.byHost || {}, gt.byHost || {}, feedHost]) {
    for (const [h, c] of Object.entries(src)) {
      const b = byHost[h] || (byHost[h] = { requests: 0, rateLimited: 0, failures: 0, skipped: 0 });
      for (const k of Object.keys(b)) b[k] += c[k] || 0;
    }
  }
  return {
    requests: scanTag.requests, rateLimited: scanTag.rateLimited, retries: 0, skipped: scanTag.skipped,
    last429At: ds.last429At, failures: scanTag.failures, since: ds.since, scanSource: 'dexscreener',
    byHost: byHost,
    dexscreenerByTag: JSON.parse(JSON.stringify(ds.byTag || {})),
    geckoterminal: JSON.parse(JSON.stringify(gt)),
    scan: Object.assign({}, dataFetcher.scanStats),
    newPoolsFeed: newPools.snapshot()
  };
}

let ticking = false;
async function tick() {
  if (ticking) return; // a slow (backed-off) pass must not overlap the next one
  ticking = true;
  const tickT0 = Date.now();
  botTracker.beat('manager');
  try {
    if (state.paperReset !== 'work-1') {
      state.paperReset = 'work-1';
      state.riskResetAt = Date.now();
      state.coolUntil = 0;
      addActivity('MANAGER old losses no longer freeze new paper trades');
    }
    const notes = review(state, config).notes;
    for (const note of notes) addActivity(note);
    const pairs = await scan();
    addActivity('SCAN: ' + pairs.length + ' pairs');
    botTracker.get('scanner').lastPairs = pairs.length;
    if (pairs.length > 0) botTracker.work('scanner', pairs.length); else botTracker.error('scanner', 'scan returned 0 pairs');
    const byAddr = {};
    for (const p of pairs) if (p && p.pairAddress) byAddr[p.pairAddress] = p;
    // PR14: legacy positions are no longer marked or exited here. The exit loop (startExitLoop, ~5 s)
    // marks and exits every open trade on Jupiter sell quotes only. The scan only refreshes pool
    // liquidity on open positions (logged on stop fills).
    for (const pos of state.openPositions.concat(books.ensure(state).open)) {
      const row = pos.pairAddress && byAddr[pos.pairAddress];
      if (row && row.liquidityUsd > 0) { pos.lastLiquidityUsd = row.liquidityUsd; pos.lastLiquidityAt = new Date().toISOString(); }
    }
    reentry.prune(state);
    const labNotes = labStep(state, pairs);
    for (const note of labNotes) addActivity(note);
    const result = generateSignals(pairs) || { signals: [], rejections: [] };
    // PR14 dashboard: legacy signals per strategy in the last scan (why an empty strategy is idle).
    state.lastLegacyScan = { at: new Date().toISOString(), pairs: pairs.length, signalsByStrategy: (result.signals || []).reduce(function (a, sg) { a[sg.strategyId] = (a[sg.strategyId] || 0) + 1; return a; }, {}) };
    result.signals = (result.signals || []).filter(function (sig) {
      // t85u: only config.onlyStrategies may open (paused flags stay too); nothing opens while an epoch switch is pending.
      if (!books.allowed(sig.strategyId) || (state.epochSwitch && state.epochSwitch.pending)) return false;
      const why = books.stockBlock(state, { mint: sig.mint, symbol: sig.symbol, name: sig.pair && sig.pair.name }, 'legacy');
      if (why) state.decisions.unshift(logDecision('SKIP', sig.symbol, 'stock-block: ' + why + ' (' + sig.strategyId + ')'));
      return !why;
    });
    state.skips = skipSummary(result.rejections);
    if (canOpen()) {
      let opened = 0;
      // Cooled-down tokens are skipped before the 3-per-pass cut so they don't use up the pass.
      const candidates = (result.signals || []).filter(function (sig) {
        const cool = reentry.blocked(state, sig);
        if (cool) state.decisions.unshift(logDecision('SKIP', sig.symbol, 're-entry cooldown ' + cool.minsLeft + 'm (' + cool.key.split(':')[0] + ')'));
        return !cool;
      });
      // Reserved strategies (dip-hold) are served first so the unpaused books can't crowd them out.
      const reserve = config.slotReserve || {};
      candidates.sort(function (a, b) { return (reserve[b.strategyId] ? 1 : 0) - (reserve[a.strategyId] ? 1 : 0); });
      // one candidate per pool per pass (several strategies can signal the same pool)
      const seenPool = {};
      const unique = candidates.filter(function (sig) { if (seenPool[sig.pairAddress]) return false; seenPool[sig.pairAddress] = true; return true; });
      const batch = unique.slice(0, 3);
      // Slow main-pool path (own limiter + cache), then fresh stored-pool prices for the entry fills.
      await poolPrice.prefetchMain(batch.map(function (s) { return s.mint; }));
      // PR9: entry fills come from DexScreener by pair address only (the source the marks use).
      const batchPools = batch.map(function (s) { return s.pairAddress; });
      const entryPx = await poolPrice.storedPoolPrices(batchPools, pairs, { dsOnly: batchPools });
      const gateSeen = {};
      for (let sig of batch) {
        if (!canOpen()) break;
        if (state.openPositions.some(function (p) { return p.symbol === sig.symbol; })) continue;
        // Cross-strategy same-mint guard: no legacy strategy opens a mint held by ANY book or legacy strategy
        // (fail closed). Logged as sameMintHeld in decisions and in /api/books rejects (byReason / byBook / recent).
        const heldM = books.heldMint(state, { mint: sig.mint || (sig.pair && sig.pair.mint) || null, pairAddress: sig.pairAddress });
        if (heldM) {
          books.rejectLegacy(state, sig.strategyId, sig, heldM.reason, { detail: heldM.detail, heldBy: heldM.heldBy });
          state.decisions.unshift(logDecision('SKIP', sig.symbol, heldM.reason + ': ' + heldM.detail + ' (' + sig.strategyId + ')'));
          continue;
        }
        if ((state.pausedIds || []).includes(sig.strategyId)) continue;
        if (!slotFree(sig.strategyId)) continue;
        // Entry fill from the SAME stored-pool source as the marks (fresh scan row or /pools/multi).
        const px = entryPx[sig.pairAddress];
        if (!px) {
          poolChecks().noPriceSkips += 1;
          state.decisions.unshift(logDecision('SKIP', sig.symbol, 'no fresh stored-pool price'));
          continue;
        }
        const gate = gateSeen[sig.pairAddress] || (gateSeen[sig.pairAddress] = poolGate(sig, px.priceUsd, pairs));
        if (!gate.ok) continue;
        sig = Object.assign({}, sig, { price: px.priceUsd });
        const check = rugCheck(sig.pair || pairs.find(function (p) { return p.pairAddress === sig.pairAddress; }));
        legacyRug.checks += 1; if (check.pass) legacyRug.passed += 1; else legacyRug.rejected += 1;
        if (!check.pass) {
          state.decisions.unshift(logDecision('SKIP', sig.symbol, 'rug check: ' + check.reason));
          continue;
        }
        const size = sizeFor(sizePosition(state.balance), state, config, sig.strategyId);
        const exec = executeEntry(sig, size, state.balance);
        if (exec.ok) {
          opened += 1;
          // The first mark is the entry price from the same source (no phantom gap on the next tick).
          exec.position.lastPrice = px.priceUsd;
          exec.position.lastPricedAt = new Date().toISOString();
          exec.position.storedPoolPriced = exec.position.lastPricedAt;
          exec.position.entryPriceSource = px.source;
          exec.position.markSource = px.source;
          exec.position.rugCheck = check;
          exec.position.legacy = true;
          exec.position.strategyVersion = sig.strategyId + ' legacy';
          exec.position.entryLiquidityUsd = exec.position.entryLiquidityUsd || (sig.pair && sig.pair.liquidityUsd) || null;
          // PR14: record the token amount from a Jupiter buy quote at size (read-only quote, no swap), so the
          // exit loop can quote the exact amount. Entry rules and the entry fill are unchanged; if the quote
          // fails the exit loop estimates tokens from the entry price instead (tokensEstimated: true).
          if (exec.position.mint) {
            const bq = await quotes.buyQuote(exec.position.mint, size);
            if (bq.ok) { exec.position.tokensRaw = bq.outAmount; exec.position.entryQuote = { inAmount: bq.inAmount, outAmount: bq.outAmount, priceImpactPct: bq.priceImpactPct, at: new Date(bq.at).toISOString(), route: bq.route || null }; }
            else exec.position.entryQuoteError = String(bq.error || '').slice(0, 80);
          }
          // Re-check after the buy-quote await: never push a second holding of the same mint.
          const heldLate = books.heldMint(state, exec.position.mint ? exec.position : sig);
          if (heldLate) {
            books.rejectLegacy(state, sig.strategyId, sig, heldLate.reason, { detail: heldLate.detail, heldBy: heldLate.heldBy, late: true });
            state.decisions.unshift(logDecision('SKIP', sig.symbol, heldLate.reason + ': ' + heldLate.detail + ' (' + sig.strategyId + ', late)'));
            opened -= 1;
            continue;
          }
          state.openPositions.push(exec.position);
          state.balance -= size;
          state.decisions.unshift(logDecision('ENTRY', sig.symbol, exec.reason, { size: size }));
          addActivity('ENTRY ' + sig.symbol + ' size ' + size.toFixed(3) + ' ' + (sig.strategyName || ''));
        }
      }
      if (opened) state.lastBlock = '';
      else if (state.lastBlock !== 'no-signal') {
        addActivity('SCAN no setup in ' + pairs.length + ' pairs');
        state.lastBlock = 'no-signal';
      }
    } else if (state.lastBlock !== state.blockReason) {
      addActivity('HOLD ' + state.blockReason);
      state.lastBlock = state.blockReason;
    }
    // PR11: the four books (own capacity, same size, Jupiter-quoted fills).
    try {
      // PR13: GeckoTerminal new_pools feed (1 call / 150 s, no retries, 10-min pause after a 429) ->
      // DexScreener rows for graduated pump.fun pools < 15 min old -> graduation sniper candidates only.
      let gradRows = [];
      // t83u: the new_pools feed (+ its DexScreener enrichment) only serves the graduation sniper -> off while it is paused.
      if (newPoolsEnabled()) {
        try { await newPools.maybeFetch(); gradRows = await newPools.candidateRows(pairs); } catch (e) { addActivity('New-pools feed error: ' + e.message); }
      }
      await books.runEntries(state, pairs, async function (sig, row) {
        await poolPrice.prefetchMain([sig.mint]);
        return poolGate(sig, row.priceUsd, pairs.concat(gradRows));
      }, { 'graduation-sniper': gradRows }, function () { newPools.stats.candidatesPassed += 1; });
    } catch (e) { addActivity('Books entry error: ' + e.message); console.error(e); }
    if (state.decisions.length > 100) state.decisions = state.decisions.slice(0, 100);
    // t79u: strategist evaluated legacy signals + book candidates this tick.
    const bscan = books.ensure(state).lastScan;
    const bookCand = bscan && bscan.candidatesByBook ? Object.values(bscan.candidatesByBook).reduce(function (a, v) { return a + (Number(v) || 0); }, 0) : 0;
    const legacySig = (result.signals || []).length;
    botTracker.beat('strategist');
    botTracker.get('strategist').lastEval = (legacySig + bookCand) + ' candidates in ' + pairs.length + ' pairs';
    if (legacySig + bookCand > 0) botTracker.work('strategist', legacySig + bookCand);
    botTracker.work('manager', 1);
  } catch (e) {
    addActivity('Tick error: ' + e.message);
    botTracker.error('manager', 'tick error: ' + e.message);
    console.error(e);
  }
  botTracker.get('manager').lastTickMs = Date.now() - tickT0;
  sampleBotCounters();
  state.lastUpdate = new Date().toISOString();
  state.fetchStats = fetchStats();
  try { saveState(state); } finally { ticking = false; }
}

// Paper Terminal dashboard (static page polling /api/dashboard + /api/equity); the previous server-rendered
// dashboard stays at /classic. Read-only: none of these routes change trading state.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.get('/', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/classic', function (req, res) {
  res.set('Cache-Control', 'no-store');
  const html = render(state, config);
  res.type('html').send(html.indexOf('</body>') >= 0 ? html.replace('</body>', renderBooks() + '</body>') : html + renderBooks());
});

app.get('/api/trades', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({
    count: (state.trades || []).length,
    balance: state.balance,
    equity: equity(),
    openPositions: state.openPositions,
    pausedIds: state.pausedIds || [],
    stratSizeMult: state.stratSizeMult || {},
    reentryCooldowns: state.reentryCooldowns || {},
    fetchStats: fetchStats(),
    newPoolsFeed: newPools.snapshot(),
    poolChecks: state.poolChecks || null,
    pairPriceLookups: Object.assign({}, poolPrice.pairStats),
    mainPoolLookups: Object.assign({}, poolPrice.mainStats, { limiter: Object.assign({}, poolPrice.mainLimiter.stats) }),
    remarks: state.remarks || [],
    build: BUILD,
    liveTrading: false,
    scoreboard: state.scoreboard || null,
    books: booksPayload(),
    bookOpenPositions: books.ensure(state).open,
    bookRejects: books.ensure(state).rejects,
    stockBlocks: books.ensure(state).stockBlocks,
    stockClosures: state.stockClosures || [],
    jupiterQuotes: jupiterStats(),
    mintAuthority: Object.assign({}, mintAuth.stats),
    booksLimiter: booksLimiter.stats(),
    exitLoop: exitLoopView(),
    stopFills: stopFillsView(),
    gradSniperV2: books.gradView(state),
    rugcheck: Object.assign({}, holderCheck.stats, { limiter: booksLimiter.stats().rugcheck }),
    legacyTrades: state.trades || [],
    bookTrades: books.ensure(state).trades,
    trades: allTrades()
  });
});

let dashApiInst = null; // built lazily (exitLoopStats is declared further down)
function dashApi() { return dashApiInst || (dashApiInst = makeDashboardApi({ getState: function () { return state; }, config, books, equity, lockedSol, fetchStats, jupiterStats, mintAuth, exitLoopStats, exitLoopView, stopFillsView, booksLimiter, build: BUILD, startedAt: SERVER_STARTED_AT })); }
// PR14 (Liviu t74u): open positions grouped by strategy/book (4 books + every legacy strategy).
app.get('/api/bots', function (req, res) {
  res.set('Cache-Control', 'no-store');
  try { res.json(botsView()); } catch (e) { console.error('bots view', e); res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/positions', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ now: new Date().toISOString(), build: BUILD, liveTrading: false, exitLoop: exitLoopView(), groups: dashApi().positionsByStrategy() });
});
app.get('/api/dashboard', function (req, res) {
  res.set('Cache-Control', 'no-store');
  try { const p = dashApi().payload(); try { p.pause = pauseView(); } catch (e) { p.pause = null; } try { const v = pnlView(); p.pnl = { epoch: v.window && v.window.epoch, since: v.window && v.window.since, startEquity: v.startEquity, startMarkedEquity: v.startMarkedEquity, equity: v.equity, equityChangeSol: v.equityChangeSol, realisedSol: v.realisedSol, unrealisedSol: v.unrealisedSol, markedEquity: v.markedEquity, markedChangeSol: v.markedChangeSol, residualSol: v.residualSol, reconciled: v.reconciled, byStrategy: v.byStrategy }; } catch (e) { p.pnl = null; } p.epochSwitch = state.epochSwitch || null; p.onlyStrategies = config.onlyStrategies || null; try { p.bots = botsView(); } catch (e) { p.bots = { error: String(e.message || e) }; } res.json(p); } catch (e) { console.error('dashboard payload', e); res.status(500).json({ error: String(e.message || e) }); }
});
// Equity curve: snapshots from equity.jsonl on the volume (1/min) plus the current live point.
// ?hours=N (default 24, max 720) or ?since=scoreboard; ?max=N points (default 600).
app.get('/api/equity', function (req, res) {
  res.set('Cache-Control', 'no-store');
  const sb = state.scoreboard || null;
  let sinceMs;
  if (req.query.since === 'scoreboard' && sb && sb.since) sinceMs = Date.parse(sb.since);
  else sinceMs = Date.now() - Math.min(720, Math.max(1, Number(req.query.hours) || 24)) * 3600000;
  const max = Math.min(5000, Math.max(10, Number(req.query.max) || 600));
  const raw = equityLog.read(sinceMs);
  let current = null;
  try { current = dashApi().snapshot(); } catch (e) { current = null; }
  res.json({ build: BUILD, intervalSec: 60, file: path.basename(equityLog.FILE), since: new Date(sinceMs).toISOString(), scoreboard: sb ? { epoch: sb.epoch, since: sb.since, startEquity: sb.startEquity, startBalance: sb.startBalance } : null, storedPoints: raw.length, points: equityLog.downsample(raw, max), current });
});
function recordEquity() {
  try { const p = dashApi().snapshot(); equityLog.append(p); return p; } catch (e) { console.error('equity snapshot', e.message); return null; }
}

// t85u: realised + open P&L by strategy/book since the scoreboard start (?epoch=<closed epoch> for an older
// window), from trades.jsonl + memory, reconciled against the equity change (residualSol ~ 0).
function pnlView(epoch) { return pnlMod.report(state, config, { tradesFile: process.env.TRADES_FILE || path.join(path.dirname(process.env.STATE_FILE || './data/state.json'), 'trades.jsonl'), epoch: epoch }); }
app.get('/api/pnl', function (req, res) {
  res.set('Cache-Control', 'no-store');
  try { res.json(Object.assign({ build: BUILD, liveTrading: false, scoreboard: state.scoreboard || null, epochSwitch: state.epochSwitch || null, onlyStrategies: config.onlyStrategies || null }, pnlView(req.query.epoch))); } catch (e) { console.error('pnl view', e); res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/books', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ build: BUILD, scoreboard: state.scoreboard || null, books: booksPayload(), openPositions: books.ensure(state).open, pause: pauseView(), rejects: books.ensure(state).rejects, sameMint: books.ensure(state).sameMint || { blocked: 0, byStrategy: {} }, stockBlocks: books.ensure(state).stockBlocks, stockClosures: state.stockClosures || [], jupiterQuotes: jupiterStats(), mintAuthority: Object.assign({}, mintAuth.stats), exitLoop: exitLoopView(), stopFills: stopFillsView(), gradSniperV2: books.gradView(state), rugcheck: Object.assign({}, holderCheck.stats), trades: books.ensure(state).trades });
});

app.get('/api/health', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, build: BUILD, liveTrading: false, lastUpdate: state.lastUpdate, scoreboard: state.scoreboard || null, epochSwitch: state.epochSwitch || null, onlyStrategies: config.onlyStrategies || null, exitLoop: exitLoopView(), stopFills: stopFillsView().summary, fetchStats: fetchStats(), jupiterQuotes: jupiterStats(), mintAuthority: Object.assign({}, mintAuth.stats) });
});

function booksPayload() {
  return { epoch: config.books.epoch, since: state.scoreboard ? state.scoreboard.since : null, sizeSol: config.books.sizeSol, maxOpenPerBook: config.books.maxOpenPerBook, targetTrades: config.books.targetTrades, maxPriceAgeSec: config.books.maxPriceAgeSec, costRoundtripPct: config.costRoundtripPct, list: books.report(state) };
}
function jupiterStats() {
  const s = quotes.stats;
  return Object.assign({}, s, { successRatePct: s.quotes ? +((100 * s.ok) / s.quotes).toFixed(1) : null, limiter: booksLimiter.stats().jupiter });
}
function allTrades() {
  const b = books.ensure(state).trades;
  return b.concat(state.trades || []).sort(function (x, y) { return Date.parse(y.closedAt) - Date.parse(x.closedAt); });
}

// PR14 (Liviu t72u): ONE exit loop for every open trade (4 books + legacy), separate from the 45 s scan.
// Each pass sells-quotes every open position on Jupiter (quote API only) and exits on that quote; target
// period config.books.exitLoopMs (5 s), stretched to n * 60/exitQuotesPerMin s when many trades are open.
const exitLoopStats = makeStats();
const legacyExits = makeLegacyExits({
  config, quotes, mintAuth, sellAgent, computePnl, classifyBlocked,
  log: function (type, symbol, reason) { state.decisions.unshift(logDecision(type, symbol, reason)); },
  onClose: function (trade, pos) {
    state.trades.unshift(trade);
    if (state.trades.length > 100) state.trades.pop();
    logTrade(trade);
    reentry.recordExit(state, trade, config);
    state.decisions.unshift(logDecision('EXIT', pos.symbol, trade.exitReason, { pnl: trade.pnlSol.toFixed(4) }));
    const sf = trade.stopFill;
    addActivity('EXIT ' + pos.symbol + ' ' + trade.exitReason + ' pnl=' + trade.pnlSol.toFixed(4) + (sf ? ' (stop ' + sf.stopLevelPct + '%, fill ' + sf.actualFillPct + '%, overshoot ' + sf.overshootPct + '%)' : ''));
  }
});
let exitPassRunning = false;
async function exitLoop() {
  if (exitPassRunning) return 0;
  exitPassRunning = true;
  const t0 = Date.now();
  if (exitLoopStats.lastPassStart) { exitLoopStats.passPeriods.push((t0 - exitLoopStats.lastPassStart) / 1000); if (exitLoopStats.passPeriods.length > 300) exitLoopStats.passPeriods.shift(); }
  exitLoopStats.lastPassStart = t0;
  let n = 0;
  try {
    if (state.epochSwitch && state.epochSwitch.pending) { try { if (await closeLeftovers()) saveState(state); } catch (e) { exitLoopStats.lastError = 'epoch closeout: ' + String(e.message || e).slice(0, 100); } }
    n = books.ensure(state).open.length;
    const changed = await books.runExitsInner(state, exitLoopStats);
    n += await legacyExits.run(state, exitLoopStats);
    exitLoopStats.passes += 1;
    exitLoopStats.positionsChecked += n;
    botTracker.beat('executor');
    if (n > 0) botTracker.work('executor', n);
    if ((changed || n) && !ticking) saveState(state);
  } catch (e) {
    exitLoopStats.errors += 1;
    exitLoopStats.lastError = String(e.message || e).slice(0, 120);
    botTracker.error('executor', 'exit loop: ' + exitLoopStats.lastError);
    console.error('exit loop', e);
  } finally { exitPassRunning = false; }
  exitLoopStats.lastPassAt = new Date().toISOString();
  sampleBotCounters();
  exitLoopStats.lastPassMs = Date.now() - t0;
  exitLoopStats.avgPassMs = exitLoopStats.avgPassMs == null ? exitLoopStats.lastPassMs : Math.round(exitLoopStats.avgPassMs * 0.9 + exitLoopStats.lastPassMs * 0.1);
  return n;
}
function exitLoopView() {
  return Object.assign(exitLoopStats.view({ targetMs: config.books.exitLoopMs, exitQuotesPerMin: config.books.exitQuotesPerMin, maxExitQuoteAgeSec: config.books.maxExitQuoteAgeSec },
    (state.openPositions || []).length + books.ensure(state).open.length), { legacy: Object.assign({}, legacyExits.stats), markSource: 'jupiter-sell-quote (all open trades)' });
}
// t79u: cumulative counters -> activity events (work when a counter rises, errors when an error counter rises).
function sampleBotCounters() {
  try {
    const ls = booksLimiter.stats();
    const jl = ls.jupiter || {}, rc = ls.rugcheck || {}, rpc = ls.rpc || {};
    botTracker.counter('executor.quotes', 'jupiter.requests', jl.requests);
    if (botTracker.counter('executor', 'jupiter.requests', jl.requests) > 0) botTracker.beat('executor');
    botTracker.counter('executor', 'jupiter.http429', jl.http429, 'error');
    botTracker.counter('executor', 'jupiter.errors', jl.errors, 'error');
    botTracker.beat('rugCheck');
    const bk = books.ensure(state);
    botTracker.counter('rugCheck', 'checks', (mintAuth.stats.checks || 0) + (holderCheck.stats.checks || 0) + legacyRug.checks + ((bk.stockBlocks && bk.stockBlocks.count) || 0));
    botTracker.counter('rugCheck', 'errors', (mintAuth.stats.errors || 0) + (holderCheck.stats.errors || 0) + (rc.http429 || 0) + (rpc.http429 || 0), 'error');
    const fsx = fetchStats();
    let s429 = 0;
    for (const [h, c] of Object.entries(fsx.byHost || {})) if (/dexscreener|geckoterminal/.test(h)) s429 += c.rateLimited || 0;
    botTracker.counter('scanner', 'http429', s429, 'error');
    botTracker.counter('scanner', 'newPools.calls', newPools.stats.calls);
  } catch (e) { console.error('bot counters', e.message); }
}
// t83u pause state (config paused flags; legacy also via manager pausedIds). Paused = no new entries only.
function newPoolsEnabled() { return (config.books.list || []).some(function (b) { return b.id === 'graduation-sniper' && !b.paused; }); }
function pauseView() {
  const bk = books.ensure(state);
  const legacyOpen = state.openPositions || [];
  const rows = (config.books.list || []).map(function (b) { return { id: b.id, kind: 'book', name: b.name + ' v' + b.version, paused: !!b.paused, open: (bk.open || []).filter(function (p) { return p.book === b.id; }).length }; })
    .concat((config.strategies || []).map(function (s) { return { id: s.id, kind: 'legacy', name: s.name, paused: !!s.paused || (state.pausedIds || []).indexOf(s.id) >= 0, open: legacyOpen.filter(function (p) { return p.strategyId === s.id; }).length }; }));
  return { activeStrategies: rows.filter(function (r) { return !r.paused; }).map(function (r) { return r.id; }), pausedStrategies: rows.filter(function (r) { return r.paused; }).map(function (r) { return r.id; }),
    strategies: rows, onlyStrategies: config.onlyStrategies || null, newPoolsFeed: newPoolsEnabled() ? 'on' : 'off (graduation sniper paused)', slotReserve: config.slotReserve || {},
    note: 'paused = no new entries; open positions are still marked and exited by the exit loop (Liviu t83u)' };
}
function botsView() {
  const now = Date.now();
  const bk = books.ensure(state);
  const legacyOpen = state.openPositions || [];
  const allOpen = legacyOpen.concat(bk.open || []);
  const closed = (bk.trades || []).concat(state.trades || []);
  const hourAgo = now - 3600000;
  const entriesLastHour = allOpen.concat(closed).filter(function (p) { return p.entryTime && Date.parse(p.entryTime) >= hourAgo; }).length;
  const lastTradeAt = closed.reduce(function (a, t) { return t.closedAt && (!a || t.closedAt > a) ? t.closedAt : a; }, null);
  const { scoreGroup } = require('./dashboardApi');
  const legacy = (config.strategies || []).map(function (s) {
    return Object.assign({ id: s.id, name: (s.name || s.id) + ' (legacy)', paused: (state.pausedIds || []).indexOf(s.id) >= 0 || !!s.paused, open: legacyOpen.filter(function (p) { return p.strategyId === s.id; }).length },
      scoreGroup((state.trades || []).filter(function (t) { return t.strategyId === s.id; })));
  });
  const ls = booksLimiter.stats();
  return botsMod.buildBots({ pause: pauseView(), newPoolsEnabled: newPoolsEnabled(), tracker: botTracker, now, startedAt: SERVER_STARTED_AT, build: BUILD, pollIntervalMs: config.pollIntervalMs, exitLoop: exitLoopView(), fetchStats: fetchStats(),
    mintAuthStats: mintAuth.stats, holderStats: holderCheck.stats, legacyRug, stockBlocks: bk.stockBlocks, jupiterLimiter: ls.jupiter, rugcheckLimiter: ls.rugcheck, newPools: newPools.stats,
    entriesLastHour, tradesWritten, tradesTotal: closed.length, lastTradeAt, openCount: allOpen.length, books: books.report(state), legacy, legacyOpenTotal: legacyOpen.length, maxOpen: config.maxOpen,
    lastScan: bk.lastScan || null, lastLegacyScan: state.lastLegacyScan || null });
}
function stopFillsView() { return { summary: stopFillsMod.summary(state), latest: (state.stopFills || []).slice(0, 50) }; }
function startExitLoop() {
  (async function loop() {
    const t0 = Date.now();
    const n = await exitLoop();
    const d = nextDelayMs(Date.now() - t0, n, { targetMs: config.books.exitLoopMs, exitQuotesPerMin: config.books.exitQuotesPerMin });
    exitLoopStats.lastDelayMs = d;
    setTimeout(loop, d);
  })();
}

function renderStopFills() {
  const v = stopFillsView();
  const sm = v.summary;
  const rows = v.latest.slice(0, 10).map(function (f) {
    return '<tr><td>' + f.strategyId + '</td><td>' + f.symbol + '</td><td>' + f.stopLevelPct + '%</td><td>' + (f.lastCheckPnlPct == null ? '-' : f.lastCheckPnlPct + '%') + '</td><td>' + f.actualFillPct + '%</td><td class="loss">' + f.overshootPct + '%</td><td>' + (f.sinceLastCheckSec == null ? '-' : f.sinceLastCheckSec + 's') + '</td><td>' + (f.priceImpactPct == null ? '-' : f.priceImpactPct + '%') + '</td></tr>';
  }).join('');
  const el = exitLoopView();
  return '<h3 style="margin:10px 0 4px">Stop fills (Jupiter sell quotes) \u00b7 ' + sm.count + ' \u00b7 avg overshoot ' + (sm.avgOvershootPct == null ? '-' : sm.avgOvershootPct + '%') + ' \u00b7 worst ' + (sm.maxOvershootPct == null ? '-' : sm.maxOvershootPct + '%') + '</h3><p class="mute">exit loop: check every ' + (el.checkIntervalSec.median == null ? '-' : el.checkIntervalSec.median + 's') + ' (median), ' + el.openPositions + ' open, ' + el.errors + ' errors</p>' +
    '<table style="width:100%;font-size:13px"><tr class="mute"><th align="left">strategy</th><th>token</th><th>stop</th><th>last check</th><th>fill</th><th>overshoot</th><th>since check</th><th>impact</th></tr>' + rows + '</table>';
}
function renderBooks() {
  const rows = books.report(state).map(function (b) {
    const cls = (b.profitPerTradeSol || 0) >= 0 ? 'win' : 'loss';
    return '<tr><td>' + b.label + '</td><td>' + b.progress + '</td><td>' + (b.winRatePct == null ? '-' : b.winRatePct + '%') + '</td><td class="' + cls + '">' + (b.profitPerTradeSol == null ? '-' : b.profitPerTradeSol.toFixed(5)) + '</td><td>' + (b.netWithoutBestSol == null ? '-' : b.netWithoutBestSol.toFixed(5)) + '</td><td>' + (b.worstLossPct == null ? '-' : b.worstLossPct + '%') + '</td><td>' + b.openPositions + '/' + b.maxOpen + '</td></tr>';
  }).join('');
  const sb = state.scoreboard || {};
  return '<section class="card" style="margin:12px auto;max-width:1180px;padding:12px"><h2 style="margin:0 0 6px">Books (paper, ' + config.books.sizeSol + ' SOL each, Jupiter-quoted fills)</h2><p class="mute">scoreboard ' + (sb.epoch || '') + ' since ' + (sb.since || '') + ' \u00b7 build ' + String(BUILD || 'local').slice(0, 7) + ' \u00b7 profit per trade after 1.1% costs</p>' +
    '<table style="width:100%;font-size:13px"><tr class="mute"><th align="left">book</th><th>trades</th><th>win</th><th>SOL/trade</th><th>net w/o best</th><th>worst</th><th>open</th></tr>' + rows + '</table>' + renderStopFills() + '</section>';
}

if (require.main === module) app.listen(config.port, function () {
  console.log('Dashboard running on port ' + config.port);
  tick();
  setInterval(tick, config.pollIntervalMs);
  startExitLoop();
  setTimeout(recordEquity, 5000);
  setInterval(recordEquity, 60000);
});

module.exports = { app, pnlView, startEpoch, closeLeftovers, leftovers, exitLoopOnce: function () { return exitLoop(); }, pauseView, newPoolsEnabled, botsView, botTracker, recordEquity, dashApi, tick, exitLoop, books, quotes, mintAuth, holderCheck, booksLimiter, resetScoreboard, getState: function () { return state; } };
