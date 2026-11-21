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

// Fake DexScreener /tokens/v1 on the main-pool limiter: gt.ds[mint] = [{ pairAddress, price, liq }].
// PR9: the same limiter also answers DexScreener /latest/dex/pairs (pair prices): gt.dsPairs[addr] = { price, liq }
// or, by default, any pool listed in gt.ds; gt.dsNoPairs = true -> pair lookup returns nothing.
gt.ds = {}; gt.dsCalls = []; gt.ds429 = false; gt.dsPairs = {}; gt.dsPairCalls = []; gt.dsNoPairs = false;
poolPrice.mainLimiter._setDeps({ sleep: async () => {}, now: () => Date.now(), opts: { minGapMs: 0 }, http: { get: async url => {
  if (gt.ds429) throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } });
  if (/\/latest\/dex\/pairs\//.test(url)) {
    gt.dsPairCalls.push(url);
    if (gt.dsNoPairs) return { data: { pairs: [] } };
    const pairs = [];
    for (const a of url.split('/').pop().split(',')) {
      let p = gt.dsPairs[a];
      if (!p) for (const list of Object.values(gt.ds)) for (const x of list) if (x.pairAddress === a) p = x;
      if (p) pairs.push({ chainId: 'solana', pairAddress: a, priceUsd: String(p.price), liquidity: { usd: p.liq } });
    }
    return { data: { pairs } };
  }
  gt.dsCalls.push(url);
  const mints = url.split('/').pop().split(',');
  const rows = [];
  for (const m of mints) for (const p of gt.ds[m] || []) rows.push({ chainId: 'solana', pairAddress: p.pairAddress, baseToken: { address: m }, priceUsd: String(p.price), liquidity: { usd: p.liq } });
  return { data: rows };
} } });

let scanPairs = [];
const scannerPath = require.resolve('../src/agents/scanner');
require.cache[scannerPath] = { id: scannerPath, filename: scannerPath, loaded: true, exports: { scan: async () => scanPairs } };
// dip-hold pair passing every entry rule
const dipPair = (sym, pool, mint, price, liq) => ({ pairAddress: pool, mint, symbol: sym, priceUsd: price, liquidityUsd: liq || 100000, volumeH1: 20000, priceChange: { m5: 1, h1: -6, h6: 0, h24: 0 }, txns: { buys: 200, sells: 100 }, ageDays: 5 });
// a pair no strategy buys (keeps the entry side quiet)
const quietPair = (pool, mint, price, liq) => ({ pairAddress: pool, mint, symbol: 'FLOAT', priceUsd: price, liquidityUsd: liq || 100000, volumeH1: 0, priceChange: { m5: -9, h1: 30, h6: 0, h24: 0 }, txns: { buys: 1, sells: 100 }, ageDays: 5 });

fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ balance: 2.9, openPositions: [], trades: [], activity: [], decisions: [], paperReset: 'work-1' }));
// PR13: the new_pools feed never touches the network in tests.
require('../src/newPools')._setDeps({ http: { get: async () => ({ status: 200, data: { data: [] } }) } });
const idx = require('../src/index');
const st = idx.getState();
const floatPos = () => ({ id: 1, strategyId: 'dip-hold', strategyName: 'Dip and hold', symbol: 'FLOAT', pairAddress: FJK9, mint: FLOAT_MINT, entryPrice: 0.002591, sizeSol: 0.1216, entryTime: new Date(Date.now() - 20 * MIN).toISOString(), exit: config.strategies.find(s => s.id === 'dip-hold').exit, highest: 0.002727, lastPrice: 0.002727 });
const reset = () => { st.openPositions = []; st.trades = []; st.reentryCooldowns = {}; st.poolChecks = undefined; st.remarks = []; st.balance = 2.9; st.coolUntil = 0; st.riskResetAt = Date.now(); gt.pools = {}; gt.tokenPools = {}; gt.calls = []; gt.ds = {}; gt.dsCalls = []; gt.ds429 = false; gt.dsPairs = {}; gt.dsPairCalls = []; gt.dsNoPairs = false; poolPrice._clearCache(); };

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

