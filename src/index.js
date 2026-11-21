const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade } = require('./logger');
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
const SERVER_STARTED_AT = new Date().toISOString();

const BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || null;
// PR11 books: Jupiter (read-only quote API) and read-only Solana RPC get their own limiter buckets.
const booksLimiter = new Limiter({
  buckets: {
    jupiter: { minGapMs: 1100, maxRetries: 1, cooldownMs: 20000 },   // <= ~55 requests/min (lite-api free 60/min)
    rpc: { minGapMs: 400, maxRetries: 1, cooldownMs: 30000 }
  },
  baseBackoffMs: 1000, maxBackoffMs: 10000
});
const quotes = makeQuotes(booksLimiter);
const mintAuth = makeMintAuth(booksLimiter);

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
  config, quotes, mintAuth, reentry,
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
function resetScoreboard() {
  const epoch = config.books.epoch;
  if (state.scoreboard && state.scoreboard.epoch === epoch) return null;
  const dir = path.dirname(process.env.STATE_FILE || './data/state.json');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(dir, 'archive', 'pre-' + epoch + '-' + stamp + '.json');
  const tradesFile = process.env.TRADES_FILE || path.join(dir, 'trades.jsonl');
  const tradesCopy = path.join(dir, 'archive', 'trades-pre-' + epoch + '-' + stamp + '.jsonl');
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  fs.writeFileSync(archiveFile, JSON.stringify({ archivedAt: new Date().toISOString(), epochBefore: (state.scoreboard && state.scoreboard.epoch) || 'legacy', balance: state.balance, equity: equity(), openPositions: state.openPositions, trades: state.trades, strategyStats: state.strategyStats || null, fetchStats: state.fetchStats || null, poolChecks: state.poolChecks || null }, null, 1));
  let copied = 0;
  try { if (fs.existsSync(tradesFile)) { fs.copyFileSync(tradesFile, tradesCopy); copied = fs.readFileSync(tradesCopy, 'utf8').split('\n').filter(Boolean).length; } } catch (e) { console.error('trades.jsonl archive copy failed', e.message); }
  const archivedTrades = (state.trades || []).length;
  state.managerHistory = (state.trades || []).slice(0, 100).map(function (t) { return { strategyId: t.strategyId, pnlSol: t.pnlSol, closedAt: t.closedAt }; });
  state.trades = [];
  state.riskResetAt = Date.now();
  state.scoreboard = { epoch: epoch, since: new Date().toISOString(), build: BUILD, startBalance: state.balance, startEquity: equity(), archiveFile: archiveFile, tradesJsonlCopy: copied ? tradesCopy : null, archivedStateTrades: archivedTrades, archivedJsonlTrades: copied, legacyOpenCarried: (state.openPositions || []).length };
  addActivity('SCOREBOARD reset (' + epoch + '): ' + archivedTrades + ' trades archived to ' + path.basename(archiveFile) + ', balance unchanged ' + Number(state.balance).toFixed(4));
  return state.scoreboard;
}
try { resetScoreboard(); } catch (e) { console.error('Scoreboard reset failed', e.message); }
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
    const byAddr = {};
    for (const p of pairs) if (p && p.pairAddress) byAddr[p.pairAddress] = p;
    // PR7 stored-pool pricing: every mark, exit check and close fill comes ONLY from the pool stored
    // on the position (pos.pairAddress). Pools not in this scan are fetched by address; if the stored
    // pool has no price this tick the position holds (only time exits may fire) and retries next tick.
    // PR9: off-scan pools are priced by pair address through DexScreener (own budget); positions entered
    // from DexScreener are only ever marked from DexScreener (same source as their entry fill).
    const storedPools = await poolPrice.storedPoolPrices(state.openPositions.map(function (p) { return p.pairAddress; }), pairs, {
      dsOnly: state.openPositions.filter(function (p) { return p.entryPriceSource === 'dexscreener'; }).map(function (p) { return p.pairAddress; })
    });
    const stillOpen = [];
    for (const pos of state.openPositions) {
      let pair = null;
      if (pos.pairAddress) pair = storedPools[pos.pairAddress] || null;
      else if (!pos.noPoolLogged) {
        pos.noPoolLogged = true;
        addActivity('PRICE ' + pos.symbol + ': no stored pool on this position, kept old pricing (entry price)');
      }
      const fresh = !!(pair && pair.priceUsd > 0);
      if (fresh && !pos.storedPoolPriced) {
        // First tick on stored-pool pricing: re-mark from the stored pool and drop marks taken elsewhere.
        const before = pos.lastPrice;
        pos.storedPoolPriced = new Date().toISOString();
        pos.highest = Math.max(Number(pos.entryPrice) || 0, pair.priceUsd);
        if (pos.judgedHigh != null) delete pos.judgedHigh;
        state.remarks = (state.remarks || []).concat([{ symbol: pos.symbol, pairAddress: pos.pairAddress, before: before == null ? null : before, after: pair.priceUsd, at: pos.storedPoolPriced }]).slice(-20);
        addActivity('PRICE re-mark ' + pos.symbol + ' from stored pool ' + String(pos.pairAddress).slice(0, 6) + ': ' + (before == null ? 'n/a' : Number(before).toPrecision(5)) + ' -> ' + Number(pair.priceUsd).toPrecision(5));
      }
      if (fresh && pos.markSource !== pair.source) {
        if (pos.markSource || pos.priceStale) {
          state.remarks = (state.remarks || []).concat([{ symbol: pos.symbol, pairAddress: pos.pairAddress, before: pos.lastPrice == null ? null : pos.lastPrice, after: pair.priceUsd, source: pair.source, prevSource: pos.markSource || null, at: new Date().toISOString() }]).slice(-20);
          addActivity('PRICE ' + pos.symbol + ' marked from ' + pair.source + ': ' + (pos.lastPrice == null ? 'n/a' : Number(pos.lastPrice).toPrecision(5)) + ' -> ' + Number(pair.priceUsd).toPrecision(5));
        }
        pos.markSource = pair.source;
      }
      if (fresh) { pos.lastPrice = pair.priceUsd; pos.lastPricedAt = new Date().toISOString(); pos.priceStale = false; }
      else if (pos.pairAddress) {
        if (!pos.priceStale) addActivity('PRICE ' + pos.symbol + ': stored pool price unavailable, holding (retry next tick)');
        pos.priceStale = true;
      }
      const price = fresh ? pair.priceUsd : (pos.pairAddress ? (Number(pos.lastPrice) || pos.entryPrice) : pos.entryPrice);
      if (fresh && price > (pos.highest || 0)) pos.highest = price;
      // PR11 stock block: an open legacy position on a tokenised stock (TTWO, NIO, ...) is closed at the
      // fresh stored-pool price (legacy positions hold no token amount, so no Jupiter sell quote exists).
      const stockWhy = classifyBlocked({ mint: pos.mint, symbol: pos.symbol, name: pos.name });
      let exit = null;
      if (stockWhy && fresh) {
        exit = { reason: 'stock-block', fillPrice: price };
        state.stockClosures = (state.stockClosures || []).concat([{ symbol: pos.symbol, mint: pos.mint || null, strategyId: pos.strategyId, reason: stockWhy, price: price, priceSource: pair.source, at: new Date().toISOString() }]).slice(-20);
      } else if (stockWhy && !pos.stockWaitLogged) { pos.stockWaitLogged = true; addActivity('STOCK ' + pos.symbol + ' blocked (' + stockWhy + '), closing at the next fresh price'); }
      if (!exit) exit = shouldExit(pos, price, fresh || !pos.pairAddress);
      if (exit) {
        const pnl = computePnl(pos, exit.fillPrice);
        state.balance += pos.sizeSol + pnl;
        const trade = Object.assign({}, pos, { legacy: true, book: null, strategyVersion: (pos.strategyId || 'legacy') + ' legacy', exitReason: exit.reason, exitPrice: exit.fillPrice, exitPriceSource: pos.markSource || null, pnlSol: pnl, pnlPct: +((pnl / (pos.sizeSol || 1)) * 100).toFixed(3), closedAt: new Date().toISOString() });
        state.trades.unshift(trade);
        if (state.trades.length > 100) state.trades.pop();
        logTrade(trade);
        reentry.recordExit(state, trade, config);
        state.decisions.unshift(logDecision('EXIT', pos.symbol, exit.reason, { pnl: pnl.toFixed(4) }));
        addActivity('EXIT ' + pos.symbol + ' ' + exit.reason + ' pnl=' + pnl.toFixed(4));
      } else stillOpen.push(pos);
    }
    state.openPositions = stillOpen;
    reentry.prune(state);
    const labNotes = labStep(state, pairs);
    for (const note of labNotes) addActivity(note);
    const result = generateSignals(pairs) || { signals: [], rejections: [] };
    result.signals = (result.signals || []).filter(function (sig) {
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
      try { await newPools.maybeFetch(); gradRows = await newPools.candidateRows(pairs); } catch (e) { addActivity('New-pools feed error: ' + e.message); }
      await books.runEntries(state, pairs, async function (sig, row) {
        await poolPrice.prefetchMain([sig.mint]);
        return poolGate(sig, row.priceUsd, pairs.concat(gradRows));
      }, { 'graduation-sniper': gradRows }, function () { newPools.stats.candidatesPassed += 1; });
    } catch (e) { addActivity('Books entry error: ' + e.message); console.error(e); }
    if (state.decisions.length > 100) state.decisions = state.decisions.slice(0, 100);
  } catch (e) {
    addActivity('Tick error: ' + e.message);
    console.error(e);
  }
  state.lastUpdate = new Date().toISOString();
  state.fetchStats = fetchStats();
  try { saveState(state); } finally { ticking = false; }
}

