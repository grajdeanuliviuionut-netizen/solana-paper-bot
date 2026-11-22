// Bots panel (Liviu t79u). Read-only: tracks when each runtime component last did work and derives a
// status from those REAL signals (nothing is hardcoded). No trading logic here.
//
// Agent bots -> runtime components:
//   manager    main loop / scheduler (tick every pollIntervalMs)
//   scanner    DexScreener scan + GeckoTerminal new_pools feed
//   rugCheck   RPC mint/freeze authority, stock block, RugCheck holders/LP, legacy rug check
//   strategist entry-rule evaluation across the books and the legacy strategies
//   executor   Jupiter quotes (entries) + the exit loop
//   logger     trades.jsonl appends + state.json writes
//
// Status: PAUSED if paused; STALE if alive signal older than 3x interval (or never seen after 3x interval of
// uptime); ERROR if >= 3 errors in 10 min and errors >= work events in 10 min; RUNNING if it did work in
// the last 2x interval; otherwise IDLE (alive, nothing to do).

const WINDOW_MS = 60 * 60 * 1000;

function makeTracker(nowFn) {
  const now = nowFn || Date.now;
  const c = {};
  function get(k) { return c[k] || (c[k] = { lastAt: null, lastWorkAt: null, events: [], errors: [], lastError: null, lastErrorAt: null, total: 0, errTotal: 0, counters: {} }); }
  function prune(e, t) { while (e.events.length && t - e.events[0][0] > WINDOW_MS) e.events.shift(); while (e.errors.length && t - e.errors[0] > WINDOW_MS) e.errors.shift(); }
  function beat(k) { const e = get(k); e.lastAt = now(); return e; }
  function work(k, n) { const t = now(); const e = get(k); e.lastAt = t; e.lastWorkAt = t; const v = n == null ? 1 : n; e.events.push([t, v]); e.total += v; prune(e, t); return e; }
  function error(k, msg) { const t = now(); const e = get(k); e.errors.push(t); e.errTotal += 1; e.lastError = String(msg || 'error').slice(0, 120); e.lastErrorAt = t; prune(e, t); return e; }
  // Records work (or errors) when a cumulative counter increases. The first sample only sets the baseline.
  function counter(k, key, value, kind) {
    const e = get(k);
    const v = Number(value) || 0;
    const prev = e.counters[key];
    e.counters[key] = v;
    if (prev == null || v <= prev) return 0;
    if (kind === 'error') { for (let i = 0; i < Math.min(v - prev, 20); i++) error(k, key + ' +' + (v - prev)); } else work(k, v - prev);
    return v - prev;
  }
  function sum(k, ms) { const e = get(k); const t = now(); let s = 0, n = 0; for (const [at, v] of e.events) if (t - at <= ms) { s += v; n += 1; } return { sum: s, events: n }; }
  function errs(k, ms) { const e = get(k); const t = now(); return e.errors.filter(at => t - at <= ms).length; }
  return { beat, work, error, counter, sum, errs, get, now, _c: c };
}

function statusFor(o) {
  const t = o.now;
  if (o.paused) return 'PAUSED';
  const iv = Math.max(1000, o.intervalMs || 0);
  if (!o.lastAt) return t - (o.startedAtMs || t) > 3 * iv ? 'STALE' : 'IDLE';
  if (t - o.lastAt > 3 * iv) return 'STALE';
  if (o.errors10m >= 3 && o.errors10m >= o.work10m) return 'ERROR';
  if (o.lastWorkAt && t - o.lastWorkAt <= 2 * iv) return 'RUNNING';
  return 'IDLE';
}
const TONE = { RUNNING: 'green', WATCHING: 'green', IDLE: 'grey', EMPTY: 'grey', PAUSED: 'amber', ERROR: 'red', STALE: 'red' };

const r = (v, d) => (v == null || !isFinite(v) ? null : +Number(v).toFixed(d == null ? 2 : d));
function ageSec(t, at) { return at ? r((t - at) / 1000, 1) : null; }
function iso(at) { return at ? new Date(at).toISOString() : null; }

