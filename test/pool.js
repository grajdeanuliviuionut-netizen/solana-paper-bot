// PR7 tests: stored-pool pricing, >5% main-pool divergence skip, unpaused books at half size. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-pool-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const { sizeFor, review } = require('../src/manager');
const hb = require('../src/httpBackoff');
const poolPrice = require('../src/poolPrice');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;
const FJK9 = 'FJk9sajdc2Q4heRPPu3yLzkmf2ZByZkpiHQLv9e2bn5A'; // FLOAT main pool (stored on the position)
const D6Y = '5D6YvjigZaStjPhvehtXj7Xx8DNRGtJAuwgMv1br8k7M';  // other FLOAT pool
const FLOAT_MINT = 'Bv1a7cEj5aRnJQhMw4kRQqAFesMSd5LwcDnUzq52BMmr';
const gtRow = (addr, mint, price, liq) => ({ attributes: { address: addr, name: 'X / SOL', base_token_price_usd: String(price), reserve_in_usd: String(liq) }, relationships: { base_token: { data: { id: 'solana_' + mint } } } });

// Fake GeckoTerminal: /pools/multi and /tokens/{mint}/pools answered from `gt`.
const gt = { pools: {}, tokenPools: {}, calls: [] };
hb._reset();
hb._setDeps({ sleep: async () => {}, now: () => Date.now(), opts: { minGapMs: 0 }, http: { get: async url => {
  gt.calls.push(url);
  let m = url.match(/\/pools\/multi\/(.+)$/);
  if (m) return { data: { data: m[1].split(',').filter(a => gt.pools[a]).map(a => gt.pools[a]) } };
  m = url.match(/\/tokens\/([^/]+)\/pools/);
  if (m) return { data: { data: gt.tokenPools[m[1]] || [] } };
  return { data: { data: [] } };
} } });

let scanPairs = [];
const scannerPath = require.resolve('../src/agents/scanner');
require.cache[scannerPath] = { id: scannerPath, filename: scannerPath, loaded: true, exports: { scan: async () => scanPairs } };
// dip-hold pair passing every entry rule
const dipPair = (sym, pool, mint, price, liq) => ({ pairAddress: pool, mint, symbol: sym, priceUsd: price, liquidityUsd: liq || 100000, volumeH1: 20000, priceChange: { m5: 1, h1: -6, h6: 0, h24: 0 }, txns: { buys: 200, sells: 100 }, ageDays: 5 });
// a pair no strategy buys (keeps the entry side quiet)
const quietPair = (pool, mint, price, liq) => ({ pairAddress: pool, mint, symbol: 'FLOAT', priceUsd: price, liquidityUsd: liq || 100000, volumeH1: 0, priceChange: { m5: -9, h1: 30, h6: 0, h24: 0 }, txns: { buys: 1, sells: 100 }, ageDays: 5 });

fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ balance: 2.9, openPositions: [], trades: [], activity: [], decisions: [], paperReset: 'work-1' }));
const idx = require('../src/index');
const st = idx.getState();
const floatPos = () => ({ id: 1, strategyId: 'dip-hold', strategyName: 'Dip and hold', symbol: 'FLOAT', pairAddress: FJK9, mint: FLOAT_MINT, entryPrice: 0.002591, sizeSol: 0.1216, entryTime: new Date(Date.now() - 20 * MIN).toISOString(), exit: config.strategies.find(s => s.id === 'dip-hold').exit, highest: 0.002727, lastPrice: 0.002727 });
const reset = () => { st.openPositions = []; st.trades = []; st.reentryCooldowns = {}; st.poolChecks = undefined; st.remarks = []; st.balance = 2.9; st.coolUntil = 0; st.riskResetAt = Date.now(); gt.pools = {}; gt.tokenPools = {}; gt.calls = []; poolPrice._clearCache(); };