// Night Shift dashboard (static page polling /api/dashboard + /api/equity); the previous server-rendered
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
    exitLoop: Object.assign({}, exitLoopStats),
    legacyTrades: state.trades || [],
    bookTrades: books.ensure(state).trades,
    trades: allTrades()
  });
});

let dashApiInst = null; // built lazily (exitLoopStats is declared further down)
function dashApi() { return dashApiInst || (dashApiInst = makeDashboardApi({ getState: function () { return state; }, config, books, equity, lockedSol, fetchStats, jupiterStats, mintAuth, exitLoopStats, booksLimiter, build: BUILD, startedAt: SERVER_STARTED_AT })); }
app.get('/api/dashboard', function (req, res) {
  res.set('Cache-Control', 'no-store');
  try { res.json(dashApi().payload()); } catch (e) { console.error('dashboard payload', e); res.status(500).json({ error: String(e.message || e) }); }
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

app.get('/api/books', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ build: BUILD, scoreboard: state.scoreboard || null, books: booksPayload(), openPositions: books.ensure(state).open, rejects: books.ensure(state).rejects, stockBlocks: books.ensure(state).stockBlocks, stockClosures: state.stockClosures || [], jupiterQuotes: jupiterStats(), mintAuthority: Object.assign({}, mintAuth.stats), exitLoop: Object.assign({}, exitLoopStats), trades: books.ensure(state).trades });
});