// ctx: { tracker, now, startedAt, build, pollIntervalMs, exitLoop (view), fetchStats, mintAuthStats, holderStats,
//        legacyRug, stockBlocks, jupiterLimiter, rugcheckLimiter, newPools, entriesLastHour, tradesWritten,
//        tradesTotal, lastTradeAt, openCount, books (report list), legacy (rows), legacyOpenTotal, maxOpen, lastScan }
function buildBots(ctx) {
  const T = ctx.tracker;
  const t = ctx.now || T.now();
  const startedAtMs = Date.parse(ctx.startedAt) || t;
  const uptimeMin = Math.max(0.5, (t - startedAtMs) / 60000);
  const poll = ctx.pollIntervalMs || 45000;
  const el = ctx.exitLoop || {};
  const exitIv = Math.max(15000, (el.lastDelayMs || 0) + (el.lastPassMs || 0), ((el.passPeriodSec && el.passPeriodSec.median) || 0) * 1000);
  function agent(id, name, role, intervalMs, metric, extra) {
    const e = T.get(id);
    const w10 = T.sum(id, 600000).events, e10 = T.errs(id, 600000);
    const status = statusFor({ now: t, startedAtMs, lastAt: e.lastAt, lastWorkAt: e.lastWorkAt, intervalMs, errors10m: e10, work10m: w10, paused: extra && extra.paused });
    return Object.assign({ id, name, role, status, tone: TONE[status], intervalSec: r(intervalMs / 1000, 1),
      lastActivityAt: iso(e.lastAt), lastActivityAgeSec: ageSec(t, e.lastAt), lastWorkAt: iso(e.lastWorkAt), lastWorkAgeSec: ageSec(t, e.lastWorkAt),
      errors10m: e10, lastError: e.lastError, lastErrorAt: iso(e.lastErrorAt), metric }, extra || {});
  }
  const fs = ctx.fetchStats || {};
  const by = fs.byHost || {};
  const hostSum = (pred, k) => Object.keys(by).filter(pred).reduce((a, h) => a + (by[h][k] || 0), 0);
  const scan429 = hostSum(h => /dexscreener|geckoterminal/.test(h), 'rateLimited');
  const pairsWin = Math.min(10, uptimeMin);
  const pairsPerMin = r(T.sum('scanner', pairsWin * 60000).sum / pairsWin, 1);
  const np = ctx.newPools || {};
  const ma = ctx.mintAuthStats || {}, hc = ctx.holderStats || {}, lr = ctx.legacyRug || {};
  const passes = (ma.passed || 0) + (hc.passed || 0) + (lr.passed || 0);
  const rejects = (ma.rejected || 0) + (hc.rejected || 0) + (lr.rejected || 0);   // since restart (stock blocks are cumulative, shown apart)
  const rc429 = (ctx.rugcheckLimiter && ctx.rugcheckLimiter.http429) || 0;
  const jl = ctx.jupiterLimiter || {};
  const qWin = Math.min(10, uptimeMin);
  const quotesPerMin = r(T.sum('executor.quotes', qWin * 60000).sum / qWin, 1);
  const ci = (el.checkIntervalSec && el.checkIntervalSec.median);
  const cand1h = T.sum('strategist', WINDOW_MS).sum;
  const agents = [
    agent('manager', 'Manager', 'main loop / scheduler', poll, { label: 'uptime', value: uptimeMin >= 60 ? Math.floor(uptimeMin / 60) + 'h ' + Math.round(uptimeMin % 60) + 'm' : Math.round(uptimeMin) + 'm', sub: 'build ' + String(ctx.build || 'local').slice(0, 7) + ' · tick ' + Math.round(poll / 1000) + ' s' },
      { uptimeSec: Math.round(uptimeMin * 60), build: ctx.build || null, ticks: T.get('manager').total, lastTickMs: T.get('manager').lastTickMs || null }),
    agent('scanner', 'Scanner', 'DexScreener scan + GT new_pools', poll, { label: 'pairs/min', value: pairsPerMin, sub: '429s ' + scan429 + (ctx.newPoolsEnabled === false ? ' · new_pools off' : np.pausedUntil && Date.parse(np.pausedUntil) > t ? ' · new_pools paused' : ' · new_pools ' + (np.calls || 0) + ' calls') },
      { pairsPerMin, http429: scan429, lastPairs: T.get('scanner').lastPairs == null ? null : T.get('scanner').lastPairs, newPoolsCalls: np.calls || 0, newPoolsPausedUntil: np.pausedUntil || null }),
    agent('rugCheck', 'Rug Check', 'RPC mint/freeze · stock block · RugCheck holders/LP', poll, { label: 'pass / reject', value: passes + ' / ' + rejects, sub: 'since restart · stock blocks ' + ((ctx.stockBlocks && ctx.stockBlocks.count) || 0) + ' · RugCheck 429s ' + rc429 },
      { passes, rejects, mintAuthority: { checks: ma.checks || 0, passed: ma.passed || 0, rejected: ma.rejected || 0, errors: ma.errors || 0 }, holders: { checks: hc.checks || 0, passed: hc.passed || 0, rejected: hc.rejected || 0, errors: hc.errors || 0, http429: rc429 }, legacy: Object.assign({}, lr), stockBlocks: (ctx.stockBlocks && ctx.stockBlocks.count) || 0 }),
    agent('strategist', 'Strategist', 'entry rules · books + legacy', poll, { label: 'cand / entries 1h', value: cand1h + ' / ' + (ctx.entriesLastHour || 0), sub: (T.get('strategist').lastEval ? 'last eval ' + T.get('strategist').lastEval : 'no evaluation yet') },
      { candidatesLastHour: cand1h, entriesLastHour: ctx.entriesLastHour || 0, lastEval: T.get('strategist').lastEval || null }),
    agent('executor', 'Executor', 'Jupiter quotes · exit loop', exitIv, { label: 'quotes/min', value: quotesPerMin, sub: 'check ' + (ci == null ? '–' : ci + ' s') + ' · ' + (ctx.openCount || 0) + ' open · 429s ' + (jl.http429 || 0) },
      { quotesPerMin, checkIntervalSec: ci == null ? null : ci, openPositions: ctx.openCount || 0, http429: jl.http429 || 0, exitPasses: el.passes || 0, exitErrors: el.errors || 0 }),
    agent('logger', 'Logger', 'trades.jsonl + state.json', poll, { label: 'trades written', value: ctx.tradesWritten || 0, sub: (ctx.tradesTotal || 0) + ' closed in store' + (ctx.lastTradeAt ? ' · last ' + new Date(ctx.lastTradeAt).toISOString().slice(11, 16) + 'Z' : '') },
      { tradesWritten: ctx.tradesWritten || 0, tradesTotal: ctx.tradesTotal || 0, lastTradeAt: ctx.lastTradeAt || null, saves: T.get('logger').total })
  ];
  const strategies = [];
  for (const b of ctx.books || []) {
    const open = b.openPositions || 0;
    const st = b.paused ? 'PAUSED' : open > 0 ? 'RUNNING' : (ctx.lastScan ? 'WATCHING' : 'EMPTY');
    strategies.push({ kind: 'book', id: b.strategyId, name: b.name + ' v' + b.version, status: st, tone: TONE[st], open, maxOpen: b.maxOpen, trades: b.trades || 0, winRatePct: b.winRatePct == null ? null : b.winRatePct, netSol: b.netSol == null ? 0 : b.netSol });
  }
  for (const s of ctx.legacy || []) {
    const st = s.paused ? 'PAUSED' : s.open > 0 ? 'RUNNING' : (!ctx.lastLegacyScan || (ctx.legacyOpenTotal || 0) >= ctx.maxOpen) ? 'EMPTY' : 'WATCHING';
    strategies.push({ kind: 'legacy', id: s.id, name: s.name, status: st, tone: TONE[st], open: s.open, maxOpen: ctx.maxOpen, maxOpenShared: true, trades: s.trades || 0, winRatePct: s.winRatePct == null ? null : s.winRatePct, netSol: s.netSol == null ? 0 : s.netSol,
      note: s.paused ? 'paused (open trades still exit)' : st === 'EMPTY' ? ((ctx.legacyOpenTotal || 0) >= ctx.maxOpen ? 'shared slots full' : 'no scan yet') : null });
  }
  return { now: new Date(t).toISOString(), build: ctx.build || null, liveTrading: false, mode: 'paper', pause: ctx.pause || null,
    rules: 'RUNNING = did work in the last 2x interval; IDLE = alive, nothing to do; PAUSED = paused; ERROR = >=3 errors in 10 min (>= work); STALE = no activity for 3x interval. Strategies: RUNNING = open position, WATCHING = active and scanning, EMPTY = cannot enter now (shared slots full / no scan yet), PAUSED.',
    agents, strategies };
}

module.exports = { makeTracker, statusFor, buildBots, TONE };
