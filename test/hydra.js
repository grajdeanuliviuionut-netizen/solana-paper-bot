// t124u (Liviu 24 Nov): HYDRA API - POST /api/halt (operator pause: no new entries in any book, exits keep running,
// persisted), POST /api/resume, GET /api/status, CORS on /api/*. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-hydra-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const T10 = require('../src/books/top10');
const M15 = require('../src/books/m15');
const improver = require('../src/improver');
const hydra = require('../src/hydra');
const http = require('http');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
const NOW = Date.parse('2026-11-22T14:00:00Z');
const RH = () => config.books.list.find(b => b.id === 'runner-hunter');
// volumeH1 12000 -> hour avg 5-min volume 1000; volumeM5 4000 -> spike 4x; m5 2 -> moderate tier (+3%)
const row = o => Object.assign({ pairAddress: 'PR5', mint: 'R5mint', symbol: 'RUN5', name: 'Run5', priceUsd: 0.0011, priceNative: 0.000005, liquidityUsd: 200000,
  volumeH1: 12000, volumeM5: 4000, volumeH6: 60000, volumeH24: 60000, priceChange: { m5: 2, h1: 10, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 30 * 3600000, dexId: 'raydium', fetchedAt: NOW - 5000, ageDays: 5 }, o || {});
const FEE = { microLamports: 3000, sol: 0.0000056, fallback: false, lamports: 5600 };
function harness(o) {
  o = o || {};
  let t = o.now || NOW; const h = { mult: 1.0, fail: false, trades: [], top: o.top10 || { ok: true, top10Pct: 12, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' }, sma: o.sma === undefined ? { ma: 0.001, maPrev: 0.00099, maSlopePct: 1.0101, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 30, spanMin: 50 } : o.sma, gtCalls: 0, equity: o.equity || 4 };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: String(Math.round(sol / 0.05 * 10000000000)), priceImpactPct: 0.5, route: 'Ray' }),
    sellQuote: async (mint, raw, bps) => (h.okFromBps && (bps || 300) < h.okFromBps) ? { ok: false, error: 'route timeout', at: t } : (h.staleBelow && (bps || 300) < h.staleBelow) ? { ok: true, at: t - 5000, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * h.mult)), priceImpactPct: 0.4 } : h.fail ? { ok: false, error: 'timeout' } : ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * h.mult)), priceImpactPct: 0.4, route: 'Ray' })
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const top10 = { check: async () => h.top };
  const m15 = { gt: async () => ({ pct: 3, fromAgeMin: 15, source: 'geckoterminal-ohlcv-1m' }), smaGt: async () => { h.gtCalls++; return h.sma; } };
  const fees = { current: () => FEE };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, fees, random: () => 0.5, equityNow: () => h.equity, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() } };
  h.adv = ms => { t += ms; };
  h.now = () => t;
  h.enter = async r => { await h.books.runEntries(h.state, [r || row({ fetchedAt: t - 5000 })], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'runner-hunter' && (!r || p.mint === r.mint)); };
  h.pass = async (mult, ms) => { h.mult = mult; h.adv(ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  h.f = () => h.state.books.entryFilters['runner-hunter'].byFilter;
  return h;
}
const near = (a, b, msg, eps) => assert.ok(Math.abs(a - b) < (eps || 1e-9), (msg || '') + ' ' + a + ' vs ' + b);




test('pause blocks new entries in every book, open positions still exit (stop), resume re-allows entries', async () => {
  const h = harness();
  const p1 = await h.enter(); assert.ok(p1, 'entry before the pause');
  hydra.setPaused(h.state, true, 'api', h.now());
  assert.ok(hydra.isPaused(h.state));
  const p2 = await h.enter(row({ mint: 'M2', pairAddress: 'P2', symbol: 'TWO', fetchedAt: h.now() - 5000 }));
  assert.strictEqual(p2, undefined, 'no entry while paused'); assert.match(h.state.books.lastScan.note, /PAUSED by API/);
  assert.strictEqual(h.state.books.open.length, 1);
  await h.pass(0.97); assert.strictEqual(h.trades.length, 1, 'exit loop still closes while paused'); assert.strictEqual(h.trades[0].exitReason, 'sl');
  const r = hydra.setPaused(h.state, false, 'api', h.now()); assert.strictEqual(r.paused, false); assert.deepStrictEqual(r.history.map(x => x.paused), [false, true]);
  const p3 = await h.enter(row({ mint: 'M3', pairAddress: 'P3', symbol: 'THREE', fetchedAt: h.now() - 5000 })); assert.ok(p3, 'entries resume');
});

test('pause is independent of the drawdown size cut', () => {
  const st = { sizeCut: { active: true, mult: 0.5 } };
  hydra.setPaused(st, true, 'api', NOW); assert.deepStrictEqual(st.sizeCut, { active: true, mult: 0.5 }); assert.strictEqual(st.halt, undefined);
});

test('token: open when HYDRA_TOKEN unset; constant-time match when set', () => {
  assert.strictEqual(hydra.tokenOk('x', {}), null);
  assert.strictEqual(hydra.tokenOk('nope', { HYDRA_TOKEN: 'secret-123' }), false);
  assert.strictEqual(hydra.tokenOk(undefined, { HYDRA_TOKEN: 'secret-123' }), false);
  assert.strictEqual(hydra.tokenOk('secret-123', { HYDRA_TOKEN: 'secret-123' }), true);
});

test('HTTP: CORS + preflight, /api/status shape, POST /api/halt + /api/resume (persisted), /api/health shows the pause, token when set', async () => {
  delete process.env.HYDRA_TOKEN;
  const idx = require('../src/index');
  const st = idx.getState();
  idx.books.ensure(st).open.push({ id: 'bk-h1', book: 'runner-hunter', strategyId: 'runner-hunter', symbol: 'HYD', mint: 'HYDmint', pairAddress: 'HP', entryTime: new Date(NOW).toISOString(), sizeSol: 0.1, remainingFrac: 1,
    costBasisRemainingSol: 0.1, tokensRemainingRaw: '1000', markPct: 3.21, movePct: 5.5, lastQuote: { outAmount: '103210000' }, legs: [] });
  const server = idx.app.listen(0); const port = server.address().port;
  const req = (method, p, body, headers) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  try {
    for (const p of ['/api/status', '/api/halt', '/api/resume']) {
      const o = await req('OPTIONS', p, null, { origin: 'https://hydra.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-hydra-token' });
      assert.strictEqual(o.status, 204, p); assert.strictEqual(o.headers['access-control-allow-origin'], '*');
      assert.strictEqual(o.headers['access-control-allow-methods'], 'GET,POST,OPTIONS'); assert.strictEqual(o.headers['access-control-allow-headers'], 'Content-Type, x-hydra-token');
    }
    const s = await req('GET', '/api/status'); assert.strictEqual(s.status, 200); assert.strictEqual(s.headers['access-control-allow-origin'], '*');
    const j = JSON.parse(s.body);
    for (const k of ['status', 'equity', 'open_pnl', 'open_positions']) assert.ok(k in j, k);
    assert.strictEqual(j.status, 'online'); assert.strictEqual(typeof j.equity, 'number'); assert.strictEqual(typeof j.open_pnl, 'number'); assert.strictEqual(j.paused, false); assert.strictEqual(j.liveTrading, false);
    const row0 = j.open_positions.find(x => x.symbol === 'HYD');
    assert.deepStrictEqual(row0, { book: 'runner-hunter', symbol: 'HYD', mint: 'HYDmint', entryTime: new Date(NOW).toISOString(), sizeSol: 0.1, pnlPct: 3.21, priceMovePct: 5.5 });
    near(j.open_pnl, 0.10321 - 0.1 * 1.011, 'unrealised net of the 1.1% cost', 1e-6);
    const hh = await req('GET', '/api/health'); assert.strictEqual(hh.headers['access-control-allow-origin'], '*'); assert.strictEqual(JSON.parse(hh.body).paused, false);
    const a = await req('POST', '/api/halt'); assert.strictEqual(a.status, 200);
    const aj = JSON.parse(a.body); assert.deepStrictEqual(Object.keys(aj), ['ok', 'paused', 'at', 'by']); assert.strictEqual(aj.ok, true); assert.strictEqual(aj.paused, true); assert.strictEqual(aj.by, 'api'); assert.ok(Date.parse(aj.at));
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).apiPause.paused, true, 'persisted in state.json');
    const hj = JSON.parse((await req('GET', '/api/health')).body); assert.strictEqual(hj.paused, true); assert.strictEqual(hj.apiPause.by, 'api'); assert.strictEqual(hj.halt.mode, 'size-cut', 'size cut view untouched');
    assert.strictEqual(JSON.parse((await req('GET', '/api/status')).body).paused, true);
    const b = JSON.parse((await req('POST', '/api/halt', { paused: false })).body); assert.strictEqual(b.paused, false);
    await req('POST', '/api/halt'); const c = JSON.parse((await req('POST', '/api/resume')).body); assert.deepStrictEqual([c.ok, c.paused, c.by], [true, false, 'api']);
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).apiPause.paused, false);
    process.env.HYDRA_TOKEN = 'hydra-test-token';
    assert.strictEqual((await req('POST', '/api/halt')).status, 401); assert.strictEqual((await req('POST', '/api/resume', null, { 'x-hydra-token': 'wrong' })).status, 401);
    assert.strictEqual(idx.getState().apiPause.paused, false, 'rejected calls change nothing');
    assert.strictEqual(JSON.parse((await req('POST', '/api/halt', null, { 'x-hydra-token': 'hydra-test-token' })).body).paused, true);
    assert.strictEqual(JSON.parse((await req('POST', '/api/resume', null, { 'x-hydra-token': 'hydra-test-token' })).body).paused, false);
    const old = await req('GET', '/api/pnl'); assert.strictEqual(old.status, 200, 'existing endpoints still answer');
  } finally { delete process.env.HYDRA_TOKEN; server.close(); }
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' hydra tests passed');
  process.exit(passed === tests.length ? 0 : 1);
})();
