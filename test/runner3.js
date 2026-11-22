// t86u (Liviu 22 Nov 12:12): runner-hunter v3 entries (Phantom-bot filters), 24 h stop cooldown, 4-loss guardrail,
// and the Manager's continuous improvement loop. Runs on the LIVE config. No network: quotes/RPC/GT are mocked.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-runner3-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const m15Mod = require('../src/books/m15');
const top10Mod = require('../src/books/top10');
const improver = require('../src/improver');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
const NOW = Date.parse('2026-11-22T13:00:00Z');
const RH = () => config.books.list.find(b => b.id === 'runner-hunter');
const row = o => Object.assign({ pairAddress: 'PR3', mint: 'R3mint', symbol: 'RUN3', name: 'Run3', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 200000,
  volumeH1: 20000, volumeM5: 1000, volumeH6: 60000, volumeH24: 60000, priceChange: { m5: 2, h1: 10, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 30 * 3600000, dexId: 'raydium', fetchedAt: NOW - 5000, ageDays: 5 }, o || {});
const pc = o => Object.assign({ m5: 2, h1: 10, h6: 10, h24: 20 }, o);
const sellAt = mult => (raw, t) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * mult)), priceImpactPct: 0.4, route: 'Ray' });
function harness(o) {
  o = o || {};
  let t = NOW; const h = { mult: 1.0, trades: [], gtCalls: 0, topCalls: 0 };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: 0.5, route: 'Ray' }),
    sellQuote: async (mint, raw) => sellAt(h.mult)(BigInt(raw), t)
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'ok', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const top10 = { check: async () => { h.topCalls++; return o.top10 || { ok: true, top10Pct: 18, maxHolderPct: 4, excludedPct: 20 }; } };
  const m15 = { gt: async () => { h.gtCalls++; return o.gt === undefined ? { pct: 3, fromAgeMin: 15, source: 'geckoterminal-ohlcv-1m' } : o.gt; } };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v3', since: new Date(NOW - MIN).toISOString() } };
  h.adv = ms => { t += ms; };
  h.now = () => t;
  h.enter = async r => { await h.books.runEntries(h.state, [r || row({ fetchedAt: t - 5000 })], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'runner-hunter'); };
  h.pass = async (mult, ms) => { h.mult = mult; h.adv(ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  return h;
}
const why = (r, ctx) => E.entryFails(RH(), r, Object.assign({ now: NOW, snaps: {}, ticks: {} }, ctx || {}));

test('live config: runner-hunter v3 entry, v2 exits unchanged, v2+v1 in previousVersions, epoch runner-v3, Manager on', () => {
  const rh = RH();
  assert.deepStrictEqual(config.onlyStrategies, ['runner-hunter']);
  assert.strictEqual(config.books.epoch, 'runner-v3');
  assert.strictEqual(rh.version, 3);
  assert.deepStrictEqual(rh.entry, { minLiquidityUsd: 100000, maxLiquidityUsd: 900000, minVolumeToLiquidityH24: 0.1, minM5: 0, minM15: 0, maxH1: 25, maxTop10Pct: 30, stopCooldownHours: 24, lossStreakPause: { losses: 4, minutes: 30 } });
  assert.deepStrictEqual(rh.exit, { stopLossPct: 6, partial: { atPct: 8, sellPct: 33.3333 }, trailAfterPartial: true, trailPct: 8, maxHoldMinutes: 240 });
  assert.deepStrictEqual(rh.previousVersions.map(v => v.version), [2, 1]);
  assert.deepStrictEqual(rh.previousVersions[0].exit, rh.exit);
  assert.strictEqual(config.manager.enabled, true);
  assert.ok(config.books.exitLoopMs <= 10000 && config.books.maxExitQuoteAgeSec <= 10);
  assert.strictEqual(config.books.sizeSol, 0.05);
});

test('v3 rule filters: liquidity 100k-900k, 24h vol >= 0.1x liq, h1 <= 25, m5 > 0, m15 > 0 from own history', () => {
  assert.strictEqual(why(row()), null);
  assert.match(why(row({ liquidityUsd: 99999 })), /^liquidityMin:/);
  assert.match(why(row({ liquidityUsd: 900001, volumeH24: 1e6 })), /^liquidityMax:/);
  assert.strictEqual(why(row({ liquidityUsd: 900000, volumeH24: 90000 })), null, 'edges inclusive');
  assert.match(why(row({ volumeH24: 19999 })), /^vol24Liq:/);
  assert.match(why(row({ priceChange: pc({ h1: 25.1 }) })), /^h1Max:/);
  assert.strictEqual(why(row({ priceChange: pc({ h1: 25 }) })), null);
  assert.match(why(row({ priceChange: pc({ m5: 0 }) })), /^m5:/);
  assert.match(why(row({ priceChange: pc({ m5: -1 }) })), /^m5:/);
  // own price history: 15 min ago 0.00102 -> now 0.001 = falling
  const ticks = { PR3: [[NOW - 15 * MIN, 0.00102]] };
  assert.match(why(row(), { ticks }), /^m15:/);
  assert.strictEqual(why(row(), { ticks: { PR3: [[NOW - 15 * MIN, 0.00098]] } }), null);
  assert.strictEqual(why(row(), { ticks: { PR3: [[NOW - 5 * MIN, 0.002]] } }), null, 'no 15-min point -> GT fallback in runEntries');
  // v2 rules untouched when the v2 entry is in force
  const v2 = Object.assign({}, RH(), RH().previousVersions[0]);
  assert.strictEqual(E.entryFails(v2, row({ liquidityUsd: 2e6, volumeH1: 3e5 }), { now: NOW, snaps: {} }), null);
});

test('m15 methods: own ticks (12.5-17.5 min point), GeckoTerminal 1m OHLCV, stale/no data -> null', () => {
  const ticks = {};
  for (let i = 0; i <= 20; i++) m15Mod.recordTick(ticks, { pairAddress: 'P', priceUsd: 1 + i / 100 }, NOW - (20 - i) * MIN);
  const m = m15Mod.m15FromTicks(ticks.P, 1.2, NOW);
  assert.strictEqual(m.source, 'own-history'); assert.strictEqual(m.fromAgeMin, 15); assert.ok(Math.abs(m.pct - (1.2 / 1.05 - 1) * 100) < 1e-9);
  assert.ok(ticks.P.length <= 21 && NOW - ticks.P[0][0] <= 20 * MIN);
  const s = NOW / 1000;
  const list = []; for (let i = 0; i < 20; i++) list.push([s - 30 - i * 60, 1, 1, 1, 2 - i * 0.01, 10]);
  const g = m15Mod.m15FromOhlcv(list, NOW);
  assert.strictEqual(g.source, 'geckoterminal-ohlcv-1m'); assert.strictEqual(g.fromAgeMin, 15); assert.ok(g.pct > 0);
  assert.strictEqual(m15Mod.m15FromOhlcv(list.map(r => [r[0] - 600].concat(r.slice(1))), NOW), null, 'latest candle > 3 min old');
  assert.strictEqual(m15Mod.m15FromOhlcv(list.slice(0, 5), NOW), null, 'no candle ~15 min back');
  assert.strictEqual(m15Mod.m15FromOhlcv([], NOW), null);
});

test('top10: per-owner sum, pool/AMM authority and burn excluded, fail closed on missing data or RPC error', async () => {
  const acc = [
    { address: 'v1', uiAmount: 400, owner: Object.keys(top10Mod.AMM_AUTHORITIES)[0] }, { address: 'v2', uiAmount: 100, owner: 'PoolPair' },
    { address: 'b', uiAmount: 50, owner: [...top10Mod.BURN][0] }, { address: 'w1', uiAmount: 60, owner: 'W1' }, { address: 'w1b', uiAmount: 20, owner: 'W1' },
    { address: 'w2', uiAmount: 40, owner: 'W2' }
  ];
  const r = top10Mod.evaluate(1000, acc, 'PoolPair');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.top10Pct, 12); assert.strictEqual(r.maxHolderPct, 8); assert.strictEqual(r.maxHolderOwner, 'W1');
  assert.strictEqual(r.excludedPct, 55);
  assert.strictEqual(top10Mod.evaluate(0, acc, 'x').ok, false);
  assert.strictEqual(top10Mod.evaluate(1000, [{ address: 'a', uiAmount: 1, owner: null }], 'x').ok, false);
  let calls = 0;
  const lim = { post: async (b, u, body) => { calls++; assert.strictEqual(b, 'top10rpc'); throw new Error('429 https://rpc.example/key'); } };
  const t10 = top10Mod.makeTop10(lim);
  const e = await t10.check('M', 'P', NOW);
  assert.strictEqual(e.ok, false); assert.ok(!/rpc\.example/.test(e.error), 'url redacted');
  await t10.check('M', 'P', NOW + 60000); assert.strictEqual(calls, 1, 'error cached 2 min');
  const ok = { getTokenSupply: { value: { uiAmountString: '1000' } }, getTokenLargestAccounts: { value: acc.map(a => ({ address: a.address, uiAmountString: String(a.uiAmount) })) },
    getMultipleAccounts: { value: acc.map(a => ({ data: { parsed: { info: { owner: a.owner } } } })) } };
  const t2 = top10Mod.makeTop10({ post: async (b, u, body) => ({ data: { result: ok[body.method] } }) });
  const g = await t2.check('M', 'PoolPair', NOW);
  assert.strictEqual(g.ok, true); assert.strictEqual(g.top10Pct, 12);
  await t2.check('M', 'PoolPair', NOW + 9 * MIN); assert.strictEqual(t2.stats.cacheHits, 1);
});