test('entry: chosen pool >5% off the main pool (highest liquidity, slow DexScreener path) -> skipped as divergence; <=5% -> bought on the chosen pool', async () => {
  reset();
  const MINT = 'MINT_DIV';
  scanPairs = [dipPair('DIV', 'POOL_SMALL', MINT, 0.0026, 60000)];
  gt.ds[MINT] = [{ pairAddress: 'POOL_SMALL', price: 0.0026, liq: 60000 }, { pairAddress: 'POOL_MAIN', price: 0.0031, liq: 331000 }];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0, 'skipped');
  assert.strictEqual(st.poolChecks.divergenceSkips, 1);
  const s = st.poolChecks.lastSkips[0];
  assert.strictEqual(s.reason, 'divergence'); assert.strictEqual(s.mainPool, 'POOL_MAIN');
  assert.ok(Math.abs(s.gapPct - 16.13) < 0.01, String(s.gapPct));
  assert.ok(st.activity.some(a => /SKIP DIV pool price 16\.1% off main pool/.test(a.msg)));
  assert.strictEqual(gt.dsCalls.length, 1, 'one batched main-pool lookup');
  reset();
  const M2 = 'MINT_OK';
  scanPairs = [dipPair('OKK', 'POOL_A', M2, 0.00300, 80000)];
  gt.ds[M2] = [{ pairAddress: 'POOL_A', price: 0.00301, liq: 80000 }, { pairAddress: 'POOL_B', price: 0.00310, liq: 300000 }];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1);
  assert.strictEqual(st.openPositions[0].pairAddress, 'POOL_A');
  assert.strictEqual(st.openPositions[0].entryPrice, 0.00301, 'PR9: fill from DexScreener by pair address');
  assert.strictEqual(st.openPositions[0].entryPriceSource, 'dexscreener');
  assert.strictEqual(st.poolChecks.verified, 1);
  assert.deepStrictEqual(st.poolChecks.bySource, { dexscreener: 1 });
  assert.strictEqual(st.poolChecks.lastVerified[0].mainSource, 'dexscreener');
  assert.ok(Math.abs(st.poolChecks.lastVerified[0].gapPct - 2.9) < 0.01, 'main pool differs -> 5% rule applied');
  assert.strictEqual(st.poolChecks.divergenceSkips, 0);
});

test('fail closed: DexScreener 429 or token unknown to the lookup -> no buy (noPrice/unverified); the 429 cools only the DexScreener path, not the scan', async () => {
  reset();
  scanPairs = [dipPair('UNV', 'POOL_U', 'MINT_U', 0.002, 90000)];
  gt.ds429 = true;
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0);
  assert.strictEqual(st.poolChecks.noPriceSkips, 1, 'no DexScreener fill price -> skip');
  assert.strictEqual(st.poolChecks.verified, 0);
  assert.strictEqual(poolPrice.mainLimiter.stats.rateLimited, 1);
  assert.strictEqual(hb.stats.skipped, 0, 'scan limiter not in cooldown');
  await assert.doesNotReject(hb.get('scan-url'));
  // token unknown to the lookup -> also unverified
  reset();
  scanPairs = [dipPair('UNK', 'POOL_K', 'MINT_K', 0.002, 90000)];
  gt.dsPairs.POOL_K = { price: 0.002, liq: 90000 }; // pair priced, but the token lookup does not know the mint
  await idx.tick();
  assert.strictEqual(st.poolChecks.unverifiedSkips, 1);
  assert.strictEqual(st.poolChecks.lastSkips[0].reason, 'unverified');
  assert.strictEqual(st.openPositions.length, 0);
});

