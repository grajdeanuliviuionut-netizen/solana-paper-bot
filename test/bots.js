// Bots panel (t79u): status comes from real activity signals. No network.
const assert = require('assert');
const { makeTracker, statusFor, buildBots } = require('../src/bots');
let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const S = 1000;

test('statusFor: RUNNING / IDLE / PAUSED / STALE / ERROR from timestamps', () => {
  const now = 1e9, iv = 45 * S;
  assert.strictEqual(statusFor({ now, lastAt: now - 10 * S, lastWorkAt: now - 10 * S, intervalMs: iv, errors10m: 0, work10m: 5 }), 'RUNNING');
  assert.strictEqual(statusFor({ now, lastAt: now - 10 * S, lastWorkAt: now - 100 * S, intervalMs: iv, errors10m: 0, work10m: 0 }), 'IDLE');
  assert.strictEqual(statusFor({ now, lastAt: now - 10 * S, lastWorkAt: null, intervalMs: iv }), 'IDLE');
  assert.strictEqual(statusFor({ now, lastAt: now - 200 * S, lastWorkAt: now - 200 * S, intervalMs: iv }), 'STALE');
  assert.strictEqual(statusFor({ now, lastAt: null, startedAtMs: now - 10 * 60 * S, intervalMs: iv }), 'STALE');
  assert.strictEqual(statusFor({ now, lastAt: null, startedAtMs: now - 5 * S, intervalMs: iv }), 'IDLE');
  assert.strictEqual(statusFor({ now, lastAt: now - 1 * S, lastWorkAt: now - 1 * S, intervalMs: iv, errors10m: 4, work10m: 2 }), 'ERROR');
  assert.strictEqual(statusFor({ now, lastAt: now - 1 * S, lastWorkAt: now - 1 * S, intervalMs: iv, errors10m: 4, work10m: 20 }), 'RUNNING');
  assert.strictEqual(statusFor({ now, paused: true, lastAt: now, lastWorkAt: now, intervalMs: iv }), 'PAUSED');
});

test('tracker: counters record work only when they rise; windows sum', () => {
  let t = 1e9; const T = makeTracker(() => t);
  assert.strictEqual(T.counter('executor', 'q', 10), 0, 'baseline');
  t += 5 * S; assert.strictEqual(T.counter('executor', 'q', 13), 3);
  t += 5 * S; assert.strictEqual(T.counter('executor', 'q', 13), 0);
  assert.strictEqual(T.sum('executor', 60 * S).sum, 3);
  T.counter('executor', 'e', 0, 'error'); T.counter('executor', 'e', 2, 'error');
  assert.strictEqual(T.errs('executor', 60 * S), 2);
  t += 2 * 3600 * S; assert.strictEqual(T.sum('executor', 3600 * S).sum, 0, 'old events fall out of the window');
});