test('runEntries v3: GT m15 fallback + top10 gate, fail closed; counters per filter; signal stores m15/top10', async () => {
  let h = harness({ gt: null });
  assert.strictEqual(await h.enter(), undefined, 'no 15-min data -> no entry');
  assert.strictEqual(h.state.books.entryFilters['runner-hunter'].byFilter['m15NoData'], 1);
  h = harness({ gt: { pct: -1, fromAgeMin: 15, source: 'geckoterminal-ohlcv-1m' } });
  assert.strictEqual(await h.enter(), undefined, 'GT falling -> no entry');
  h = harness({ top10: { ok: false, reason: 'top10: rpc error' } });
  assert.strictEqual(await h.enter(), undefined, 'top10 unavailable -> no entry');
  assert.strictEqual(h.state.books.entryFilters['runner-hunter'].byFilter['top10Unavailable'], 1);
  h = harness({ top10: { ok: true, top10Pct: 31, maxHolderPct: 9, excludedPct: 10 } });
  assert.strictEqual(await h.enter(), undefined, 'top10 31% -> no entry');
  h = harness();
  await h.books.runEntries(h.state, [row({ liquidityUsd: 50000 }), row({ mint: 'X2', pairAddress: 'P2', priceChange: pc({ h1: 40 }) }), row({ mint: 'X3', pairAddress: 'P3', volumeH24: 100 })], async () => ({ ok: true }));
  const f = h.state.books.entryFilters['runner-hunter'];
  assert.deepStrictEqual(f.byFilter, { liquidityMin: 1, h1Max: 1, vol24Liq: 1 });
  assert.strictEqual(f.evaluated, 3); assert.strictEqual(f.epoch, 'runner-v3');
  const pos = await h.enter();
  assert.ok(pos, 'all filters pass -> entry');
  assert.strictEqual(pos.entrySignal.m15, 3); assert.strictEqual(pos.entrySignal.m15Source, 'geckoterminal-ohlcv-1m');
  assert.strictEqual(pos.entrySignal.top10Pct, 18); assert.strictEqual(pos.entrySignal.volumeToLiquidityH24, 0.3);
  assert.strictEqual(pos.bookVersion, 3); assert.deepStrictEqual(pos.exit, RH().exit);
  assert.strictEqual(h.state.books.entryFilters['runner-hunter'].entered, 1);
  const rep = h.books.report(h.state).find(b => b.strategyId === 'runner-hunter');
  assert.ok(rep.entryFilters && rep.guardrail && rep.epochStats);
});

