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
  const r = review(state, config);
  assert.ok(!state.pausedIds.includes('dip-hold'), 'dip-hold unpaused');
  for (const id of ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn']) assert.ok(state.pausedIds.includes(id), id + ' stays paused (config)');
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
test('dataFetcher: mint parsed from base_token; a 429 source reuses its last good page', async () => {
  const df = require('../src/dataFetcher');
  const row = { attributes: { name: 'JING / SOL', address: 'POOL1', reserve_in_usd: '50000', base_token_price_usd: '0.01', price_change_percentage: { m5: '1', h1: '-5' }, transactions: { h1: { buys: 10, sells: 5 } }, volume_usd: { h1: '5000' } }, relationships: { base_token: { data: { id: 'solana_MINT1' } } } };
  assert.strictEqual(df.mapPool(row).mint, 'MINT1');
  hb._reset();
  let fail = false;
  hb._setDeps({ http: { get: async () => { if (fail) throw err429(); return { data: { data: [row] } }; } }, sleep: async () => {}, now: () => Date.now(), opts: { minGapMs: 0, retries: 0, hostCooldownMs: 0 } });
  assert.strictEqual((await df.getCandidatePairs()).length, 1);
  fail = true;
  const pairs = await df.getCandidatePairs();
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].mint, 'MINT1');
});

// ---------- boot + tick smoke (real index.js, scanner stubbed, no network) ----------
test('boot smoke: index.js boots on the real config; tick unpauses dip-hold, opens a dip-hold entry, blocks a cooled-down token, /api/trades + / answer 200', async () => {
  const now = Date.now();
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
    balance: 3.0399, openPositions: [], activity: [], decisions: [], paperReset: 'work-1',
    pausedIds: ['aggressive-flow', 'momentum-entry', 'dip-buyers', 'buyer-turn', 'dip-hold'],
    trades: [{ symbol: 'NIO', strategyId: 'dip-hold', strategyName: 'Dip and hold', pairAddress: 'POOL_NIO', mint: 'MINT_NIO', pnlSol: -0.0255, exitReason: 'sl', closedAt: new Date(now - 5 * MIN).toISOString() }]
      .concat(losing('dip-hold', 8))
  }));
  const dip = (sym, pool, mint) => ({ pairAddress: pool, mint, symbol: sym, priceUsd: 0.01, liquidityUsd: 100000, volumeH1: 20000, priceChange: { m5: 1, h1: -6, h6: 0, h24: 0 }, txns: { buys: 200, sells: 100 }, ageDays: 5 });
  const scannerPath = require.resolve('../src/agents/scanner');
  require.cache[scannerPath] = { id: scannerPath, filename: scannerPath, loaded: true, exports: { scan: async () => [dip('NIO', 'POOL_NIO', 'MINT_NIO'), dip('NIO', 'POOL_NIO2', 'MINT_NIO_CLONE'), dip('FRESH', 'POOL_F', 'MINT_F')] } };
  const idx = require('../src/index');
  await idx.tick();
  const st = idx.getState();
  assert.ok(!st.pausedIds.includes('dip-hold'), 'dip-hold unpaused');
  assert.ok(st.pausedIds.includes('momentum-entry') && st.pausedIds.includes('aggressive-flow'), 'old books stay paused');
  const opened = st.openPositions.map(p => p.pairAddress);
  assert.ok(!opened.includes('POOL_NIO'), 'NIO pool in 45-min cooldown');
  assert.ok(opened.includes('POOL_F'), 'fresh dip-hold entry opened: ' + JSON.stringify(st.activity.slice(0, 8)));
  const f = st.openPositions.find(p => p.pairAddress === 'POOL_F');
  assert.strictEqual(f.strategyId, 'dip-hold'); assert.strictEqual(f.mint, 'MINT_F');
  assert.ok(f.sizeSol >= 0.02 && f.sizeSol < 0.243, 'half size for the losing strategy: ' + f.sizeSol);
  assert.ok(st.decisions.some(d => /re-entry cooldown/.test(JSON.stringify(d))));
  assert.ok(!st.activity.some(a => /Tick error/.test(a.msg)), JSON.stringify(st.activity));
  const server = idx.app.listen(0);
  const port = server.address().port;
  const get = p => new Promise(resolve => http.get({ host: '127.0.0.1', port, path: p }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }));
  try {
    const t = await get('/api/trades');
    assert.strictEqual(t.status, 200);
    const j = JSON.parse(t.body);
    assert.ok(j.trades.length >= 9 && j.pausedIds && j.reentryCooldowns);
    const d = await get('/');
    assert.strictEqual(d.status, 200);
    assert.ok(/Dip and hold/.test(d.body), 'strategy name on close rows');
  } finally { server.close(); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} app tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