test('buildBots: six agents + strategy rows with real statuses and metrics', () => {
  let t = 1e12; const T = makeTracker(() => t);
  const start = new Date(t - 30 * 60 * S).toISOString();
  T.beat('manager'); T.work('manager');
  T.work('scanner', 70); T.work('scanner', 68);
  T.beat('rugCheck');                       // alive, no checks -> IDLE
  T.beat('strategist'); T.work('strategist', 3);
  T.beat('executor'); T.work('executor', 2); T.work('executor.quotes', 40);
  T.work('logger');
  const v = buildBots({ tracker: T, now: t, startedAt: start, build: 'abcdef123', pollIntervalMs: 45000, exitLoop: { lastDelayMs: 5000, lastPassMs: 2000, checkIntervalSec: { median: 6.1 }, passes: 10, errors: 0 },
    fetchStats: { byHost: { 'api.dexscreener.com': { rateLimited: 0 }, 'api.geckoterminal.com/new_pools': { rateLimited: 1 } } }, mintAuthStats: { passed: 4, rejected: 1 }, holderStats: { passed: 0, rejected: 2, requests: 3 },
    legacyRug: { checks: 2, passed: 2, rejected: 0 }, stockBlocks: { count: 1 }, jupiterLimiter: { http429: 0 }, rugcheckLimiter: { http429: 0 }, newPools: { calls: 4 },
    entriesLastHour: 2, tradesWritten: 3, tradesTotal: 50, openCount: 3,
    books: [{ strategyId: 'runner-hunter', name: 'Runner hunter', version: 1, openPositions: 2, maxOpen: 2, trades: 3, winRatePct: 33.3, netSol: -0.01 }, { strategyId: 'volume-explosion', name: 'Volume explosion', version: 1, openPositions: 0, maxOpen: 2, trades: 4, winRatePct: 25, netSol: -0.0085 }],
    legacy: [{ id: 'aggressive-flow', name: 'Aggressive flow scalp (legacy)', paused: true, open: 0, trades: 13 }, { id: 'dip-hold', name: 'Dip and hold (legacy)', paused: false, open: 0, trades: 11, winRatePct: 18.2, netSol: -0.03 }],
    legacyOpenTotal: 3, maxOpen: 4, lastScan: { at: 'x' }, lastLegacyScan: { at: 'x' } });
  const a = Object.fromEntries(v.agents.map(x => [x.id, x]));
  assert.deepStrictEqual(Object.keys(a), ['manager', 'scanner', 'rugCheck', 'strategist', 'executor', 'logger']);
  assert.strictEqual(a.manager.status, 'RUNNING'); assert.strictEqual(a.scanner.status, 'RUNNING'); assert.strictEqual(a.rugCheck.status, 'IDLE');
  assert.strictEqual(a.strategist.status, 'RUNNING'); assert.strictEqual(a.executor.status, 'RUNNING'); assert.strictEqual(a.logger.status, 'RUNNING');
  assert.strictEqual(a.scanner.pairsPerMin, 13.8); assert.strictEqual(a.scanner.http429, 1);
  assert.strictEqual(a.rugCheck.passes, 6); assert.strictEqual(a.rugCheck.rejects, 4);
  assert.strictEqual(a.strategist.candidatesLastHour, 3); assert.strictEqual(a.strategist.entriesLastHour, 2);
  assert.strictEqual(a.executor.quotesPerMin, 4); assert.strictEqual(a.executor.checkIntervalSec, 6.1);
  assert.strictEqual(a.logger.tradesWritten, 3);
  assert.ok(a.manager.metric.sub.includes('abcdef1'));
  for (const x of v.agents) for (const k of ['status', 'tone', 'lastActivityAgeSec', 'metric']) assert.ok(k in x, x.id + '.' + k);
  const s = Object.fromEntries(v.strategies.map(x => [x.id, x]));
  assert.strictEqual(s['runner-hunter'].status, 'RUNNING'); assert.strictEqual(s['volume-explosion'].status, 'WATCHING');
  assert.strictEqual(s['aggressive-flow'].status, 'PAUSED'); assert.strictEqual(s['dip-hold'].status, 'WATCHING');
  // executor goes STALE when the exit loop stops, manager STALE when ticks stop
  t += 10 * 60 * S;
  const v2 = buildBots({ tracker: T, now: t, startedAt: start, pollIntervalMs: 45000, exitLoop: { lastDelayMs: 5000, lastPassMs: 2000 }, legacy: [{ id: 'dip-hold', name: 'd', open: 0 }], legacyOpenTotal: 4, maxOpen: 4, lastLegacyScan: { at: 'x' } });
  const b = Object.fromEntries(v2.agents.map(x => [x.id, x]));
  assert.strictEqual(b.manager.status, 'STALE'); assert.strictEqual(b.executor.status, 'STALE');
  assert.strictEqual(v2.strategies[0].status, 'EMPTY', 'shared slots full');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} bots tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