test('stop-out -> same coin blocked 24 h (stopCooldown24h, persisted); exits unchanged: -6% stop, 1/3 at +8%, trail 8%', async () => {
  const h = harness();
  let pos = await h.enter();
  await h.pass(0.95); assert.ok(h.state.books.open.length === 1, '-5% holds');
  await h.pass(0.939);
  assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.ok(h.trades[0].stopFill && h.trades[0].stopFill.stopLevelPct === -6 && Number.isFinite(h.trades[0].stopFill.actualFillPct), 'stop level vs actual fill logged');
  const sc = h.state.stopCooldowns['mint:R3mint'];
  assert.strictEqual(sc.reason, 'stopCooldown24h'); assert.strictEqual(Date.parse(sc.until) - h.now(), 24 * 3600000);
  h.adv(50 * MIN);   // past the 45-min re-entry cooldown
  assert.strictEqual(await h.enter(), undefined, 'blocked after the 45 min re-entry cooldown too');
  assert.ok((h.state.books.rejects.byReason || {}).stopCooldown24h >= 1);
  h.adv(24 * 3600000);
  pos = await h.enter(); assert.ok(pos, 'free after 24 h');
  await h.pass(1.0801);
  assert.ok(pos.partialDone); assert.ok(Math.abs(pos.remainingFrac - 2 / 3) < 1e-5);
  await h.pass(1.2); await h.pass(1.2 * 0.919);
  assert.strictEqual(h.trades[1].exitReason, 'trail');
  assert.ok(!h.state.stopCooldowns['mint:R3mint'] || Date.parse(h.state.stopCooldowns['mint:R3mint'].until) <= h.now(), 'a trail exit sets no cooldown');
});

