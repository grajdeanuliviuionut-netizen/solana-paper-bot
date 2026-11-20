// Offline tests for the live path. NEVER touches the network: all RPC/HTTP is faked and every
// "send" is recorded in memory. Run: npm test
const assert = require('assert');
const web3 = require('@solana/web3.js');
const bs58mod = require('bs58'); const bs58 = bs58mod.default || bs58mod;
const liveConfig = require('../src/live/liveConfig');
const { initLive, LiveExecutor } = require('../src/live/executor');
const { redact } = require('../src/live/redact');
const { loadKeypair } = require('../src/live/wallet');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fakeConnection(balanceLamports = 5e9) {
  const calls = { send: 0, getBalance: 0 };
  return {
    calls,
    getBalance: async () => { calls.getBalance++; return balanceLamports; },
    sendRawTransaction: async () => { calls.send++; return 'FAKE_SIG_' + calls.send; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getTransaction: async () => null,
    getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '1000' } } } } } }] })
  };
}
function dummySwapTx(payer) {
  const msg = new web3.TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(),
    instructions: [web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })]
  }).compileToV0Message();
  return Buffer.from(new web3.VersionedTransaction(msg).serialize()).toString('base64');
}
const kp = web3.Keypair.generate();
const KEY = bs58.encode(kp.secretKey);
const fullEnv = () => ({
  LIVE_TRADING: 'true', WALLET_PRIVATE_KEY: KEY, KILL_TOKEN: 'k'.repeat(24), LIVE_STRATEGIES: 'aggressive-flow',
  MAX_SOL_PER_TRADE: '0.05', MAX_DAILY_LOSS_SOL: '0.1', MAX_OPEN_POSITIONS: '2', MAX_CONSECUTIVE_LOSSES: '3',
  PRIORITY_FEE: '100000', JITO_TIP: '0'
});
const fakeJup = { SWAP_API: 'https://fake.invalid/swap/v1', getQuote: async () => ({ ok: true, inAmount: '50000000', outAmount: '123456', priceImpactPct: 0.5, routeLabels: ['X'], quoteResponse: { fake: true } }) };