test('FIONA: entry fill comes from the same fresh stored-pool source as the marks (stale cached scan row ignored), first mark = entry, no phantom TP', async () => {
  reset();
  const fiona = Object.assign(dipPair('FIONA', 'DjbLtX', 'MINT_FIONA', 0.000778, 90000), { stale: true }); // row from a cached 429 page
  scanPairs = [fiona];
  gt.pools.DjbLtX = gtRow('DjbLtX', 'MINT_FIONA', 0.000958, 90000);
  gt.ds.MINT_FIONA = [{ pairAddress: 'DjbLtX', price: 0.000955, liq: 90000 }];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1);
  const p = st.openPositions[0];
  assert.strictEqual(p.entryPrice, 0.000955, 'fill priced from DexScreener by pair, not the stale 0.000778');
  assert.strictEqual(p.lastPrice, 0.000955); assert.strictEqual(p.entryPriceSource, 'dexscreener');
  assert.strictEqual(p.pairAddress, 'DjbLtX');
  // next tick: the scan row (GT 0.000958) is back, but marks stay on the entry source (DexScreener)
  scanPairs = [Object.assign({}, fiona, { stale: false, priceUsd: 0.000958 })];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1);
  assert.strictEqual(st.openPositions[0].lastPrice, 0.000955, 'same source as the entry');
  assert.strictEqual(st.openPositions[0].markSource, 'dexscreener');
  assert.ok(!gt.calls.some(u => u.includes('/pools/multi/DjbLtX')), 'never GT for a DexScreener-entered position');
  assert.strictEqual(st.trades.length, 0);
});

test('no fresh stored-pool price for the candidate (stale row, pool fetch empty) -> skip, counted as noPriceSkips', async () => {
  reset();
  scanPairs = [Object.assign(dipPair('STL', 'POOL_S', 'MINT_S', 0.002, 90000), { stale: true })];
  gt.ds.MINT_S = [{ pairAddress: 'POOL_S', price: 0.002, liq: 90000 }];
  gt.dsNoPairs = true;
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0);
  assert.strictEqual(st.poolChecks.noPriceSkips, 1);
});

test('main pool cache: price 60 s; only the DexScreener lookup verifies (scan rows never do)', async () => {
  poolPrice._clearCache();
  gt.ds = { MX: [{ pairAddress: 'P1', price: 1, liq: 100 }, { pairAddress: 'P3', price: 1.02, liq: 500 }], MY: [] };
  gt.dsCalls = [];
  const t0 = Date.now();
  assert.strictEqual(await poolPrice.prefetchMain(['MX', 'MY'], t0), 1);
  let r = poolPrice.mainPoolFor('MX', [], t0 + 1000);
  assert.strictEqual(r.pool.pairAddress, 'P3'); assert.strictEqual(r.verified, true); assert.strictEqual(r.source, 'dexscreener');
  assert.strictEqual(poolPrice.mainPoolFor('MY', [], t0).verified, false);
  // price older than 60 s -> unverified, even when the scan has the main pool or a bigger pool (PR9)
  assert.strictEqual(poolPrice.mainPoolFor('MX', [], t0 + 61000).verified, false);
  assert.strictEqual(poolPrice.mainPoolFor('MX', [{ pairAddress: 'P3', mint: 'MX', priceUsd: 1.05, liquidityUsd: 500 }], t0 + 10 * MIN).verified, false);
  assert.strictEqual(poolPrice.mainPoolFor('MX', [{ pairAddress: 'P9', mint: 'MX', priceUsd: 1.05, liquidityUsd: 9e6 }], t0 + 10 * MIN).verified, false);
  assert.strictEqual(poolPrice.mainPoolFor('MZ', [{ pairAddress: 'PZ', mint: 'MZ', priceUsd: 1, liquidityUsd: 9e6 }], t0).verified, false);
  // cached price still fresh -> no new request
  await poolPrice.prefetchMain(['MX'], t0 + 30000);
  assert.strictEqual(gt.dsCalls.length, 1);
  assert.ok(Math.abs(poolPrice.divergencePct(0.002591, 0.0031) - 16.42) < 0.01);
  assert.strictEqual(poolPrice.divergencePct(0, 1), null);
});