app.get('/api/health', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, build: BUILD, liveTrading: false, lastUpdate: state.lastUpdate, scoreboard: state.scoreboard || null, exitLoop: Object.assign({}, exitLoopStats), fetchStats: fetchStats(), jupiterQuotes: jupiterStats(), mintAuthority: Object.assign({}, mintAuth.stats) });
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

// PR11 exit loop for the books: re-quotes every open book position (Jupiter sell quote) then waits
// config.books.exitLoopMs, so stops are checked every few seconds instead of every 45 s scan.
const exitLoopStats = { passes: 0, errors: 0, lastPassAt: null, lastPassMs: null, lastError: null };
async function exitLoop() {
  const t0 = Date.now();
  try {
    const changed = await books.runExits(state);
    exitLoopStats.passes += 1;
    if (changed && !ticking) saveState(state);
  } catch (e) {
    exitLoopStats.errors += 1;
    exitLoopStats.lastError = String(e.message || e).slice(0, 120);
    console.error('books exit loop', e);
  }
  exitLoopStats.lastPassAt = new Date().toISOString();
  exitLoopStats.lastPassMs = Date.now() - t0;
}
function startExitLoop() {
  (async function loop() { await exitLoop(); setTimeout(loop, config.books.exitLoopMs); })();
}

function renderBooks() {
  const rows = books.report(state).map(function (b) {
    const cls = (b.profitPerTradeSol || 0) >= 0 ? 'win' : 'loss';
    return '<tr><td>' + b.label + '</td><td>' + b.progress + '</td><td>' + (b.winRatePct == null ? '-' : b.winRatePct + '%') + '</td><td class="' + cls + '">' + (b.profitPerTradeSol == null ? '-' : b.profitPerTradeSol.toFixed(5)) + '</td><td>' + (b.netWithoutBestSol == null ? '-' : b.netWithoutBestSol.toFixed(5)) + '</td><td>' + (b.worstLossPct == null ? '-' : b.worstLossPct + '%') + '</td><td>' + b.openPositions + '/' + b.maxOpen + '</td></tr>';
  }).join('');
  const sb = state.scoreboard || {};
  return '<section class="card" style="margin:12px auto;max-width:1180px;padding:12px"><h2 style="margin:0 0 6px">Books (paper, ' + config.books.sizeSol + ' SOL each, Jupiter-quoted fills)</h2><p class="mute">scoreboard ' + (sb.epoch || '') + ' since ' + (sb.since || '') + ' \u00b7 build ' + String(BUILD || 'local').slice(0, 7) + ' \u00b7 profit per trade after 1.1% costs</p>' +
    '<table style="width:100%;font-size:13px"><tr class="mute"><th align="left">book</th><th>trades</th><th>win</th><th>SOL/trade</th><th>net w/o best</th><th>worst</th><th>open</th></tr>' + rows + '</table></section>';
}

if (require.main === module) app.listen(config.port, function () {
  console.log('Dashboard running on port ' + config.port);
  tick();
  setInterval(tick, config.pollIntervalMs);
  startExitLoop();
  setTimeout(recordEquity, 5000);
  setInterval(recordEquity, 60000);
});

module.exports = { app, recordEquity, dashApi, tick, exitLoop, books, quotes, mintAuth, booksLimiter, resetScoreboard, getState: function () { return state; } };
