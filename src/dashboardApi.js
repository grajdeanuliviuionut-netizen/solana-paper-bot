// Read-only aggregation for the Night Shift dashboard (GET /api/dashboard). It only READS state and
// the existing stats objects; it never changes balances, positions, exits, sizes or limiters.
const fs = require('fs');
const path = require('path');
const LONDON = 'Europe/London';
const TRADES_FILE = process.env.TRADES_FILE || path.join(process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : './data', 'trades.jsonl');

// Realised PnL for today's London day from the append-only trades.jsonl (it keeps trades from before
// the scoreboard reset too). Cached on file size + mtime; null when the file can't be read.
let todayCache = { key: null, value: null };
function realizedTodayFromLog(today) {
  try {
    const st = fs.statSync(TRADES_FILE);
    const key = st.size + ':' + st.mtimeMs + ':' + today;
    if (todayCache.key === key) return todayCache.value;
    let sum = 0, n = 0;
    for (const line of fs.readFileSync(TRADES_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try { const t = JSON.parse(line); if (t.closedAt && londonDay(Date.parse(t.closedAt)) === today) { sum += Number(t.pnlSol) || 0; n++; } } catch (e) { /* skip */ }
    }
    todayCache = { key, value: { sum, n } };
    return todayCache.value;
  } catch (e) { return null; }
}

function londonDay(ms) {
  try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: LONDON }); } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function r(v, d) { return v == null || !Number.isFinite(v) ? null : +v.toFixed(d == null ? 6 : d); }

// Live mark of one open position. Book positions: remaining tokens valued at their last Jupiter sell
// quote; legacy positions: last stored-pool price vs entry. Missing data -> nulls (never invented).
function markOpen(pos, costPct, nowMs) {
  const isBook = !!pos.book && !pos.legacyOpen;
  const out = {
    id: pos.id, kind: isBook ? 'book' : 'legacy', book: pos.book || null,
    strategyId: pos.strategyId || pos.book || null, strategyName: pos.strategyName || pos.bookName || pos.strategyId || null,
    strategyVersion: pos.strategyVersion || (pos.strategyId ? pos.strategyId + ' legacy' : null),
    symbol: pos.symbol || null, name: pos.name || null, mint: pos.mint || null, pairAddress: pos.pairAddress || null,
    entryTime: pos.entryTime || null, entryPrice: num(pos.entryPrice), priceUnit: isBook ? (pos.entryPriceUnit || 'SOL/token') : 'USD',
    sizeSol: num(pos.sizeSol), exit: pos.exit || null, entryReason: pos.entryReason || null,
    markSource: pos.markSource || null, markAt: pos.markAt || pos.lastPricedAt || null, markAgeSec: null,
    pnlPct: null, netPnlPct: null, peakPct: null, valueSol: null, unrealizedSol: null,
    remainingFrac: num(pos.remainingFrac), costBasisSol: null, realizedSol: null,
    rugCheck: pos.rugCheck ? { pass: pos.rugCheck.pass, reason: pos.rugCheck.reason } : null,
    entryImpactPct: pos.entryQuote ? num(pos.entryQuote.priceImpactPct) : null,
    legs: (pos.legs || []).map(l => ({ reason: l.reason, at: l.at, sellPctOfOriginal: l.sellPctOfOriginal, solOut: l.solOut, pnlSol: l.pnlSol, fillSolPerToken: l.fillSolPerToken })),
    stale: !!pos.priceStale
  };
  if (out.markAt) out.markAgeSec = Math.max(0, Math.round((nowMs - Date.parse(out.markAt)) / 1000));
  if (isBook) {
    out.costBasisSol = num(pos.costBasisRemainingSol);
    out.pnlPct = num(pos.markPct);
    out.peakPct = num(pos.peakPct);
    out.realizedSol = r((pos.legs || []).reduce((a, l) => a + (Number(l.pnlSol) || 0), 0));
    if (pos.lastQuote && pos.lastQuote.outAmount != null) out.valueSol = r(Number(pos.lastQuote.outAmount) / 1e9);
    if (out.valueSol != null && out.costBasisSol != null) out.unrealizedSol = r(out.valueSol - out.costBasisSol * (1 + costPct / 100));
  } else {
    const e = num(pos.entryPrice), p = num(pos.lastPrice), s = num(pos.sizeSol);
    out.costBasisSol = s;
    if (e > 0 && p > 0) {
      out.pnlPct = r((p / e - 1) * 100, 3);
      if (num(pos.highest) > 0) out.peakPct = r((pos.highest / e - 1) * 100, 3);
      if (s != null) { out.valueSol = r(s * p / e); out.unrealizedSol = r(s * ((p / e - 1) - costPct / 100)); }
    }
  }
  if (out.pnlPct != null) out.netPnlPct = r(out.pnlPct - costPct, 3);
  return out;
}