test('paper is the default (no env)', async () => {
  const r = await initLive({ liveState: {}, env: {} });
  assert.strictEqual(r.status.mode, 'paper');
  assert.strictEqual(r.executor, null);
});
test('LIVE_TRADING=true with no key refuses live and never touches RPC or sends', async () => {
  const env = fullEnv(); delete env.WALLET_PRIVATE_KEY;
  const conn = fakeConnection();
  const r = await initLive({ liveState: {}, env, deps: { connection: conn } });
  assert.strictEqual(r.status.mode, 'paper');
  assert.ok(r.status.reasons.includes('WALLET_PRIVATE_KEY missing'));
  assert.strictEqual(conn.calls.getBalance, 0);
  assert.strictEqual(conn.calls.send, 0);
});
test('code defaults: LIVE_TRADING false; LIVE_STRATEGIES=momentum-entry, 0.1 SOL/trade, 0.5 SOL/day, 3 open, 5 losses', async () => {
  const c = liveConfig.read({});
  assert.strictEqual(c.liveRequested, false);
  assert.deepStrictEqual(c.liveStrategies, ['momentum-entry']);
  assert.strictEqual(c.maxSolPerTrade, 0.1); assert.strictEqual(c.maxDailyLossSol, 0.5);
  assert.strictEqual(c.maxOpenPositions, 3); assert.strictEqual(c.maxConsecutiveLosses, 5);
  assert.strictEqual(c.priorityFeeLamports, 100000); assert.strictEqual(c.jitoTipLamports, 0);
  // Only LIVE_TRADING + key + kill token needed; limits fall back to the defaults.
  const env = { LIVE_TRADING: 'true', WALLET_PRIVATE_KEY: KEY, KILL_TOKEN: 'k'.repeat(24) };
  const r = await initLive({ liveState: {}, env, deps: { connection: fakeConnection() } });
  assert.strictEqual(r.status.mode, 'live');
  assert.deepStrictEqual(r.status.config.liveStrategies, ['momentum-entry']);
});
test('missing key/kill token or invalid limits refuse live', async () => {
  for (const k of ['KILL_TOKEN', 'WALLET_PRIVATE_KEY']) {
    const env = fullEnv(); delete env[k];
    const r = await initLive({ liveState: {}, env, deps: { connection: fakeConnection() } });
    assert.strictEqual(r.status.mode, 'paper', k);
  }
  for (const [k, v] of [['MAX_SOL_PER_TRADE', '0'], ['MAX_DAILY_LOSS_SOL', 'abc'], ['MAX_OPEN_POSITIONS', '-1'], ['MAX_CONSECUTIVE_LOSSES', '0'], ['PRIORITY_FEE', '-5'], ['JITO_TIP', 'x'], ['LIVE_STRATEGIES', ''], ['MAX_SOL_PER_TRADE', '2'], ['KILL_TOKEN', 'short']]) {
    const env = fullEnv(); env[k] = v;
    const r = await initLive({ liveState: {}, env, deps: { connection: fakeConnection() } });
    assert.strictEqual(r.status.mode, 'paper', `${k}=${v}`);
  }
  const env = fullEnv(); env.KILL_SWITCH = 'true';
  assert.strictEqual((await initLive({ liveState: {}, env, deps: { connection: fakeConnection() } })).status.mode, 'paper');
});
test('low wallet balance or bad key refuses live', async () => {
  let r = await initLive({ liveState: {}, env: fullEnv(), deps: { connection: fakeConnection(0.01e9) } });
  assert.strictEqual(r.status.mode, 'paper');
  const env = fullEnv(); env.WALLET_PRIVATE_KEY = 'notakey';
  r = await initLive({ liveState: {}, env, deps: { connection: fakeConnection() } });
  assert.strictEqual(r.status.mode, 'paper');
  assert.ok(!JSON.stringify(r.status).includes('notakey'));
});
test('valid key loads (base58 and JSON array)', () => {
  assert.strictEqual(loadKeypair(KEY).publicKey, kp.publicKey.toBase58());
  assert.strictEqual(loadKeypair(JSON.stringify(Array.from(kp.secretKey))).publicKey, kp.publicKey.toBase58());
});
test('full env + funded (fake) wallet activates live; swap uses quote module, retries with backoff, logs fees', async () => {
  const conn = fakeConnection();
  let posts = 0;
  const http = { post: async (url) => { posts++; if (posts < 3) throw new Error('503 from swap api'); return { data: { swapTransaction: dummySwapTx(kp), lastValidBlockHeight: 1 } }; } };
  const liveState = {};
  const r = await initLive({ liveState, env: fullEnv(), deps: { connection: conn, http, jup: fakeJup } });
  assert.strictEqual(r.status.mode, 'live');
  r.executor.sleep = async () => {};
  const res = await r.executor.buy('MintXYZ', 0.5, { check: async () => ({ pass: true, reasons: [] }) }); // capped to MAX_SOL_PER_TRADE
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.attempt, 3);
  assert.strictEqual(conn.calls.send, 1); // fake connection only
  assert.strictEqual(liveState.txLog.length, 3);
  assert.ok(liveState.txLog.every(t => t.priorityFeeLamports === 100000 && t.jitoTipLamports === 0));
});
async function liveExec() {
  const conn = fakeConnection();
  const http = { post: async () => ({ data: { swapTransaction: dummySwapTx(kp), lastValidBlockHeight: 1 } }) };
  const liveState = {};
  const r = await initLive({ liveState, env: fullEnv(), deps: { connection: conn, http, jup: fakeJup } });
  r.executor.sleep = async () => {};
  return { ex: r.executor, conn, liveState };
}
const failCheck = async () => ({ pass: false, reasons: ['gap 9.00%>5%'] });
test('live quote sanity: buy without a check or with a failing check is refused and sends nothing', async () => {
  const { ex, conn, liveState } = await liveExec();
  const a = await ex.buy('MintXYZ', 0.05);
  assert.ok(!a.ok && a.refused); assert.deepStrictEqual(a.reasons, ['no-sanity-check']);
  const b = await ex.buy('MintXYZ', 0.05, { check: failCheck });
  assert.ok(!b.ok && b.refused); assert.ok(b.error.startsWith('quoteSanity: gap'));
  assert.strictEqual(conn.calls.send, 0);
  assert.ok(liveState.txLog.some(t => t.status === 'refused-quoteSanity'));
});
test('live quote sanity: non-emergency sell refused on a failing check; emergency sell proceeds and logs the override', async () => {
  const { ex, conn, liveState } = await liveExec();
  const s1 = await ex.sell('MintXYZ', '1000', { check: failCheck });
  assert.ok(!s1.ok && s1.refused); assert.strictEqual(conn.calls.send, 0);
  const s2 = await ex.sell('MintXYZ', '1000', { check: failCheck, emergency: true });
  assert.ok(s2.ok); assert.deepStrictEqual(s2.sanityOverride, ['gap 9.00%>5%']); assert.strictEqual(conn.calls.send, 1);
  assert.ok(liveState.txLog.some(t => t.status === 'emergency-sell-sanity-override'));
  const s3 = await ex.sell('MintXYZ', '1000', { check: async () => ({ pass: true, reasons: [] }) });
  assert.ok(s3.ok && !s3.sanityOverride);
});
test('limits: max open, daily loss and consecutive-loss kill switch', () => {
  const cfg = liveConfig.read(fullEnv());
  const ex = new LiveExecutor({ cfg, keypair: kp, connection: fakeConnection(), liveState: {}, http: {}, jup: fakeJup, web3 });
  assert.strictEqual(ex.entryBlock(0, 'aggressive-flow'), null);
  assert.strictEqual(ex.entryBlock(0, 'momentum-entry'), 'strategy-not-live');
  assert.strictEqual(ex.entryBlock(2, 'aggressive-flow'), 'MAX_OPEN_POSITIONS');
  ex.recordResult(-0.01); ex.recordResult(-0.01);
  assert.strictEqual(ex.entryBlock(0, 'aggressive-flow'), null);
  ex.recordResult(-0.01);
  assert.ok(String(ex.entryBlock(0, 'aggressive-flow')).startsWith('killed:consecutive'));
  const ex2 = new LiveExecutor({ cfg, keypair: kp, connection: fakeConnection(), liveState: {}, http: {}, jup: fakeJup, web3 });
  ex2.recordResult(-0.11);
  assert.ok(String(ex2.entryBlock(0, 'aggressive-flow')).startsWith('killed:daily-loss'));
  process.env.KILL_SWITCH = 'true';
  const ex3 = new LiveExecutor({ cfg, keypair: kp, connection: fakeConnection(), liveState: {}, http: {}, jup: fakeJup, web3 });
  assert.strictEqual(ex3.entryBlock(0, 'aggressive-flow'), 'KILL_SWITCH env');
  delete process.env.KILL_SWITCH;
});
test('secrets are redacted from logs and errors', () => {
  process.env.WALLET_PRIVATE_KEY = KEY;
  process.env.KILL_TOKEN = 'supersecrettoken123';
  const out = redact(new Error(`boom ${KEY} token=supersecrettoken123 arr=${JSON.stringify(Array.from(kp.secretKey))}`));
  assert.ok(!out.includes(KEY) && !out.includes('supersecrettoken123') && !out.includes(String(kp.secretKey[5]) + ',' + String(kp.secretKey[6])));
  delete process.env.WALLET_PRIVATE_KEY; delete process.env.KILL_TOKEN;
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} live tests passed`);
})();