test('unpaused books: momentum/dip-buyers/buyer-turn at half size, aggressive-flow at quarter size (PR9), no stacking, floor 0.02; dip-hold unchanged', () => {
  const af = config.strategies.find(x => x.id === 'aggressive-flow');
  assert.strictEqual(af.paused, true, 'PR13: AF paused (Liviu t68u)'); assert.strictEqual(af.sizeMult, 0.25);
  assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: {} }, config, 'aggressive-flow'), 0.06);
  assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: { 'aggressive-flow': 0.5 } }, config, 'aggressive-flow'), 0.06, 'no stacking');
  assert.strictEqual(sizeFor(0.05, { sizeMult: 1, stratSizeMult: {} }, config, 'aggressive-flow'), 0.02, 'floor 0.02');
  for (const id of ['momentum-entry', 'dip-buyers', 'buyer-turn']) {
    const s = config.strategies.find(x => x.id === id);
    assert.strictEqual(s.paused, false, id); assert.strictEqual(s.sizeMult, 0.5, id);
    assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: {} }, config, id), 0.12, id);
    assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: { [id]: 0.5 } }, config, id), 0.12, id + ' no stacking');
    assert.strictEqual(sizeFor(0.05, { sizeMult: 0.5, stratSizeMult: {} }, config, id), 0.02, id + ' floor');
  }
  assert.strictEqual(sizeFor(0.24, { sizeMult: 1, stratSizeMult: {} }, config, 'dip-hold'), 0.24);
  const state = { pausedIds: ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn'], trades: [] };
  const r = review(state, config);
  assert.deepStrictEqual(state.pausedIds, ['aggressive-flow'], 'PR13: only AF stays paused');
  assert.strictEqual(r.notes.filter(n => /MANAGER unpause/.test(n)).length, 3);
  assert.strictEqual(state.stratSizeMult['dip-buyers'], 0.5, 'dip-buyers stratSizeMult 0.5');
  for (const id of ['momentum-entry', 'buyer-turn']) assert.strictEqual(state.stratSizeMult[id], 0.5, id);
  assert.strictEqual(state.stratSizeMult['aggressive-flow'], 0.25, 'aggressive-flow stratSizeMult 0.25');
  assert.strictEqual(state.stratSizeMult['dip-hold'], 1);
});

test('PR9 off-scan pricing: HPD-like position (stored pool not in the scan, stuck) is re-marked from DexScreener by pair address on the next tick and its TP fires', async () => {
  reset();
  const hpd = { id: 7, strategyId: 'aggressive-flow', strategyName: 'Aggressive flow scalp', symbol: 'HPD', pairAddress: 'HPDPOOL', mint: 'HPDM', entryPrice: 0.0000133, sizeSol: 0.113, entryTime: new Date(Date.now() - 14 * MIN).toISOString(), exit: config.strategies.find(s => s.id === 'aggressive-flow').exit, highest: 0.0000133, lastPrice: 0.0000133, storedPoolPriced: 'x', entryPriceSource: 'scan', priceStale: true };
  st.openPositions = [hpd];
  scanPairs = [];
  hb._setDeps({ opts: { hostCooldownMs: 30000 } });
  gt.dsPairs.HPDPOOL = { price: 0.0000141, liq: 50000 }; // +6%: above aggressive-flow TP
  await idx.tick();
  assert.ok(gt.dsPairCalls.some(u => u.includes('HPDPOOL')), 'priced through DexScreener pairs');
  assert.ok(!gt.calls.some(u => u.includes('/pools/multi/HPDPOOL')), 'not GeckoTerminal behind the scan cooldown');
  assert.strictEqual(st.openPositions.length, 0, 'TP fired');
  assert.strictEqual(st.trades[0].exitReason, 'tp'); assert.strictEqual(st.trades[0].exitPrice, 0.0000141);
  const r = st.remarks[st.remarks.length - 1];
  assert.deepStrictEqual([r.symbol, r.before, r.after, r.source], ['HPD', 0.0000133, 0.0000141, 'dexscreener']);
});