function compactTrade(t) {
  return {
    id: t.id, book: t.book || null, legacy: !!t.legacy || !t.book, strategyId: t.strategyId || t.book || null,
    strategyName: t.strategyName || t.bookName || t.strategyId || null, strategyVersion: t.strategyVersion || null,
    symbol: t.symbol || null, mint: t.mint || null, entryTime: t.entryTime || null, closedAt: t.closedAt || null,
    entryPrice: num(t.entryPrice), exitPrice: num(t.exitPrice), priceUnit: t.book ? (t.entryPriceUnit || 'SOL/token') : 'USD',
    sizeSol: num(t.sizeSol), pnlSol: num(t.pnlSol), pnlPct: num(t.pnlPct), exitReason: t.exitReason || t.reason || null,
    entryReason: t.entryReason || null, holdMinutes: num(t.holdMinutes) != null ? num(t.holdMinutes) : (t.entryTime && t.closedAt ? r((Date.parse(t.closedAt) - Date.parse(t.entryTime)) / 60000, 2) : null),
    exitImpactPct: t.exitQuote ? num(t.exitQuote.priceImpactPct) : null, exitPriceSource: t.exitPriceSource || (t.exitQuote ? 'jupiter-sell-quote' : null),
    legs: (t.legs || []).map(l => ({ reason: l.reason, at: l.at, sellPctOfOriginal: l.sellPctOfOriginal, solOut: l.solOut, pnlSol: l.pnlSol, fillSolPerToken: l.fillSolPerToken }))
  };
}

// Same scoring as the book report: net after costs (pnlSol already includes the 1.1% round trip).
function scoreGroup(trades) {
  const n = trades.length;
  const pnl = trades.map(t => Number(t.pnlSol) || 0);
  const net = pnl.reduce((a, b) => a + b, 0);
  const best = n ? Math.max.apply(null, pnl) : null;
  const pcts = trades.map(t => num(t.pnlPct)).filter(v => v != null);
  return {
    trades: n, wins: pnl.filter(v => v > 0).length, winRatePct: n ? r((100 * pnl.filter(v => v > 0).length) / n, 1) : null,
    netSol: r(net), profitPerTradeSol: n ? r(net / n) : null, netWithoutBestSol: n ? r(net - best) : null,
    worstLossPct: pcts.length ? r(Math.min.apply(null, pcts), 2) : null
  };
}

