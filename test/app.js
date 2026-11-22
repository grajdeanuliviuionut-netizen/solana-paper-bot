// Tests for the running app path (index.js tick, manager, re-entry cooldown, 429 backoff). No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-app-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
// t83u (Liviu 22 Nov 06:46): the live config pauses everything except runner-hunter (asserted in test/pause.js).
// The legacy behaviour tests below run on the pre-t83u active set (only aggressive-flow paused) so entry logic stays covered.
for (const s of config.strategies) s.paused = s.id === 'aggressive-flow';
for (const b of config.books.list) b.paused = false;
config.slotReserve = { 'dip-hold': 1 };
config.onlyStrategies = null;            // t85u allow-list off for these behaviour tests (test/runner2.js covers the live set)
config.books.epochCloseout = false;
const { review, sizeFor } = require('../src/manager');
const reentry = require('../src/reentry');
const hb = require('../src/httpBackoff');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;
const losing = (id, n) => Array.from({ length: n }, (_, i) => ({ strategyId: id, pnlSol: i === 0 ? 0.01 : -0.01, closedAt: new Date(Date.now() - (i + 60) * MIN).toISOString(), pairAddress: 'P' + i, symbol: 'S' + i }));

// ---------- manager: cut size, never pause for results ----------
test('manager: dip-hold auto-paused at 13:33 is unpaused; losing strategy gets half size, not a pause', () => {
  const state = { pausedIds: ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn', 'dip-hold'], trades: [{ strategyId: 'dip-hold', pnlSol: 0.001 }].concat(losing('dip-hold', 9)) };
  // A hand-set config pause (paused:true) is kept; results never pause (PR7 unpaused the four books in config).
  const cfg = Object.assign({}, config, { strategies: config.strategies.map(s => s.id === 'aggressive-flow' ? Object.assign({}, s, { paused: true }) : s) });
  const r = review(state, cfg);
  assert.ok(!state.pausedIds.includes('dip-hold'), 'dip-hold unpaused');
  assert.deepStrictEqual(state.pausedIds, ['aggressive-flow'], 'only the config pause stays');
  assert.strictEqual(state.stratSizeMult['dip-hold'], 0.5);
  assert.ok(r.notes.some(n => /unpause dip-hold/.test(n)));
  assert.ok(!r.notes.some(n => /MANAGER pause dip-hold/.test(n)));
  // a second review must not re-pause it
  review(state, config);
  assert.ok(!state.pausedIds.includes('dip-hold'));
});
test('manager: config-paused strategies stay paused, results never add a pause', () => {
  const state = { pausedIds: [], trades: losing('dip-hold', 20) };
  review(state, config);
  assert.deepStrictEqual(state.pausedIds.slice().sort(), config.strategies.filter(s => s.paused).map(s => s.id).sort());
  assert.ok(config.strategies.find(s => s.id === 'dip-hold') && !config.strategies.find(s => s.id === 'dip-hold').paused);
});
test('sizeFor: halving per strategy and per losing streak, floored at minPositionSol 0.02', () => {
  assert.strictEqual(config.minPositionSol, 0.02);
  const st = { sizeMult: 1, stratSizeMult: { 'dip-hold': 0.5 } };
  assert.strictEqual(sizeFor(0.24, st, config, 'dip-hold'), 0.12);
  assert.strictEqual(sizeFor(0.24, st, config, 'other'), 0.24);
  assert.strictEqual(sizeFor(0.05, { sizeMult: 0.5, stratSizeMult: { 'dip-hold': 0.5 } }, config, 'dip-hold'), 0.02);
});

// ---------- re-entry cooldown ----------
test('re-entry cooldown: 45 min after any exit, keyed by mint and pool, never by ticker', () => {
  assert.strictEqual(config.reentryCooldownMin, 45);
  const state = {};
  const t0 = Date.parse('2026-11-21T13:09:41Z');
  reentry.recordExit(state, { symbol: 'jingyu', mint: 'MINT_J', pairAddress: 'POOL_J', exitReason: 'trail' }, config, t0);
  assert.ok(reentry.blocked(state, { symbol: 'jingyu', mint: 'MINT_J', pairAddress: 'POOL_J' }, t0 + 23 * MIN), 'jingyu 13:32 re-entry blocked');
  assert.ok(reentry.blocked(state, { symbol: 'other', mint: 'MINT_J', pairAddress: 'POOL_X' }, t0 + 10 * MIN), 'same mint, other pool');
  assert.ok(reentry.blocked(state, { symbol: 'other', pairAddress: 'POOL_J' }, t0 + 10 * MIN), 'same pool, no mint');
  assert.strictEqual(reentry.blocked(state, { symbol: 'jingyu', mint: 'MINT_OTHER', pairAddress: 'POOL_OTHER' }, t0 + 10 * MIN), null, 'same ticker, other token');
  assert.strictEqual(reentry.blocked(state, { symbol: 'jingyu', mint: 'MINT_J', pairAddress: 'POOL_J' }, t0 + 46 * MIN), null, 'expired after 45 min');
  reentry.prune(state, t0 + 46 * MIN);
  assert.deepStrictEqual(state.reentryCooldowns, {});
});
test('re-entry cooldown: seeded from closed trades at boot (restart keeps it)', () => {
  const now = Date.now();
  const state = { trades: [
    { symbol: 'NIO', pairAddress: 'POOL_N', closedAt: new Date(now - 10 * MIN).toISOString(), exitReason: 'sl' },
    { symbol: 'OLD', pairAddress: 'POOL_O', closedAt: new Date(now - 50 * MIN).toISOString(), exitReason: 'tp' },
    { symbol: 'BAD', closedAt: 'garbage' }
  ] };
  assert.strictEqual(reentry.seed(state, config, now), 1);
  assert.ok(reentry.blocked(state, { pairAddress: 'POOL_N' }, now));
  assert.strictEqual(reentry.blocked(state, { pairAddress: 'POOL_O' }, now), null);
});

// ---------- 429 backoff ----------
const err429 = ra => Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, headers: ra ? { 'retry-after': ra } : {} } });
test('backoff: 429 twice then 200 -> success after 2 jittered exponential waits', async () => {
  hb._reset();
  let calls = 0; const sleeps = []; let clock = 0;
  hb._setDeps({ http: { get: async () => { calls++; if (calls <= 2) throw err429(); return { data: { ok: 1 } }; } }, sleep: async ms => { sleeps.push(ms); clock += ms; }, now: () => clock, rand: () => 0.5, opts: { minGapMs: 0, retries: 2, baseDelayMs: 2000 } });
  const res = await hb.get('u');
  assert.strictEqual(res.data.ok, 1);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(sleeps, [1500, 3000]); // [cap/2, cap) with cap 2000, 4000
  assert.strictEqual(hb.stats.rateLimited, 2); assert.strictEqual(hb.stats.retries, 2);
});
test('backoff: jitter stays within [cap/2, cap) and Retry-After is honoured', () => {
  for (const r of [0, 0.25, 0.999]) {
    hb._setDeps({ rand: () => r });
    const d = hb.backoffMs(1); assert.ok(d >= 2000 && d < 4000, String(d));
  }
  hb._setDeps({ rand: () => 0 });
  assert.strictEqual(hb.backoffMs(0, '7'), 7000);
  assert.strictEqual(hb.backoffMs(5), 7500); // capped at maxDelayMs 15000
});
test('backoff: persistent 429 -> rateLimited error, host cooldown skips the next calls without hitting the API', async () => {
  hb._reset();
  let calls = 0; let clock = 0;
  hb._setDeps({ http: { get: async () => { calls++; throw err429(); } }, sleep: async ms => { clock += ms; }, now: () => clock, rand: () => 0, opts: { minGapMs: 0, retries: 2, hostCooldownMs: 30000 } });
  await assert.rejects(hb.get('a'), e => e.rateLimited === true);
  assert.strictEqual(calls, 3);
  await assert.rejects(hb.get('b'), e => e.rateLimited === true && /cooldown/.test(e.message));
  assert.strictEqual(calls, 3, 'no request during cooldown');
  clock += 30001;
  hb._setDeps({ http: { get: async () => { calls++; return { data: 1 }; } } });
  assert.strictEqual((await hb.get('c')).data, 1);
});
test('backoff: at most 1 request in flight and a minimum gap between requests', async () => {
  hb._reset();
  let inFlight = 0, maxInFlight = 0; const starts = [];
  hb._setDeps({ http: { get: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); starts.push(Date.now()); await new Promise(r => setTimeout(r, 5)); inFlight--; return { data: 1 }; } }, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(), opts: { minGapMs: 20, retries: 2 } });
  await Promise.all([hb.get('1'), hb.get('2'), hb.get('3'), hb.get('4')]);
  assert.strictEqual(maxInFlight, 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 18, 'gap ' + (starts[i] - starts[i - 1]));
});
// PR10: DexScreener scanner (shared DexScreener limiter, no GeckoTerminal).
const SOLQ = { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' };
const dsPair = (o) => Object.assign({ chainId: 'solana', dexId: 'raydium', pairAddress: 'P1', baseToken: { address: 'M1', symbol: 'JING' }, quoteToken: SOLQ, priceUsd: '0.01', liquidity: { usd: 50000 }, volume: { h1: 5000 }, priceChange: { m5: 1, h1: -5, h6: 2, h24: -10 }, txns: { h1: { buys: 10, sells: 5 } }, marketCap: 900000, fdv: 1000000, pairCreatedAt: Date.now() - 2 * 86400000 }, o);
test('dataFetcher: DexScreener pair maps to the scan row the strategies use', () => {
  const df = require('../src/dataFetcher');
  const now = Date.now();
  const r = df.mapDsPair(dsPair({ pairCreatedAt: now - 2 * 86400000 }), now);
  assert.strictEqual(r.pairAddress, 'P1'); assert.strictEqual(r.mint, 'M1'); assert.strictEqual(r.symbol, 'JING');
  assert.strictEqual(r.priceUsd, 0.01); assert.strictEqual(r.liquidityUsd, 50000); assert.strictEqual(r.volumeH1, 5000);
  assert.deepStrictEqual(r.priceChange, { m5: 1, h1: -5, h6: 2, h24: -10 });
  assert.deepStrictEqual(r.txns, { buys: 10, sells: 5 });
  assert.ok(Math.abs(r.ageDays - 2) < 1e-6); assert.strictEqual(r.mcapUsd, 900000); assert.strictEqual(r.source, 'dexscreener');
  assert.ok(!r.stale);
  // the strategies read the same fields as before
  const { generateSignals } = require('../src/buyAgent');
  assert.ok(Array.isArray(generateSignals([r]).signals));
  // filters: non-SOL quote, low liquidity, other chain, SOL itself, missing fields default safely
  assert.strictEqual(df.mapDsPair(dsPair({ quoteToken: { address: 'EPjF', symbol: 'USDC' } })), null);
  assert.strictEqual(df.mapDsPair(dsPair({ liquidity: { usd: 9000 } })), null);
  assert.strictEqual(df.mapDsPair(dsPair({ chainId: 'base' })), null);
  assert.strictEqual(df.mapDsPair(dsPair({ baseToken: { address: SOLQ.address, symbol: 'SOL' } })), null);
  const bare = df.mapDsPair(dsPair({ priceChange: undefined, txns: undefined, volume: undefined, pairCreatedAt: undefined, marketCap: undefined }));
  assert.deepStrictEqual(bare.priceChange, { m5: 0, h1: 0, h6: 0, h24: 0 }); assert.strictEqual(bare.ageDays, 1); assert.strictEqual(bare.mcapUsd, 1000000);
  // one row per mint: its highest-liquidity SOL pool
  const best = df.bestRowsByMint([dsPair({ pairAddress: 'SMALL', liquidity: { usd: 20000 } }), dsPair({ pairAddress: 'BIG', liquidity: { usd: 80000 } }), dsPair({ pairAddress: 'X', baseToken: { address: 'OTHER' } })], new Set(['M1']));
  assert.deepStrictEqual(Object.keys(best), ['M1']); assert.strictEqual(best.M1.pairAddress, 'BIG');
});
test('dataFetcher: scan uses only DexScreener via the shared limiter; discovery cached; a failed batch reuses rows marked stale', async () => {
  const df = require('../src/dataFetcher');
  const pp = require('../src/poolPrice');
  df._reset(); pp.mainLimiter._reset(); hb._reset();
  const calls = []; let fail = false;
  pp.mainLimiter._setDeps({ sleep: async () => {}, now: () => Date.now(), opts: { minGapMs: 0 }, http: { get: async url => {
    calls.push(url);
    if (/token-profiles\/latest/.test(url)) return { data: [{ chainId: 'solana', tokenAddress: 'M1' }, { chainId: 'base', tokenAddress: 'B1' }] };
    if (/token-boosts\/latest/.test(url)) return { data: [{ chainId: 'solana', tokenAddress: 'M2' }] };
    if (/token-boosts\/top|community-takeovers/.test(url)) return { data: [] };
    if (/latest\/dex\/search/.test(url)) return { data: { pairs: [dsPair({ pairAddress: 'S1', baseToken: { address: 'M2', symbol: 'TWO' } }), dsPair({ pairAddress: 'S2', baseToken: { address: 'LOW' }, liquidity: { usd: 100 } })] } };
    if (/\/tokens\/v1\/solana\//.test(url)) {
      if (fail) throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } });
      return { data: [dsPair({}), dsPair({ pairAddress: 'P2', baseToken: { address: 'M2', symbol: 'TWO' } })] };
    }
    throw new Error('unexpected ' + url);
  } } });
  let gtCalls = 0;
  hb._setDeps({ http: { get: async () => { gtCalls++; return { data: { data: [] } }; } } });
  const a = await df.getCandidatePairs();
  assert.deepStrictEqual(a.map(p => p.pairAddress).sort(), ['P1', 'P2']);
  assert.ok(calls.every(u => u.startsWith('https://api.dexscreener.com/')), 'DexScreener only');
  assert.strictEqual(gtCalls, 0, 'no GeckoTerminal call in the scan');
  assert.strictEqual(calls.filter(u => /token-profiles|token-boosts|community|search/.test(u)).length, 7);
  assert.ok(!calls.some(u => u.includes('B1') || u.includes('LOW')), 'other chains and low-liquidity search hits dropped');
  await df.getCandidatePairs();
  assert.strictEqual(calls.filter(u => /token-profiles|token-boosts|community|search/.test(u)).length, 7, 'discovery cached between passes');
  assert.strictEqual(pp.mainLimiter.stats.byTag.scan.requests, calls.length);
  assert.strictEqual(pp.mainLimiter.stats.byHost['api.dexscreener.com'].requests, calls.length);
  fail = true;
  pp.mainLimiter._setDeps({ opts: { hostCooldownMs: 0 } });
  const c = await df.getCandidatePairs();
  assert.strictEqual(c.length, 2); assert.ok(c.every(p => p.stale), 'cached rows are stale (never priced from)');
  assert.strictEqual(pp.mainLimiter.stats.byTag.scan.rateLimited, 1);
  assert.strictEqual(df.scanStats.lastCandidates, 2);
  pp.mainLimiter._setDeps({ opts: { hostCooldownMs: 60000 } });
  pp.mainLimiter._reset(); df._reset();
});

