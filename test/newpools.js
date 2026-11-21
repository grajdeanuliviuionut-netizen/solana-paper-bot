// PR13 tests: GeckoTerminal new_pools feed (cap, no retries, 1 in flight, 10-min 429 pause, pump filter,
// graduation-sniper only) and the aggressive-flow pause. No network.
const assert = require('assert');
const config = require('../src/config');
const np = require('../src/newPools');
const E = require('../src/books/engine');
const { generateSignals } = require('../src/buyAgent');
const { review } = require('../src/manager');
const sellAgent = require('../src/sellAgent');
const reentry = require('../src/reentry');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;
let T = Date.parse('2026-11-21T19:20:00Z');
const pool = (mint, dex, agoMin, addr) => ({ id: 'solana_' + (addr || mint + 'P'), attributes: { address: addr || mint + 'P', pool_created_at: new Date(T - agoMin * MIN).toISOString() },
  relationships: { base_token: { data: { id: 'solana_' + mint } }, dex: { data: { id: dex } } } });
function setup(handler) {
  np._reset();
  const calls = [];
  np._setDeps({ now: () => T, http: { get: async url => { calls.push(url); return handler(calls.length); } } });
  return calls;
}

test('feed: at most one call per 150 s', async () => {
  const calls = setup(() => ({ status: 200, data: { data: [] } }));
  assert.strictEqual(await np.maybeFetch(), true);
  T += 60000; assert.strictEqual(await np.maybeFetch(), false);
  T += 89000; assert.strictEqual(await np.maybeFetch(), false);
  T += 1000; assert.strictEqual(await np.maybeFetch(), true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(np.stats.calls, 2);
  assert.ok(/networks\/solana\/new_pools$/.test(calls[0]));
});

test('feed: never more than one request in flight', async () => {
  let release;
  const calls = setup(() => new Promise(r => { release = () => r({ status: 200, data: { data: [] } }); }));
  const a = np.maybeFetch();
  T += 200000; // even past the interval, a second call must not start while the first is in flight
  const b = await np.maybeFetch();
  assert.strictEqual(b, false);
  release(); await a;
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(np.stats.maxInFlight, 1);
});

test('feed: no retries; a 429 pauses the feed for 10 minutes', async () => {
  const calls = setup(n => { const e = new Error('429'); e.response = { status: 429 }; throw e; });
  await np.maybeFetch();
  assert.strictEqual(calls.length, 1, 'no retry after 429');
  assert.strictEqual(np.stats.rateLimited, 1);
  assert.strictEqual(np.stats.retries, 0);
  T += 150000; await np.maybeFetch(); T += 300000; await np.maybeFetch();
  assert.strictEqual(calls.length, 1, 'paused for 10 min after a 429');
  T += 160000; await np.maybeFetch();
  assert.strictEqual(calls.length, 2, 'resumes after the pause');
  // a 500 is not retried either
  const c2 = setup(() => { const e = new Error('500'); e.response = { status: 500 }; throw e; });
  await np.maybeFetch();
  assert.strictEqual(c2.length, 1);
  assert.strictEqual(np.stats.failures, 1);
});

test('feed: keeps graduated pump.fun pools < 15 min old (pumpswap or ...pump mint), not bonding-curve pools', async () => {
  setup(() => ({ status: 200, data: { data: [pool('AAApump', 'pumpswap', 3), pool('BBBpump', 'pump-fun', 2), pool('CCCpump', 'raydium', 5), pool('DDD', 'meteora-damm-v2', 1), pool('EEEpump', 'pumpswap', 16)] } }));
  await np.maybeFetch();
  assert.deepStrictEqual(Array.from(np._watch.keys()).sort(), ['AAApump', 'CCCpump']);
  assert.strictEqual(np.stats.poolsSeen, 5);
  assert.strictEqual(np.stats.pumpfunUnder15m, 2);
});

test('feed rows go to the graduation sniper only, all other gates unchanged', async () => {
  const row = { pairAddress: 'GP', mint: 'NEWpump', symbol: 'NEW', name: 'New', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 40000, volumeH1: 50000, volumeM5: 30000, volumeH6: 50000,
    priceChange: { m5: 5, h1: 5, h6: 5, h24: 5 }, txns: { buys: 50, sells: 10 }, txnsM5: { buys: 30, sells: 10 }, pairCreatedAt: T - 5 * MIN, dexId: 'pumpswap', fetchedAt: T - 2000 };
  const quotes = { buyQuote: async (m, sol) => ({ ok: true, at: T, inAmount: String(sol * 1e9), outAmount: '10000000000', priceImpactPct: 0.3 }),
    sellQuote: async (m, raw) => ({ ok: true, at: T, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 4.95e-3)), priceImpactPct: 0.3 }) };
  const books = E.makeBooks({ config, quotes, mintAuth: { check: async () => ({ pass: true, reason: 'ok', decimals: 6, mintAuthority: null, freezeAuthority: null }) }, reentry, now: () => T });
  const state = { balance: 3, reentryCooldowns: {} };
  let passedExtra = 0;
  await books.runEntries(state, [], async () => ({ ok: true }), { 'graduation-sniper': [row] }, () => { passedExtra++; });
  assert.strictEqual(passedExtra, 1);
  assert.deepStrictEqual(state.books.open.map(p => p.book), ['graduation-sniper'], 'only the sniper sees feed rows');
  // the stock block still applies to feed rows
  const s2 = { balance: 3, reentryCooldowns: {} };
  await books.runEntries(s2, [], async () => ({ ok: true }), { 'graduation-sniper': [Object.assign({}, row, { symbol: 'TTWO', mint: 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo' })] });
  assert.strictEqual(s2.books.open.length, 0);
  assert.ok(/stock-block/.test(JSON.stringify(s2.books.rejects)));
  // a failed main-pool check still blocks
  const s3 = { balance: 3, reentryCooldowns: {} };
  await books.runEntries(s3, [], async () => ({ ok: false, reason: 'unverified' }), { 'graduation-sniper': [row] });
  assert.strictEqual(s3.books.open.length, 0);
});

test('aggressive-flow paused (Liviu t68u): no new AF signals, in pausedIds; others unpaused; open AF still exits', () => {
  const af = config.strategies.find(s => s.id === 'aggressive-flow');
  assert.strictEqual(af.paused, true);
  assert.deepStrictEqual(config.strategies.filter(s => s.paused).map(s => s.id), ['aggressive-flow']);
  const pair = { pairAddress: 'P', mint: 'M', symbol: 'X', priceUsd: 1, liquidityUsd: 50000, volumeH1: 20000, priceChange: { m5: 1, h1: 3, h6: 0, h24: 0 }, txns: { buys: 300, sells: 100 }, ageDays: 2 };
  const sig = generateSignals([pair]).signals;
  assert.ok(!sig.some(s => s.strategyId === 'aggressive-flow'), 'no AF signal');
  const state = { pausedIds: [], trades: [] };
  review(state, config);
  assert.deepStrictEqual(state.pausedIds, ['aggressive-flow']);
  const pos = { strategyId: 'aggressive-flow', entryPrice: 1, highest: 1, sizeSol: 0.05, entryTime: new Date(Date.now() - 60000).toISOString(), exit: af.exit };
  const ex = sellAgent.shouldExit(pos, 0.95, true);
  assert.ok(ex && ex.reason === 'sl', 'open AF position still exits under its rules');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} newpools tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