function makeDashboardApi(deps) {
  // deps: getState, config, books, equity, lockedSol, fetchStats, jupiterStats, mintAuth, exitLoopStats, booksLimiter, build, startedAt
  function marks() {
    const state = deps.getState();
    const now = Date.now();
    const cost = deps.config.costRoundtripPct || 1.1;
    const legacy = (state.openPositions || []).map(p => markOpen(Object.assign({}, p, { legacyOpen: true }), cost, now));
    const bk = (deps.books.ensure(state).open || []).map(p => markOpen(p, cost, now));
    return legacy.concat(bk);
  }

  // Equity snapshot for equity.jsonl. markEquity = balance + live value of open positions (book
  // positions at their Jupiter sell quote, legacy at last pool price); a position without a mark
  // counts at cost so the curve never jumps on a missing quote.
  function snapshot() {
    const state = deps.getState();
    const open = marks();
    let markValue = 0, unmarked = 0;
    for (const p of open) {
      if (p.valueSol != null) markValue += p.valueSol;
      else { markValue += p.costBasisSol || p.sizeSol || 0; unmarked++; }
    }
    const balance = Number(state.balance) || 0;
    return { t: new Date().toISOString(), balance: r(balance), equity: r(deps.equity()), markEquity: r(balance + markValue), open: open.length, unmarked, epoch: state.scoreboard ? state.scoreboard.epoch : null, build: deps.build ? String(deps.build).slice(0, 7) : null };
  }

  function payload() {
    const state = deps.getState();
    const cfg = deps.config;
    const now = Date.now();
    const b = deps.books.ensure(state);
    const all = (b.trades || []).concat(state.trades || []).sort((x, y) => Date.parse(y.closedAt) - Date.parse(x.closedAt));
    const today = londonDay(now);
    const sb = state.scoreboard || null;
    const sinceMs = sb && sb.since ? Date.parse(sb.since) : 0;
    const inMem = all.filter(t => t.closedAt && londonDay(Date.parse(t.closedAt)) === today);
    const fromLog = realizedTodayFromLog(today);
    const useLog = fromLog && fromLog.n >= inMem.length;
    const realizedToday = useLog ? fromLog.sum : inMem.reduce((a, t) => a + (Number(t.pnlSol) || 0), 0);
    const tradesToday = useLog ? fromLog.n : inMem.length;
    const realizedSinceReset = all.filter(t => t.closedAt && Date.parse(t.closedAt) >= sinceMs).reduce((a, t) => a + (Number(t.pnlSol) || 0), 0);
    const snap = snapshot();
    const open = marks();
    const legacyIds = [];
    for (const t of state.trades || []) if (t.strategyId && legacyIds.indexOf(t.strategyId) < 0) legacyIds.push(t.strategyId);
    for (const p of state.openPositions || []) if (p.strategyId && legacyIds.indexOf(p.strategyId) < 0) legacyIds.push(p.strategyId);
    const legacyStrategies = legacyIds.map(id => {
      const ts = (state.trades || []).filter(t => t.strategyId === id);
      const s = (cfg.strategies || []).find(x => x.id === id) || {};
      return Object.assign({ strategyId: id, name: s.name || (ts[0] && ts[0].strategyName) || id, label: id + ' legacy', stratSizeMult: (state.stratSizeMult || {})[id] == null ? null : state.stratSizeMult[id], openPositions: (state.openPositions || []).filter(p => p.strategyId === id).length, paused: (state.pausedIds || []).indexOf(id) >= 0 }, scoreGroup(ts));
    });
    const rejects = b.rejects || {};
    return {
      now: new Date(now).toISOString(), build: deps.build || null, liveTrading: false, mode: 'paper',
      serverStartedAt: deps.startedAt, lastUpdate: state.lastUpdate || null,
      pollIntervalMs: cfg.pollIntervalMs, exitLoopMs: cfg.books ? cfg.books.exitLoopMs : null,
      startingSol: cfg.startingSol, costRoundtripPct: cfg.costRoundtripPct || 1.1,
      account: {
        balance: r(Number(state.balance) || 0), equity: r(deps.equity()), markEquity: snap.markEquity, lockedSol: r(deps.lockedSol()),
        realizedTodaySol: r(realizedToday), tradesToday, realizedTodaySource: useLog ? 'trades.jsonl' : 'state', londonDay: today,
        realizedSinceResetSol: r(realizedSinceReset),
        equityChangeSinceResetSol: sb && sb.startEquity != null ? r(snap.markEquity - sb.startEquity) : null,
        unrealizedSol: r(open.reduce((a, p) => a + (p.unrealizedSol || 0), 0)),
        openCount: open.length, tradesSinceReset: all.filter(t => Date.parse(t.closedAt) >= sinceMs).length
      },
      scoreboard: sb,
      books: deps.books.report(state).map(x => Object.assign({}, x, { open: undefined })),
      booksConfig: cfg.books ? { epoch: cfg.books.epoch, sizeSol: cfg.books.sizeSol, maxOpenPerBook: cfg.books.maxOpenPerBook, targetTrades: cfg.books.targetTrades, maxPriceAgeSec: cfg.books.maxPriceAgeSec } : null,
      legacyStrategies,
      openPositions: open,
      recentTrades: all.slice(0, 60).map(compactTrade),
      agents: {
        manager: { lastUpdate: state.lastUpdate || null, pollIntervalMs: cfg.pollIntervalMs, blockReason: state.blockReason || '', pausedIds: state.pausedIds || [], stratSizeMult: state.stratSizeMult || {}, maxOpen: cfg.maxOpen, legacyOpen: (state.openPositions || []).length, bookOpen: (b.open || []).length },
        scanner: deps.fetchStats(),
        rugCheck: { mintAuthority: Object.assign({}, deps.mintAuth.stats), stockBlocks: b.stockBlocks || null, rejectsByReason: rejects.byReason || {}, recentRejects: (rejects.recent || []).slice(0, 12), poolChecks: state.poolChecks ? { checked: state.poolChecks.checked, verified: state.poolChecks.verified, divergenceSkips: state.poolChecks.divergenceSkips, unverifiedSkips: state.poolChecks.unverifiedSkips } : null },
        strategist: { rejectsByBook: rejects.byBook || {}, entries: b.entries || null, recentDecisions: (state.decisions || []).slice(0, 12) },
        executor: { exitLoop: Object.assign({}, deps.exitLoopStats), jupiterQuotes: deps.jupiterStats(), booksLimiter: deps.booksLimiter ? deps.booksLimiter.stats() : null },
        logger: { tradesLogged: all.length, lastTradeAt: all[0] ? all[0].closedAt : null, lastSaveAt: state.lastUpdate || null, activity: (state.activity || []).slice(0, 15) }
      }
    };
  }
  return { payload, snapshot, marks };
}