test('guardrail: 4 runner losses in a row -> no new entries for 30 min, then auto-resume; a win resets the streak', async () => {
  const h = harness();
  const lose = async (i) => { const p = await h.enter(row({ mint: 'L' + i, pairAddress: 'LP' + i, fetchedAt: h.now() - 5000 })); assert.ok(p, 'entry ' + i); await h.pass(0.93); };
  await lose(1); await lose(2); await lose(3);
  assert.strictEqual(h.books.guard(h.state).streak['runner-hunter'], 3);
  let p = await h.enter(row({ mint: 'W', pairAddress: 'WP', fetchedAt: h.now() - 5000 })); await h.pass(1.05); h.adv(241 * MIN); await h.pass(1.05);
  assert.ok(h.trades[3].pnlSol > 0); assert.strictEqual(h.books.guard(h.state).streak['runner-hunter'], 0, 'win resets');
  for (let i = 4; i <= 7; i++) await lose(i);
  const g = h.books.guard(h.state);
  assert.strictEqual(g.pauses.length, 1); assert.strictEqual(g.pauses[0].streak, 4);
  assert.strictEqual(Date.parse(g.pausedUntil['runner-hunter']) - h.now(), 30 * MIN);
  assert.strictEqual(await h.enter(row({ mint: 'N1', pairAddress: 'NP1', fetchedAt: h.now() - 5000 })), undefined, 'paused');
  h.adv(29 * MIN);
  assert.strictEqual(await h.enter(row({ mint: 'N2', pairAddress: 'NP2', fetchedAt: h.now() - 5000 })), undefined, 'still paused at 29 min');
  h.adv(2 * MIN);
  assert.ok(await h.enter(row({ mint: 'N3', pairAddress: 'NP3', fetchedAt: h.now() - 5000 })), 'resumes after 30 min');
  assert.ok(h.state.books.entryFilters['runner-hunter'].byFilter.lossStreakPause >= 2);
});

const T = (i, o) => Object.assign({ id: 'T' + i, book: 'runner-hunter', bookVersion: 3, closedAt: new Date(NOW + i * MIN).toISOString(), pnlSol: 0.001, pnlPct: 2, exitReason: 'trail', holdMinutes: 60, legs: [], entrySignal: { h1: 5, top10Pct: 15 } }, o || {});
function mstate(trades) { return { scoreboard: { epoch: 'runner-v3', since: new Date(NOW - MIN).toISOString() }, books: { trades: trades.slice().reverse() } }; }
const cloneRH = () => JSON.parse(JSON.stringify(RH()));