test('stored-pool pricing: FLOAT marked only from its stored pool FJk9 (fetched by address), never from the other FLOAT pool in the scan; first tick re-marks', async () => {
  reset();
  st.openPositions = [floatPos()];
  scanPairs = [quietPair(D6Y, FLOAT_MINT, 0.00259, 121000)]; // only the OTHER pool is in the scan
  gt.pools[FJK9] = gtRow(FJK9, FLOAT_MINT, 0.0028, 315000);
  await idx.tick();
  const p = st.openPositions.find(x => x.symbol === 'FLOAT');
  assert.ok(p, 'still open');
  assert.strictEqual(p.lastPrice, 0.0028, 'mark from stored pool');
  assert.strictEqual(p.highest, 0.0028, 'high-water mark rebuilt from the stored pool');
  assert.ok(p.storedPoolPriced);
  assert.ok(gt.calls.some(u => u.includes('/pools/multi/' + FJK9)));
  assert.ok(!gt.calls.some(u => u.includes(D6Y)));
  assert.deepStrictEqual(st.remarks.map(r => [r.symbol, r.before, r.after]), [['FLOAT', 0.002727, 0.0028]]);
});

test('stored-pool pricing: the close fill uses the stored pool price (sl at FJk9 price, not the other pool)', async () => {
  reset();
  st.openPositions = [Object.assign(floatPos(), { storedPoolPriced: 'x' })];
  scanPairs = [quietPair(D6Y, FLOAT_MINT, 0.0030, 121000), quietPair(FJK9, FLOAT_MINT, 0.0024, 315000)];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0);
  assert.strictEqual(st.trades[0].exitReason, 'sl');
  assert.strictEqual(st.trades[0].exitPrice, 0.0024);
  assert.strictEqual(st.trades[0].pairAddress, FJK9);
});

test('stored pool price unavailable: hold and retry next tick (no exit off another pool), time exit still fires', async () => {
  reset();
  st.openPositions = [Object.assign(floatPos(), { storedPoolPriced: 'x' })];
  scanPairs = [quietPair(D6Y, FLOAT_MINT, 0.0010, 121000)]; // other pool crashed -60%: must be ignored
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1, 'held');
  assert.strictEqual(st.openPositions[0].priceStale, true);
  assert.strictEqual(st.openPositions[0].lastPrice, 0.002727, 'mark unchanged');
  // past max hold while stale and under water -> time-stale exit at the last stored-pool mark
  st.openPositions[0].entryTime = new Date(Date.now() - 95 * MIN).toISOString();
  st.openPositions[0].lastPrice = 0.0025;
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0);
  assert.strictEqual(st.trades[0].exitReason, 'time-stale');
  assert.strictEqual(st.trades[0].exitPrice, 0.0025);
});

test('entry: chosen pool >5% off the main pool (highest liquidity) -> buy skipped and counted; <=5% -> bought on the chosen pool', async () => {
  reset();
  const MINT = 'MINT_DIV';
  scanPairs = [dipPair('DIV', 'POOL_SMALL', MINT, 0.0026, 60000)];
  gt.tokenPools[MINT] = [gtRow('POOL_SMALL', MINT, 0.0026, 60000), gtRow('POOL_MAIN', MINT, 0.0031, 331000)];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0, 'skipped: ' + JSON.stringify(st.openPositions.map(p => [p.symbol, p.strategyId, p.pairAddress])));
  assert.strictEqual(st.poolChecks.divergenceSkips, 1);
  const s = st.poolChecks.lastSkips[0];
  assert.strictEqual(s.mainPool, 'POOL_MAIN');
  assert.ok(Math.abs(s.gapPct - 16.13) < 0.01, String(s.gapPct));
  assert.ok(st.activity.some(a => /SKIP DIV pool price 16\.1% off main pool/.test(a.msg)));
  // within 5%
  reset();
  const M2 = 'MINT_OK';
  scanPairs = [dipPair('OKK', 'POOL_A', M2, 0.00300, 80000)];
  gt.tokenPools[M2] = [gtRow('POOL_A', M2, 0.00300, 80000), gtRow('POOL_B', M2, 0.00310, 300000)];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1);
  assert.strictEqual(st.openPositions[0].pairAddress, 'POOL_A');
  assert.strictEqual(st.openPositions[0].entryPrice, 0.003);
  assert.strictEqual(st.poolChecks.divergenceSkips, 0);
});

