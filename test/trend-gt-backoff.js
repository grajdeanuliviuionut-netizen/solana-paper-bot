// trend-gt-backoff: own-history SMA stats + 60 min tick keep, GeckoTerminal 3 min cache /
// token-bucket / in-flight dedupe, 429 defers (not a final reject), maTooYoung vs maNoData,
// seed own ticks from a GT OHLCV window, cheap gates before GT. LIVE v6.03 config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-trend-gt-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const M15 = require('../src/books/m15');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
const NOW = Date.parse('2026-11-28T08:00:00Z');
const RH = () => config.books.list.find(b => b.id === 'runner-hunter');
const row = o => Object.assign({ pairAddress: 'PR5', mint: 'R5mint', symbol: 'RUN5', name: 'Run5', priceUsd: 0.0011, priceNative: 0.000005, liquidityUsd: 200000,
  volumeH1: 12000, volumeM5: 4000, volumeH6: 60000, volumeH24: 60000, priceChange: { m5: 2, h1: 10, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 30 * 3600000, dexId: 'raydium', fetchedAt: NOW - 5000, ageDays: 5 }, o || {});
const FEE = { microLamports: 3000, sol: 0.0000056, fallback: false, lamports: 5600 };
function risingTicks(t, minutes) {
  const s = [];
  for (let sec = minutes * 60; sec >= 0; sec -= 45) s.push([t - sec * 1000, 0.001 + (minutes * 60 - sec) * 1e-8]);
  return s;
}
function ohlcv(t, n, closeFn) {
  const list = [];
  for (let k = 0; k < n; k++) {
    const ts = Math.floor((t - k * MIN) / 1000);
    const c = closeFn ? closeFn(k) : 0.001 + (n - k) * 1e-6;
    list.push([ts, c, c, c, c, 5]);
  }
  return list;
}
function harness(o) {
  o = o || {};
  let t = o.now || NOW;
  const h = { mult: 1.0, fail: false, trades: [], top: o.top10 || { ok: true, top10Pct: 12, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' },
    sma: o.sma === undefined ? { ma: 0.001, maPrev: 0.00099, maSlopePct: 1.0101, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 30, spanMin: 50 } : o.sma,
    gtCalls: 0, equity: o.equity || 4 };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: String(Math.round(sol / 0.05 * 10000000000)), priceImpactPct: 0.5, route: 'Ray' }),
    sellQuote: async (mint, raw, bps) => h.fail ? { ok: false, error: 'timeout' } : ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * h.mult)), priceImpactPct: 0.4, route: 'Ray' })
  };
  const mintAuth = { check: async () => o.mintAuth || { pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' } };
  const top10 = { check: async () => { h.top10Calls = (h.top10Calls || 0) + 1; return h.top; } };
  const m15 = o.m15 || { stats: { ownHistory: 0, seeded: 0 }, gt: async () => ({ pct: 3, fromAgeMin: 15, source: 'geckoterminal-ohlcv-1m' }), smaGt: async () => { h.gtCalls++; return h.sma; }, lastOhlcv: o.lastOhlcv };
  const fees = { current: () => FEE };
  h.m15 = m15;
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, fees, random: () => 0.5, equityNow: () => h.equity, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() } };
  h.adv = ms => { t += ms; };
  h.now = () => t;
  h.enter = async r => { await h.books.runEntries(h.state, [r || row({ fetchedAt: t - 5000 })], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'runner-hunter' && (!r || p.mint === r.mint)); };
  h.f = () => (h.state.books.entryFilters['runner-hunter'] || {}).byFilter || {};
  return h;
}

test('smaFromTicks: 3 min gap fails closed; dense 45 s ticks still produce an SMA', () => {
  const o = RH().entry.trend;
  const dense = risingTicks(NOW, 60);
  const ok = M15.smaFromTicks(dense, NOW, o);
  assert.ok(ok && ok.source === 'own-history-1m' && ok.candles === 50);
  const gapped = dense.filter(([ts]) => !(ts < NOW - 10 * MIN && ts > NOW - 20 * MIN));
  assert.strictEqual(M15.smaFromTicks(gapped, NOW, o), null, 'a 10 min hole must not be filled by carrying a stale close');
});

test('pruneTicks keeps a series whose last tick is 25 min old (KEEP_MIN is 60, was 20)', () => {
  const ticks = { P: [[NOW - 55 * MIN, 1], [NOW - 25 * MIN, 1.1]] };
  M15.pruneTicks(ticks, NOW);
  assert.ok(ticks.P && ticks.P.length === 2, '25 min silence must not wipe a 50-min SMA series');
  const dead = { Q: [[NOW - 80 * MIN, 1], [NOW - 61 * MIN, 1]] };
  M15.pruneTicks(dead, NOW);
  assert.ok(!dead.Q, 'series older than 60 min still dropped');
});