test('PR9 off-scan pricing: a drained pool (DexScreener liquidity < $1000) gives no mark -> hold, no phantom TP', async () => {
  reset();
  st.openPositions = [{ id: 8, strategyId: 'aggressive-flow', symbol: 'RUG', pairAddress: 'RUGPOOL', mint: 'RUGM', entryPrice: 0.0000133, sizeSol: 0.1, entryTime: new Date(Date.now() - 5 * MIN).toISOString(), exit: config.strategies.find(s => s.id === 'aggressive-flow').exit, highest: 0.0000133, lastPrice: 0.0000133, storedPoolPriced: 'x' }];
  scanPairs = [];
  gt.dsPairs.RUGPOOL = { price: 0.00001635, liq: 4.57 };
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1, 'held');
  assert.strictEqual(st.openPositions[0].priceStale, true);
  assert.strictEqual(st.openPositions[0].lastPrice, 0.0000133);
  assert.strictEqual(poolPrice.pairStats.lowLiquidity, 1);
});

test('PR9 independent main-pool check: the entry scan row is never its own verification (GrokCity/HPD case); DexScreener main == entry pool -> verified, mainSource dexscreener', async () => {
  reset();
  scanPairs = [dipPair('GRK', 'POOL_G', 'MINT_G', 0.002, 90000)];
  gt.dsPairs.POOL_G = { price: 0.002, liq: 90000 }; // fill price available, token lookup empty
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 0);
  assert.strictEqual(st.poolChecks.unverifiedSkips, 1);
  assert.strictEqual(st.poolChecks.verified, 0);
  reset();
  scanPairs = [dipPair('GRK', 'POOL_G', 'MINT_G', 0.002, 90000)];
  gt.ds.MINT_G = [{ pairAddress: 'POOL_G', price: 0.00201, liq: 90000 }, { pairAddress: 'POOL_TINY', price: 0.003, liq: 2000 }];
  await idx.tick();
  assert.strictEqual(st.openPositions.length, 1);
  const v = st.poolChecks.lastVerified[0];
  assert.deepStrictEqual([v.mainSource, v.mainPool, v.samePool, v.gapPct], ['dexscreener', 'POOL_G', true, 0]);
  assert.deepStrictEqual(st.poolChecks.bySource, { dexscreener: 1 });
});

test('slot reserve: with maxOpen 4, the other books cannot take the last slot reserved for dip-hold; dip-hold signals go first', async () => {
  assert.strictEqual(config.maxOpen, 4); assert.deepStrictEqual(config.slotReserve, { 'dip-hold': 1 });
  reset();
  st.openPositions = [1, 2, 3].map(i => ({ id: i, strategyId: 'aggressive-flow', symbol: 'AF' + i, pairAddress: 'AFPOOL' + i, entryPrice: 1, sizeSol: 0.1, entryTime: new Date().toISOString(), highest: 1, exit: { takeProfitPct: 99, stopLossPct: 99, maxHoldMinutes: 999 }, storedPoolPriced: 'x' }));
  const afPair = i => ({ pairAddress: 'AFPOOL' + i, mint: 'AFM' + i, symbol: 'AF' + i, priceUsd: 1, liquidityUsd: 100000, volumeH1: 0, priceChange: { m5: -9, h1: 30 }, txns: { buys: 1, sells: 100 }, ageDays: 5 });
  // a fresh AF candidate (passes aggressive-flow rules) and a dip-hold candidate
  const afNew = { pairAddress: 'AFNEW', mint: 'AFNEWM', symbol: 'AFN', priceUsd: 1, liquidityUsd: 100000, volumeH1: 50000, priceChange: { m5: 0, h1: 20 }, txns: { buys: 100, sells: 100 }, ageDays: 5 };
  scanPairs = [1, 2, 3].map(afPair).concat([afNew, dipPair('DIP', 'DIPPOOL', 'DIPM', 0.5)]);
  gt.ds.DIPM = [{ pairAddress: 'DIPPOOL', price: 0.5, liq: 100000 }]; gt.ds.AFNEWM = [{ pairAddress: 'AFNEW', price: 1, liq: 100000 }];
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