module.exports = { makeDashboardApi, markOpen, scoreGroup, londonDay };

// ---- equity history (equity.jsonl on the data volume) ----
const equityLog = (function () {
// Dashboard equity history (read-only bookkeeping; no trading logic). One JSON line per snapshot in
// <data dir>/equity.jsonl (the Railway volume), written once a minute by index.js. Nothing here
// changes balances, positions, exits or sizes.

const DATA_DIR = process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : './data';
const FILE = process.env.EQUITY_FILE || path.join(DATA_DIR, 'equity.jsonl');
const MAX_POINTS = 20000; // ~2 weeks at 1/min; older lines stay in the file, only the read is capped

function append(point) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(point) + '\n');
    return true;
  } catch (e) {
    console.error('equity snapshot write failed', e.message);
    return false;
  }
}

// Reads snapshots with t >= sinceMs (ISO t), newest MAX_POINTS. Malformed lines are skipped.
function read(sinceMs) {
  let raw = '';
  try { if (fs.existsSync(FILE)) raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const p = JSON.parse(line);
      if (!p || !p.t) continue;
      if (sinceMs && Date.parse(p.t) < sinceMs) continue;
      out.push(p);
    } catch (e) { /* skip */ }
  }
  return out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out;
}

// Downsample to at most n points (keeps first and last).
function downsample(points, n) {
  if (!n || points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
  return out;
}

return { append, read, downsample, FILE };

})();
module.exports.equityLog = equityLog;
