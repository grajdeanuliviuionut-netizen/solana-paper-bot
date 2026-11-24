// t118u (Liviu 24 Nov): the 24 h 5% drawdown no longer halts. Past 5% new entries are sized at half (2.5% of equity)
// and trading continues; back under 5% -> normal 5% sizing. halted stays false. LIVE config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-sizecut-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const T10 = require('../src/books/top10');
const M15 = require('../src/books/m15');
const improver = require('../src/improver');
const H = require('../src/halt');

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



const pt = (minAgo, eq) => ({ t: new Date(NOW - minAgo * MIN).toISOString(), markEquity: eq });

test('live config: size-cut mode by default (5% / 24 h, half size), v6.03 runner unchanged', () => {
  assert.strictEqual(H.mode(config.halt), 'size-cut'); assert.strictEqual(config.halt.dropPct, 5); assert.strictEqual(config.halt.windowHours, 24);
  const b = RH(); assert.strictEqual(b.version, 6.03); assert.strictEqual(b.exit.stopLossPct, 2.5); assert.strictEqual(b.entry.minLiquidityUsd, 100000);
  assert.deepStrictEqual(b.exit.partial, { atPct: 8, sellPct: 50 }); assert.strictEqual(b.entry.trend.minAbovePct, 1); assert.strictEqual(config.books.maxOpenPerBook, 2);
  assert.strictEqual(b.entry.sizing.pctOfEquity, 5); assert.deepStrictEqual(b.entry.lossStreakPause, { losses: 2, minutes: 30, pauseScanning: true }); assert.strictEqual(b.entry.stopCooldownHours, 24);
  const v = H.sizeCutView({}, config.halt); assert.strictEqual(v.sizeCutActive, false); assert.strictEqual(v.sizeMultiplier, 1); assert.strictEqual(v.cutMultiplier, 0.5);
});

test('drawdown past 5% -> size cut (x0.5), never halted; back under 5% -> normal size; history kept', () => {
  const st = {};
  let r = H.check(st, [pt(60, 3), pt(1, 2.86)], NOW, config.halt);   // -4.67%
  assert.strictEqual(r.triggered, false); assert.strictEqual(r.sizeCut, null); assert.strictEqual(H.sizeMultiplier(st), 1); assert.ok(!H.isHalted(st));
  r = H.check(st, [pt(60, 3), pt(1, 2.84)], NOW, config.halt);       // -5.33%
  assert.strictEqual(r.sizeCut, 'cut'); assert.strictEqual(r.triggered, false); assert.ok(!H.isHalted(st)); assert.strictEqual(st.halt, undefined, 'no halt record');
  assert.strictEqual(H.sizeMultiplier(st), 0.5); near(st.sizeCut.dropPct, 5.333, '', 1e-3);
  let v = H.sizeCutView(st, config.halt); assert.strictEqual(v.sizeCutActive, true); assert.strictEqual(v.sizeMultiplier, 0.5); assert.strictEqual(v.mode, 'size-cut'); assert.ok(v.since);
  r = H.check(st, [pt(60, 3), pt(1, 2.8)], NOW + 5000, config.halt); assert.strictEqual(r.sizeCut, null, 'still cut, no duplicate event'); assert.strictEqual(st.sizeCut.cuts, 1);
  r = H.check(st, [pt(60, 3), pt(0, 2.9)], NOW + 60000, config.halt);  // -3.33%
  assert.strictEqual(r.sizeCut, 'restore'); assert.strictEqual(H.sizeMultiplier(st), 1); assert.ok(!H.isHalted(st));
  v = H.sizeCutView(st, config.halt); assert.strictEqual(v.sizeCutActive, false); assert.strictEqual(v.sizeMultiplier, 1);
  assert.deepStrictEqual(st.sizeCut.history.map(x => x.action), ['restore', 'cut']);
});

test('a legacy persisted halt is lifted in size-cut mode; HALT_CLEAR_ID-style clear on a non-halted state is a no-op', () => {
  const st = { halt: { halted: true, id: 'halt-old', reason: 'equity -5.25%' } };
  H.check(st, [pt(60, 3), pt(1, 2.84)], NOW, config.halt);
  assert.strictEqual(H.isHalted(st), false); assert.strictEqual(st.halt.clearedBy, 'size-cut mode (t118u)'); assert.strictEqual(H.sizeMultiplier(st), 0.5);
  assert.strictEqual(H.clear(st, 'env HALT_CLEAR_ID', NOW), false);
  const st2 = {}; H.check(st2, [pt(60, 3), pt(1, 2.5)], NOW, Object.assign({}, config.halt, { mode: 'halt' })); assert.strictEqual(H.isHalted(st2), true, 'legacy halt mode still works when asked for');
});

test('entries: normal 5% of equity; half (2.5%) while the size cut is active; entries continue; restore -> 5% again', async () => {
  let h = harness(); let p = await h.enter();
  near(p.sizeSol, 0.2, '5% of 4 SOL', 1e-9); assert.strictEqual(p.sizing.sizeMultiplier, 1); assert.strictEqual(p.sizing.sizeCut, false);
  h = harness(); h.state.sizeCut = { active: true, mult: 0.5 }; p = await h.enter();
  assert.ok(p, 'entry not blocked by the drawdown'); near(p.sizeSol, 0.1, '2.5% of 4 SOL', 1e-9); assert.strictEqual(p.sizing.sizeMultiplier, 0.5); assert.strictEqual(p.sizing.effectivePctOfEquity, 2.5); assert.strictEqual(p.sizing.sizeCut, true);
  assert.ok(!/HALTED/.test(String((h.state.books.lastScan || {}).note || '')));
  h = harness(); h.state.sizeCut = { active: false, mult: 0.5 }; p = await h.enter(); near(p.sizeSol, 0.2, 'restored', 1e-9);
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' sizecut tests passed');
  if (passed !== tests.length) process.exit(1);
})();
