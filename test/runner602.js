// t100u (Liviu 22 Nov 20:49): runner-hunter v6.02 "filter-on" - entry unchanged (price >= 1% above a rising MA50),
// exits: -4% stop, half sold at +8%, runner with a 4% trail from its peak and a breakeven floor, 240 min cap; Manager
// changes frozen (no new variants). LIVE config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-runner602-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const T10 = require('../src/books/top10');
const M15 = require('../src/books/m15');
const improver = require('../src/improver');

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



test('live config: v6.02 filter-on, half at +8%, 4% trail, breakeven floor, -4% stop, cap 2, Manager frozen', () => {
  const b = RH();
  assert.strictEqual(config.books.epoch, 'runner-v6'); assert.strictEqual(b.version, 6.02);
  assert.deepStrictEqual(b.previousVersions.map(v => v.version).slice(0, 3), [6.01, 6, 5]);
  assert.strictEqual(b.entry.trend.minAbovePct, 1); assert.strictEqual(b.entry.trend.requireMaRising, true); assert.strictEqual(b.entry.minLiquidityUsd, 50000);
  assert.strictEqual(config.books.maxOpenPerBook, 2); assert.strictEqual(b.entry.sizing.pctOfEquity, 5);
  assert.deepStrictEqual(b.entry.lossStreakPause, { losses: 2, minutes: 30, pauseScanning: true });
  const x = b.exit;
  assert.strictEqual(x.stopLossPct, 4); assert.deepStrictEqual(x.partial, { atPct: 8, sellPct: 50 }); assert.strictEqual(x.trailAfterPartial, true);
  assert.strictEqual(x.trailPct, 4); assert.strictEqual(x.breakevenAfterPartial, true); assert.strictEqual(x.maxHoldMinutes, 240); assert.strictEqual(x.takeProfitPct, undefined);
  assert.strictEqual(config.manager.applyChanges, false);
  assert.deepStrictEqual(config.onlyStrategies, ['runner-hunter']);
  assert.strictEqual(improver.HARD_V6['exit.stopLossPct'].max, 4);
});

test('+8%: half sold through the ladder (2% fill), runner keeps going; trail 4% off the peak closes it; net = both legs', async () => {
  const h = harness(); await h.enter();
  await h.pass(1.079); assert.strictEqual(h.state.books.open[0].partialDone, false);
  await h.pass(1.081);
  const p = h.state.books.open[0]; assert.ok(p && p.partialDone, 'still open after the half');
  assert.strictEqual(p.legs.length, 1); assert.strictEqual(p.legs[0].reason, 'partial-tp'); assert.strictEqual(p.legs[0].sellPctOfOriginal, 50);
  assert.strictEqual(p.legs[0].fillSlippageBps, 200); assert.strictEqual(p.legs[0].costs.simSlipPct, 2); near(p.remainingFrac, 0.5, 'half left', 1e-9);
  await h.pass(1.2); await h.pass(1.16); assert.strictEqual(h.state.books.open.length, 1, '-3.3% off the peak: held');
  await h.pass(1.15); assert.strictEqual(h.trades.length, 1);
  const tr = h.trades[0]; assert.strictEqual(tr.exitReason, 'trail'); assert.strictEqual(tr.legs.length, 2);
  near(tr.pnlSol, tr.legs[0].pnlSol + tr.legs[1].pnlSol, 'combined', 1e-9);
  near(tr.pnlPct, ((0.5 * 0.98 * 1.081 * 0.98 + 0.5 * 0.98 * 1.15 * 0.98) - 1) * 100, 'net both legs', 0.1);
});

test('runner floor at the entry price after the half: breakeven exit; before the half the -4% stop applies; 240 min cap', async () => {
  let h = harness(); await h.enter();
  await h.pass(1.09); await h.pass(1.06); assert.strictEqual(h.state.books.open.length, 1, 'trail not hit yet');
  await h.pass(0.999); // a gap through the trail straight below entry assert.strictEqual(h.trades[0].exitReason, 'breakeven'); assert.ok(h.trades[0].pnlSol > 0, 'half at +9% keeps the trade positive');
  h = harness(); await h.enter(); await h.pass(0.961); assert.strictEqual(h.state.books.open.length, 1); await h.pass(0.959); assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.strictEqual(h.trades[0].legs.length, 1);
  h = harness(); await h.enter(); await h.pass(1.03, 239 * MIN); assert.strictEqual(h.state.books.open.length, 1); await h.pass(1.03, 61000); assert.strictEqual(h.trades[0].exitReason, 'time');
  h = harness(); await h.enter(); await h.pass(1.1); await h.pass(1.12, 241 * MIN); assert.strictEqual(h.trades[0].exitReason, 'time', 'runner also capped at 240 min');
});

test('half sale uses the slippage ladder when the first quote fails (fill at the slippage used)', async () => {
  const h = harness(); await h.enter();
  h.okFromBps = 1000; await h.pass(1.1);
  const leg = h.state.books.open[0].legs[0]; assert.strictEqual(leg.reason, 'partial-tp'); assert.strictEqual(leg.fillSlippageBps, 1000); assert.strictEqual(leg.costs.simSlipPct, 10);
  assert.deepStrictEqual(leg.exitLadder.map(a => a.result), ['failed', 'failed', 'ok']);
});

test('Manager frozen: a review is logged but no new variant/version is created', () => {
  const book = JSON.parse(JSON.stringify(RH()));
  const tr = []; for (let i = 1; i <= 10; i++) tr.push({ id: 'T' + i, book: 'runner-hunter', bookVersion: 6.02, closedAt: new Date(NOW + i * MIN).toISOString(), pnlSol: -0.008, pnlPct: -8, exitReason: 'sl', holdMinutes: 20, legs: [], entrySignal: { top10Pct: 10 } });
  const st = { scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() }, books: { trades: tr.reverse() } };
  const e = improver.step(st, book, { baseVersion: 6.02, now: NOW, frozen: true });
  assert.strictEqual(e.applied, false); assert.strictEqual(book.version, 6.02); assert.strictEqual(book.entry.trend.minAbovePct, 1); assert.ok(/frozen/.test(e.why));
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' runner602 tests passed');
  if (passed !== tests.length) process.exit(1);
})();