test('Manager: one bounded change per 10 trades, logged with what/why, new version, old kept; healthy -> no change; restore at boot', () => {
  const book = cloneRH();
  const losers = []; for (let i = 1; i <= 10; i++) losers.push(T(i, { pnlSol: -0.003, pnlPct: -6.5, exitReason: 'sl', holdMinutes: 5, stopFill: { overshootPct: -0.5 } }));
  const st = mstate(losers.slice(0, 9));
  assert.strictEqual(improver.step(st, book, { baseVersion: 3, now: NOW }), null, '9 trades: no review');
  st.books.trades.unshift(losers[9]);
  const e = improver.step(st, book, { baseVersion: 3, now: NOW });
  assert.strictEqual(e.tradeIndex, 10); assert.strictEqual(e.rule, 'R2'); assert.strictEqual(e.change, 'entry.minM5');
  assert.strictEqual(e.from, 0); assert.strictEqual(e.to, 0.5); assert.ok(e.why.length > 10); assert.strictEqual(e.stats.winRatePct, 0);
  assert.strictEqual(book.version, 3.01); assert.strictEqual(book.entry.minM5, 0.5); assert.strictEqual(book.previousVersions[0].version, 3);
  assert.strictEqual(book.previousVersions[0].entry.minM5, 0);
  assert.deepStrictEqual(book.exit, RH().exit, 'exactly one knob changed');
  assert.strictEqual(improver.step(st, book, { baseVersion: 3, now: NOW }), null, 'same 10 trades are not reviewed twice');
  // healthy block -> R9
  for (let i = 11; i <= 20; i++) st.books.trades.unshift(T(i, { pnlSol: i % 2 ? 0.004 : -0.002 }));
  const e2 = improver.step(st, book, { baseVersion: 3, now: NOW });
  assert.strictEqual(e2.rule, 'R9'); assert.strictEqual(e2.change, null); assert.strictEqual(book.version, 3.01);
  assert.strictEqual(st.manager.log.length, 2); assert.strictEqual(st.manager.log[0].tradeIndex, 20);
  // v2 leftovers closing in the v3 epoch do not count
  st.books.trades.unshift(T(21, { bookVersion: 2 }));
  improver.step(st, book, { baseVersion: 3, now: NOW }); assert.strictEqual(st.manager.closedTrades, 20);
  // boot restore only on the same code version
  const fresh = cloneRH();
  assert.strictEqual(improver.restore(st, fresh, 3), true); assert.strictEqual(fresh.version, 3.01); assert.strictEqual(fresh.entry.minM5, 0.5);
  const other = cloneRH(); assert.strictEqual(improver.restore(st, other, 4), false); assert.strictEqual(other.version, 3);
});

test('Manager bounds: never past a bound, falls through to the next rule; rules cover only whitelisted paper knobs', () => {
  const p = { entry: Object.assign({}, RH().entry, { minM5: 3 }), exit: Object.assign({}, RH().exit, { stopLossPct: 8 }) };
  const s = { trades: 10, winRatePct: 0, netSol: -0.03, stops: 10, fastStops: 10, avgStopOvershootPct: -0.5, trails: 0, timeExits: 0, partials: 0 };
  const d = improver.decide(s, p);
  assert.strictEqual(d.rule, 'R8'); assert.strictEqual(d.to, 0.15);
  p.entry.minVolumeToLiquidityH24 = 0.5;
  assert.strictEqual(improver.decide(s, p).knob, null, 'everything at bounds -> no change');
  assert.strictEqual(improver.decide(Object.assign({}, s, { avgStopOvershootPct: -3 }), p).knob, 'entry.minLiquidityUsd');
  for (const k of Object.keys(improver.BOUNDS)) assert.ok(/^(entry|exit)\./.test(k) && !/size|wallet|key|live/i.test(k));
  const b = improver.BOUNDS;
  assert.ok(b['exit.stopLossPct'].max <= 8 && b['entry.maxTop10Pct'].max <= 30 && b['entry.minLiquidityUsd'].min >= 100000);
});

test('Manager reports every 30 trades: win rate, avg win, avg loss, net (+ net without best, worst loss)', () => {
  const book = cloneRH();
  const tr = []; for (let i = 1; i <= 31; i++) tr.push(T(i, { pnlSol: i % 3 === 0 ? 0.006 : -0.002, pnlPct: i % 3 === 0 ? 12 : -4 }));
  const st = mstate(tr);
  for (let k = 0; k < 4; k++) improver.step(st, book, { baseVersion: 3, now: NOW });
  assert.strictEqual(st.manager.reports.length, 1);
  const r = st.manager.reports[0];
  assert.strictEqual(r.trades, 30); assert.strictEqual(r.fromTrade, 1); assert.strictEqual(r.toTrade, 30);
  assert.ok(Math.abs(r.winRatePct - 33.3) < 0.1); assert.strictEqual(r.avgWinSol, 0.006); assert.strictEqual(r.avgLossSol, -0.002);
  assert.ok(Math.abs(r.netSol - (10 * 0.006 - 20 * 0.002)) < 1e-9); assert.ok(Math.abs(r.netWithoutBestSol - (r.netSol - 0.006)) < 1e-9); assert.strictEqual(r.worstLossPct, -4);
  assert.strictEqual(st.manager.log.length, 3, 'three 10-trade reviews');
  assert.ok(st.manager.log.filter(e => e.change).length <= 3);
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' runner3 tests passed');
  if (passed !== tests.length) process.exit(1);
})();