// ---------- boot + tick smoke (real index.js, scanner stubbed, no network) ----------
test('boot smoke: index.js boots on the real config; tick unpauses dip-hold, opens a dip-hold entry, blocks a cooled-down token, /api/trades + / answer 200', async () => {
  const now = Date.now();
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
    balance: 3.0399, openPositions: [], activity: [], decisions: [], paperReset: 'work-1',
    pausedIds: ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn', 'dip-hold'],
    trades: [{ symbol: 'COOLD', strategyId: 'dip-hold', strategyName: 'Dip and hold', pairAddress: 'POOL_NIO', mint: 'MINT_NIO', pnlSol: -0.0255, exitReason: 'sl', closedAt: new Date(now - 5 * MIN).toISOString() }]
      .concat(losing('dip-hold', 8))
  }));
  const dip = (sym, pool, mint) => ({ pairAddress: pool, mint, symbol: sym, priceUsd: 0.01, liquidityUsd: 100000, volumeH1: 20000, priceChange: { m5: 1, h1: -6, h6: 0, h24: 0 }, txns: { buys: 200, sells: 100 }, ageDays: 5 });
  const scannerPath = require.resolve('../src/agents/scanner');
  require.cache[scannerPath] = { id: scannerPath, filename: scannerPath, loaded: true, exports: { scan: async () => scanRows } };
  const scanRows = [dip('COOLD', 'POOL_NIO', 'MINT_NIO'), dip('COOLD', 'POOL_NIO2', 'MINT_NIO_CLONE'), dip('FRESH', 'POOL_F', 'MINT_F')];
  hb._reset(); hb._setDeps({ http: { get: async () => ({ data: { data: [] } }) }, sleep: async () => {}, now: () => Date.now(), opts: { minGapMs: 0 } });
  // Main-pool lookup (own limiter): DexScreener answers each mint with its scan pool as the main pool.
  const pp = require('../src/poolPrice');
  const mainOf = { MINT_NIO: 'POOL_NIO', MINT_NIO_CLONE: 'POOL_NIO2', MINT_F: 'POOL_F', MINT_G: 'POOL_G' };
  // PR9: the same limiter answers DexScreener pair prices (/latest/dex/pairs) for entry fills and off-scan marks.
  pp.mainLimiter._setDeps({ sleep: async () => {}, opts: { minGapMs: 0 }, http: { get: async url => {
    const ids = url.split('/').pop().split(',');
    if (/\/latest\/dex\/pairs\//.test(url)) return { data: { pairs: ids.map(a => ({ chainId: 'solana', pairAddress: a, priceUsd: '0.01', liquidity: { usd: 100000 } })) } };
    return { data: ids.map(m => ({ chainId: 'solana', pairAddress: mainOf[m], baseToken: { address: m }, priceUsd: '0.01', liquidity: { usd: 100000 } })) };
  } } });
  // PR13: the new_pools feed never touches the network in tests.
  require('../src/newPools')._setDeps({ http: { get: async () => ({ status: 200, data: { data: [] } }) } });
  const idx = require('../src/index');
  const noRoute = async () => { throw Object.assign(new Error('400'), { response: { status: 400, data: { error: 'COULD_NOT_FIND_ANY_ROUTE' } } }); };
  idx.booksLimiter.setHttp({ get: noRoute, post: noRoute }); // PR14: no Jupiter in tests
  await idx.tick();
  const st = idx.getState();
  assert.ok(!st.pausedIds.includes('dip-hold'), 'dip-hold unpaused');
  assert.deepStrictEqual(st.pausedIds, ['aggressive-flow'], 'PR13: only aggressive-flow paused (Liviu t68u); the other four legacy books unpaused');
  const opened = st.openPositions.map(p => p.pairAddress);
  assert.ok(!opened.includes('POOL_NIO'), 'NIO pool in 45-min cooldown');
  assert.ok(opened.includes('POOL_F'), 'fresh dip-hold entry opened: ' + JSON.stringify(st.activity.slice(0, 8)));
  const f = st.openPositions.find(p => p.pairAddress === 'POOL_F');
  assert.strictEqual(f.strategyId, 'dip-hold'); assert.strictEqual(f.mint, 'MINT_F');
  assert.ok(f.sizeSol >= 0.02 && f.sizeSol < 0.243, 'half size for the losing strategy: ' + f.sizeSol);
  assert.ok(st.decisions.some(d => /re-entry cooldown/.test(JSON.stringify(d))));
  assert.ok(!st.activity.some(a => /Tick error/.test(a.msg)), JSON.stringify(st.activity));
  // Same-mint guard (FIONA, 22 Nov): a legacy strategy may not open a mint a BOOK already holds.
  const fakeBook = { id: 'bk-test-G', book: 'trending-pullback', strategyId: 'trending-pullback', mint: 'MINT_G', pairAddress: 'POOL_G', symbol: 'GOOD', entryTime: new Date().toISOString(), sizeSol: 0.05, remainingFrac: 1, costBasisRemainingSol: 0.05 };
  idx.books.ensure(st).open.push(fakeBook);
  scanRows.push(dip('GOOD', 'POOL_G', 'MINT_G'));
  await idx.tick();
  assert.ok(!st.openPositions.some(p => p.mint === 'MINT_G'), 'legacy blocked by the book hold');
  assert.ok(st.decisions.some(d => /sameMintHeld/.test(JSON.stringify(d)) && /GOOD/.test(JSON.stringify(d))), JSON.stringify(st.decisions.slice(0, 6)));
  const rjs = idx.books.ensure(st).rejects;
  assert.ok(rjs.byReason.sameMintHeld >= 1 && rjs.recent.some(r => r.reason === 'sameMintHeld' && /legacy$/.test(r.book) && r.heldBy[0].strategyId === 'trending-pullback'), JSON.stringify(rjs.recent.slice(0, 3)));
  // ... and once the book holding is gone, the mint is free again (closed trades never block)
  idx.books.ensure(st).open.splice(idx.books.ensure(st).open.indexOf(fakeBook), 1);
  assert.strictEqual(idx.books.heldMint(st, { mint: 'MINT_G' }), null);
  scanRows.pop();
  const server = idx.app.listen(0);
  const port = server.address().port;
  const get = p => new Promise(resolve => http.get({ host: '127.0.0.1', port, path: p }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }));
  try {
    const t = await get('/api/trades');
    assert.strictEqual(t.status, 200);
    const j = JSON.parse(t.body);
    // PR11 scoreboard reset: old trades archived on the volume, fresh board, same balance.
    assert.ok(j.pausedIds && j.reentryCooldowns);
    assert.strictEqual(j.legacyTrades.length, 0, 'fresh scoreboard');
    assert.strictEqual(j.scoreboard.epoch, config.books.epoch);
    // t85u: /api/pnl answers with a reconciliation (residual ~0 on a fresh board)
    const pn = JSON.parse((await get('/api/pnl')).body);
    assert.ok(pn.window && pn.window.since && Array.isArray(pn.rows) && Array.isArray(pn.byStrategy), JSON.stringify(pn).slice(0, 300));
    assert.ok(Math.abs(pn.residualSol) < 1e-6, 'residual ' + pn.residualSol);
    assert.ok(j.scoreboard.since && 'build' in j.scoreboard);
    const arch = JSON.parse(fs.readFileSync(j.scoreboard.archiveFile, 'utf8'));
    assert.strictEqual(arch.trades.length, 9, 'old trades archived, not destroyed');
    assert.strictEqual(j.scoreboard.startBalance, 3.0399, 'same balance');
    assert.strictEqual(j.books.list.length, 4);
    assert.ok(j.books.list.every(b => b.sizeSol === 0.05 && b.progress === '0/30'));
    for (const k of ['requests', 'rateLimited', 'retries', 'skipped', 'last429At', 'since', 'byHost', 'scan']) assert.ok(k in j.fetchStats, 'fetchStats.' + k);
    const d = await get('/classic');
    assert.strictEqual(d.status, 200);
    // PR14 (Liviu t74u): positions grouped per book + every legacy strategy; empty groups say why.
    const pz = JSON.parse((await get('/api/positions')).body);
    const ids = pz.groups.map(g => g.id);
    for (const id of ['graduation-sniper', 'runner-hunter', 'volume-explosion', 'trending-pullback', 'dip-hold', 'momentum-entry', 'dip-buyers', 'buyer-turn', 'aggressive-flow']) assert.ok(ids.includes(id), 'group ' + id);
    const af = pz.groups.find(g => g.id === 'aggressive-flow');
    assert.strictEqual(af.status, 'paused'); assert.ok(af.empty && /PAUSED/.test(af.idleReason));
    const dh = pz.groups.find(g => g.id === 'dip-hold');
    assert.strictEqual(dh.openCount, dh.positions.length); assert.ok(dh.openCount >= 1); assert.strictEqual(dh.status, 'active');
    const row = dh.positions.find(p => p.pairAddress === 'POOL_F');
    for (const k of ['symbol', 'dexUrl', 'sizeSol', 'entryTime', 'ageMin', 'entryPrice', 'markPrice', 'quoteAgeSec', 'netPnlPct', 'unrealizedSol', 'stopPct', 'targetPct']) assert.ok(k in row, 'row.' + k);
    assert.strictEqual(row.stopPct, -5); assert.strictEqual(row.targetPct, 12);
    assert.ok(/dexscreener\.com\/solana\/POOL_F/.test(row.dexUrl));
    const gs = pz.groups.find(g => g.id === 'graduation-sniper');
    assert.ok(gs.empty && gs.idleReason && gs.maxOpen === 2, JSON.stringify(gs));
    assert.ok('exitLoop' in pz);
    const dj2 = JSON.parse((await get("/api/dashboard")).body);
    assert.strictEqual(dj2.positionsByStrategy.length, pz.groups.length);
    const page = await get('/');
    assert.ok(!/night/i.test(page.body), 'no Night Shift branding');
    assert.ok(/id="hero"/.test(page.body) && /renderHero/.test(page.body) && /id="openPos"/.test(page.body) && /renderOpen/.test(page.body) && !/paused strateg/i.test(page.body) && !/renderPaused|id="paused"/.test(page.body) && /setInterval\(refresh, 5000\)/.test(page.body), 'Paper Terminal: runner-hunter hero + live open positions, no paused-strategy panel (t84u)');
    assert.ok(/Dip and hold/.test(d.body), 'strategy name on close rows (classic dashboard)');
    // Paper Terminal dashboard: static page at '/', assets, equity history and the aggregate endpoint
    const home = await get('/');
    assert.strictEqual(home.status, 200);
    assert.ok(/Paper Terminal/.test(home.body) && /PAPER/.test(home.body) && /\/api\/dashboard/.test(home.body) && /\/api\/equity/.test(home.body), 'paper terminal page');
    const snap = idx.recordEquity();
    assert.ok(snap && typeof snap.markEquity === 'number' && typeof snap.equity === 'number', 'equity snapshot recorded');
    const eq = await get('/api/equity?since=scoreboard');
    assert.strictEqual(eq.status, 200);
    const ej = JSON.parse(eq.body);
    assert.ok(Array.isArray(ej.points) && ej.points.length >= 1, 'stored snapshot returned');
    assert.ok(ej.current && typeof ej.current.markEquity === 'number');
    assert.strictEqual(ej.scoreboard.epoch, config.books.epoch);
    assert.ok(fs.existsSync(path.join(TMP, 'equity.jsonl')), 'equity.jsonl lives in the data dir (volume)');
    const db = await get('/api/dashboard');
    assert.strictEqual(db.status, 200);
    const dj = JSON.parse(db.body);
    assert.strictEqual(dj.liveTrading, false);
    assert.strictEqual(dj.books.length, 4);
    for (const k of ['manager', 'scanner', 'rugCheck', 'strategist', 'executor', 'logger']) assert.ok(k in dj.agents, 'agent ' + k);
    for (const k of ['balance', 'equity', 'markEquity', 'realizedTodaySol', 'realizedSinceResetSol']) assert.ok(k in dj.account, 'account.' + k);
    assert.ok(Array.isArray(dj.openPositions) && Array.isArray(dj.recentTrades));
    // t79u Bots panel: /api/bots + dashboard.bots, statuses from real signals (a tick has run here).
    const bj = JSON.parse((await get('/api/bots')).body);
    assert.deepStrictEqual(bj.agents.map(x => x.id), ['manager', 'scanner', 'rugCheck', 'strategist', 'executor', 'logger']);
    for (const x of bj.agents) assert.ok(['RUNNING', 'IDLE', 'PAUSED', 'ERROR', 'STALE'].includes(x.status) && x.metric && 'lastActivityAgeSec' in x, JSON.stringify(x));
    assert.strictEqual(bj.agents.find(x => x.id === 'manager').status, 'RUNNING', 'tick ran');
    assert.strictEqual(bj.agents.find(x => x.id === 'logger').status, 'RUNNING', 'state saved');
    assert.ok(bj.strategies.length >= 9 && bj.strategies.find(x => x.id === 'aggressive-flow').status === 'PAUSED');
    assert.ok(bj.strategies.every(x => ['RUNNING', 'WATCHING', 'PAUSED', 'EMPTY'].includes(x.status) && 'trades' in x && 'netSol' in x && 'maxOpen' in x));
    assert.strictEqual(dj.bots.agents.length, 6);
    assert.ok(/id="nucleus"/.test(home.body) && /renderNucleus/.test(home.body), 'agents nucleus on the page (t83u)');
  } finally { server.close(); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} app tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