test('divergencePct and main pool: base token must be the mint; highest liquidity wins', async () => {
  poolPrice._clearCache();
  assert.ok(Math.abs(poolPrice.divergencePct(0.002591, 0.0031) - 16.42) < 0.01);
  assert.strictEqual(poolPrice.divergencePct(0, 1), null);
  gt.tokenPools.MX = [gtRow('P1', 'MX', 1, 100), gtRow('P2', 'OTHER', 9, 1e9), gtRow('P3', 'MX', 1.02, 500)];
  const r = await poolPrice.mainPoolFor('MX', []);
  assert.strictEqual(r.pool.pairAddress, 'P3'); assert.strictEqual(r.verified, true);
});

test('unpaused books: the other four are paused:false at half size (config sizeMult 0.5, no stacking with the manager cut, floor 0.02); dip-hold unchanged', () => {
  for (const id of ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn']) {
    const s = config.strategies.find(x => x.id === id);
    assert.strictEqual(s.paused, false, id); assert.strictEqual(s.sizeMult, 0.5, id);
    assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: {} }, config, id), 0.12, id);
    assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: { [id]: 0.5 } }, config, id), 0.12, id + ' no stacking');
    assert.strictEqual(sizeFor(0.05, { sizeMult: 0.5, stratSizeMult: {} }, config, id), 0.02, id + ' floor');
  }
  assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: {} }, config, 'dip-hold'), 0.24);
  const state = { pausedIds: ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn'], trades: [] };
  const r = review(state, config);
  assert.deepStrictEqual(state.pausedIds, []);
  assert.strictEqual(r.notes.filter(n => /MANAGER unpause/.test(n)).length, 4);
});

test('slot reserve: with maxOpen 4, the other books cannot take the last slot reserved for dip-hold; dip-hold signals go first', async () => {
  assert.strictEqual(config.maxOpen, 4); assert.deepStrictEqual(config.slotReserve, { 'dip-hold': 1 });
  reset();
  st.openPositions = [1, 2, 3].map(i => ({ id: i, strategyId: 'aggressive-flow', symbol: 'AF' + i, pairAddress: 'AFPOOL' + i, entryPrice: 1, sizeSol: 0.1, entryTime: new Date().toISOString(), highest: 1, exit: { takeProfitPct: 99, stopLossPct: 99, maxHoldMinutes: 999 }, storedPoolPriced: 'x' }));
  const afPair = i => ({ pairAddress: 'AFPOOL' + i, mint: 'AFM' + i, symbol: 'AF' + i, priceUsd: 1, liquidityUsd: 100000, volumeH1: 0, priceChange: { m5: -9, h1: 30 }, txns: { buys: 1, sells: 100 }, ageDays: 5 });
  // a fresh AF candidate (passes aggressive-flow rules) and a dip-hold candidate
  const afNew = { pairAddress: 'AFNEW', mint: 'AFNEWM', symbol: 'AFN', priceUsd: 1, liquidityUsd: 100000, volumeH1: 50000, priceChange: { m5: 0, h1: 20 }, txns: { buys: 100, sells: 100 }, ageDays: 5 };
  scanPairs = [1, 2, 3].map(afPair).concat([afNew, dipPair('DIP', 'DIPPOOL', 'DIPM', 0.5)]);
  await idx.tick();
  const ids = st.openPositions.map(p => p.strategyId);
  assert.strictEqual(st.openPositions.length, 4);
  assert.ok(ids.includes('dip-hold'), JSON.stringify(ids));
  assert.ok(!st.openPositions.some(p => p.pairAddress === 'AFNEW'));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} pool tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