test('mergeOhlcvTicks seeds own history; later smaFromTicks does not need GT', () => {
  const o = RH().entry.trend;
  const ticks = {};
  const added = M15.mergeOhlcvTicks(ticks, 'PR5', ohlcv(NOW, 60), NOW);
  assert.ok(added >= 50);
  const s = M15.smaFromTicks(ticks.PR5, NOW, o);
  assert.ok(s && s.source === 'own-history-1m');
  const cov = M15.coverageStats(ticks, NOW, 50);
  assert.strictEqual(cov.pools, 1); assert.strictEqual(cov.withPeriod, 1);
});

test('ownHistory counter increments when the cheap path uses own ticks (the previous 0 was a stats bug)', async () => {
  const h = harness();
  const ticks = risingTicks(NOW, 60);
  h.state.books = { ticks: { PR5: ticks } };
  // price well above the rising MA so the row can pass; we only care that ownHistory is counted
  await h.enter(row({ priceUsd: 0.002, fetchedAt: NOW - 5000 }));
  assert.ok(h.m15.stats.ownHistory >= 1, 'ownHistory ' + h.m15.stats.ownHistory);
});

test('GeckoTerminal 429/cooldown defers (maDeferred) and is not a final reject; retried next scan', async () => {
  const h = harness({ sma: { error: 'gecko in 429 cooldown', deferred: true } });
  assert.strictEqual(await h.enter(), undefined);
  assert.strictEqual(h.f().maDeferred, 1);
  assert.ok(!h.f().maUnavailable);
  const reasons = Object.keys((h.state.books.rejects && h.state.books.rejects.byReason) || {});
  assert.ok(!reasons.some(k => /maUnavailable|429 cooldown/.test(k)), reasons.join(','));
  h.sma = { ma: 0.001, maPrev: 0.00099, maSlopePct: 1.01, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 20 };
  h.adv(45000);
  assert.ok(await h.enter(row({ fetchedAt: h.now() - 5000 })), 'retried next scan after a defer');
});

test('maTooYoung vs maNoData: age < 50 min is flagged; older coins with no candles stay maNoData', async () => {
  let h = harness({ sma: null });
  assert.strictEqual(await h.enter(row({ pairCreatedAt: NOW - 20 * MIN, fetchedAt: NOW - 5000 })), undefined);
  assert.strictEqual(h.f().maTooYoung, 1); assert.ok(!h.f().maNoData);
  h = harness({ sma: null });
  assert.strictEqual(await h.enter(row({ pairCreatedAt: NOW - 5 * 3600000, fetchedAt: NOW - 5000 })), undefined);
  assert.strictEqual(h.f().maNoData, 1); assert.ok(!h.f().maTooYoung);
});

test('cheap gates run before GT: a top-10 fail does not spend a GeckoTerminal call', async () => {
  const h = harness({ top10: { ok: true, top10Pct: 40, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' } });
  assert.strictEqual(await h.enter(), undefined);
  assert.strictEqual(h.gtCalls, 0, 'GT must not run after a top-10 fail');
  assert.ok(h.f().top10 || h.state.books.rug.blacklist.R5mint);
});

test('makeM15: 3 min OHLCV cache, in-flight dedupe, token-bucket defer, no error cached as success', async () => {
  let calls = 0, block = false;
  const limiter = {
    get: async () => {
      calls++;
      if (block) { const e = new Error('gecko in 429 cooldown'); e.rateLimited = true; e.cooldown = true; throw e; }
      return { data: { data: { attributes: { ohlcv_list: ohlcv(NOW, 60) } } } };
    }
  };
  const m = M15.makeM15(limiter);
  const o = RH().entry.trend;
  const a = m.smaGt('PAIR', NOW, o);
  const b = m.smaGt('PAIR', NOW, o);
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra && ra.ma && ra.source === 'geckoterminal-ohlcv-1m');
  assert.strictEqual(ra.ma, rb.ma);
  assert.strictEqual(calls, 1, 'in-flight dedupe');
  assert.ok(m.stats.inFlightHits >= 1);
  assert.strictEqual(m.stats.gtCalls, 1);
  const cached = await m.smaGt('PAIR', NOW + 2 * MIN, o);
  assert.ok(cached && cached.ma); assert.strictEqual(calls, 1, 'cached inside 3 min');
  assert.ok(m.stats.cacheHits >= 1);
  block = true;
  const miss = await m.smaGt('PAIR', NOW + 4 * MIN, o);
  assert.ok(miss && miss.error && miss.deferred, JSON.stringify(miss));
  assert.strictEqual(m.stats.gtErrors, 1);
  // refill bucket exhaustion: burn tokens then the next call defers without hitting the limiter
  const burned = M15.makeM15(limiter);
  burned._bucket.tokens = 0; burned._bucket.last = NOW;
  const def = await burned.smaGt('OTHER', NOW, o);
  assert.ok(def && def.deferred && /token bucket/.test(def.error), JSON.stringify(def));
  assert.strictEqual(burned.stats.gtDeferred, 1);
  assert.strictEqual(burned.stats.gtCalls, 0, 'token-bucket defer is not a GT call');
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 8).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' trend-gt-backoff tests passed');
  if (passed !== tests.length) process.exit(1);
})();
