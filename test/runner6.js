// t93u (Liviu 22 Nov 14:53): runner-hunter v6 Trend Following - liquidity > $50k and price above the 50-period
// 1 min SMA, -4% stop / +8% TP on the price move, flat 2% paper slippage per fill, Boss Rules risk (2-loss pause,
// night skip, feed protection), 5% sizing, rug gates, Manager v6 limits. LIVE config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-runner6-'));
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


test('live config: runner-hunter v6 "Trend Following", epoch runner-v6, v5..v1 kept, v5 filters dropped', () => {
  const b = RH();
  assert.strictEqual(config.books.epoch, 'runner-v6');
  assert.strictEqual(Math.floor(b.version), 6); assert.strictEqual(b.name, 'Trend Following');
  assert.deepStrictEqual(b.previousVersions.map(v => v.version).filter(v => v < 6), [5, 4, 3, 2, 1]);
  assert.strictEqual(b.entry.minLiquidityUsd, 50000); assert.strictEqual(b.entry.trend.maPeriod, 50);
  for (const k of ['maxLiquidityUsd', 'minVolumeToLiquidityH24', 'minM5', 'minM15', 'maxH1', 'breakout']) assert.strictEqual(b.entry[k], undefined, k);
  assert.deepStrictEqual(b.entry.rugCheck, { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' });
  assert.strictEqual(b.entry.maxTop10Pct, 15); assert.strictEqual(b.entry.maxSlippageBps, 150); assert.strictEqual(b.entry.stopCooldownHours, 24);
  assert.deepStrictEqual(b.entry.lossStreakPause, { losses: 2, minutes: 30, pauseScanning: true });
  assert.deepStrictEqual(b.entry.nightSkip, { startHourUtc: 2, endHourUtc: 6 }); assert.strictEqual(b.entry.sizing.pctOfEquity, 5);
  assert.strictEqual(b.exit.stopLossPct, 4); assert.strictEqual(b.exit.takeProfitPct, 8); assert.strictEqual(b.exit.maxHoldMinutes, 240); assert.strictEqual(b.exit.feedStaleSec, 60);
  for (const k of ['takeProfit', 'breakevenAtPct', 'trailPct', 'trailAfterPct', 'momentum', 'partial']) assert.strictEqual(b.exit[k], undefined, k);
  assert.deepStrictEqual([b.exit.costModel.simSlipMinPct, b.exit.costModel.simSlipMaxPct, b.exit.costModel.stopPenaltyPct, b.exit.costModel.feePctPerSide, b.exit.costModel.priorityFee], [2, 2, 0, 0, true]);
  assert.strictEqual(config.halt.enabled, true);
});

test('50 MA: own ticks resampled to 1 min (>= 50 min coverage) and GeckoTerminal closes (>= 50, fresh)', () => {
  const o = RH().entry.trend;
  const s = []; for (let sec = 55 * 60; sec >= 0; sec -= 45) s.push([NOW - sec * 1000, sec < 25 * 60 ? 2 : 1]);
  const m = M15.smaFromTicks(s, NOW, o);
  assert.ok(m && m.source === 'own-history-1m' && m.candles === 50);
  near(m.ma, (25 * 2 + 25 * 1) / 50, 'ma', 0.05);
  assert.strictEqual(M15.smaFromTicks(s.filter(x => NOW - x[0] < 40 * MIN), NOW, o), null, '< 50 min of history');
  const c = []; for (let k = 0; k < 60; k++) c.push([Math.floor((NOW - k * MIN) / 1000), 1, 1, 1, k < 50 ? 1 + k / 100 : 9, 5]);
  const g = M15.smaFromOhlcv(c, NOW, o); near(g.ma, 1.245, 'gt ma', 1e-9); assert.strictEqual(g.source, 'geckoterminal-ohlcv-1m');
  assert.strictEqual(M15.smaFromOhlcv(c.slice(0, 49), NOW, o), null, '< 50 candles');
  assert.strictEqual(M15.smaFromOhlcv(c.map(r => [r[0] - 400, ...r.slice(1)]), NOW, o), null, 'newest candle > 3 min old');
});

test('entry rules: liquidity must be > $50k; own-history MA decides above/below', () => {
  const b = RH();
  assert.ok(/^liquidity/.test(E.entryFails(b, row({ liquidityUsd: 50000 }), { now: NOW, ticks: {} })));
  assert.strictEqual(E.entryFails(b, row({ liquidityUsd: 50001, priceChange: { m5: -5, h1: 80, h6: 0, h24: 0 }, volumeH24: 1 }), { now: NOW, ticks: {} }), null, 'old v5 filters gone');
  const s = []; for (let sec = 60 * 60; sec >= 0; sec -= 45) s.push([NOW - sec * 1000, 0.001 + (3600 - sec) * 1e-8]);
  assert.ok(/^belowMA/.test(E.entryFails(b, row({ priceUsd: 0.001 }), { now: NOW, ticks: { PR5: s } })));
  assert.strictEqual(E.entryFails(b, row({ priceUsd: 0.0011 }), { now: NOW, ticks: { PR5: s } }), null);
});

test('entry: GT MA above -> buy 5% of equity, MA + distance logged; flat 2% slip on the fill', async () => {
  const h = harness({ equity: 4 });
  const p = await h.enter();
  assert.ok(p, 'entered');
  near(p.sizeSol, 0.2, 'size'); assert.strictEqual(p.sizing.equityUsedSol, 4);
  assert.strictEqual(p.trend.ma, 0.001); near(p.trend.maDistPct, 10, 'dist', 1e-6); assert.strictEqual(p.trend.maSource, 'geckoterminal-ohlcv-1m');
  assert.strictEqual(p.entryCosts.simSlipPct, 2); assert.strictEqual(p.entryCosts.feeSol, 0);
  assert.strictEqual(p.tokensRaw, String(Math.round(0.2 / 0.05 * 1e10 * 0.98)));
  near(p.exitRefSol, 0.2 * 0.98, 'ref', 1e-9);
  assert.strictEqual(p.takeProfit, undefined, 'no v5 TP tier');
});

test('entry rejects: below MA (GT), no MA data (fail closed), rug authority, top-10 > 15%; MA result cached', async () => {
  let h = harness({ sma: { ma: 0.0012, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 20 } });
  assert.strictEqual(await h.enter(), undefined); assert.strictEqual(h.f().belowMA, 1);
  h.adv(45000); await h.enter(row({ fetchedAt: h.now() - 5000 })); assert.strictEqual(h.gtCalls, 1, 'cached 120 s'); assert.strictEqual(h.f().belowMA, 2);
  h = harness({ sma: null });
  assert.strictEqual(await h.enter(), undefined); assert.strictEqual(h.f().maNoData, 1);
  h = harness({ sma: { error: '429' } });
  assert.strictEqual(await h.enter(), undefined); assert.strictEqual(h.f().maDeferred, 1);
  assert.ok(!h.f().maUnavailable, 'a 429 is deferred, not a final maUnavailable reject');
  assert.ok(!((h.state.books.rejects.byReason || {})['maUnavailable: GeckoTerminal 429 (fail closed, retried)']));
  h.sma = { ma: 0.001, maPrev: 0.00099, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 20 }; h.adv(45000);
  assert.ok(await h.enter(row({ fetchedAt: h.now() - 5000 })), 'a GT error is not cached: retried next scan');
  h = harness({ top10: { ok: true, top10Pct: 10, mintAuthority: 'Auth111', freezeAuthority: null, source: 'rugcheck' } });
  assert.strictEqual(await h.enter(), undefined); assert.ok(h.state.books.rug.blacklist.R5mint, 'blacklisted');
  h = harness({ top10: { ok: true, top10Pct: 20, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' } });
  assert.strictEqual(await h.enter(), undefined);
  h = harness({ top10: { ok: false, reason: 'down', source: 'none' } });
  assert.strictEqual(await h.enter(), undefined, 'fail closed');
});

test('exits on the price move: -4% stop, +8% TP (full); net after 2% slip each side; 240 min cap', async () => {
  let h = harness(); await h.enter();
  await h.pass(0.97); assert.strictEqual(h.state.books.open.length, 1, '-3% move: held (cost-basis mark is ~-5%)');
  await h.pass(0.959); assert.strictEqual(h.trades[0].exitReason, 'sl');
  near(h.trades[0].pnlPct, (0.98 * 0.959 * 0.98 - 1) * 100, 'sl net', 0.05);
  h = harness(); await h.enter();
  await h.pass(1.079); assert.strictEqual(h.state.books.open.length, 1);
  await h.pass(1.081); assert.strictEqual(h.trades[0].exitReason, 'tp');
  near(h.trades[0].pnlPct, (0.98 * 1.081 * 0.98 - 1) * 100, 'tp net', 0.05);
  h = harness(); await h.enter();
  await h.pass(1.02, 239 * MIN); assert.strictEqual(h.state.books.open.length, 1, 'no 25 min limit any more');
  await h.pass(1.02, 61000); assert.strictEqual(h.trades[0].exitReason, 'time');
});

test('feed protection: no stop on a stale feed; decided on the first fresh quote', async () => {
  const h = harness(); await h.enter();
  h.fail = true; for (let i = 0; i < 14; i++) await h.pass(0.5);
  assert.strictEqual(h.state.books.open.length, 1); assert.strictEqual(h.state.books.open[0].feed.stale, true);
  h.fail = false; await h.pass(0.95);
  assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.ok(h.state.books.feed.recent[0].durationSec >= 60);
});

test('Boss Rules on v6: night skip 02-06 UTC and 2 losses -> 30 min pause', async () => {
  const n = harness({ now: Date.parse('2026-11-22T02:30:00Z') });
  assert.strictEqual(await n.enter(), undefined); assert.strictEqual(n.f().nightHoursSkip, 1);
  const h = harness();
  await h.enter(row({ mint: 'A', pairAddress: 'PA' })); await h.pass(0.9);
  h.mult = 1; await h.enter(row({ mint: 'B', pairAddress: 'PB', fetchedAt: h.now() - 5000 })); await h.pass(0.9);
  assert.strictEqual(h.trades.length, 2, JSON.stringify(h.state.books.rejects && h.state.books.rejects.recent && h.state.books.rejects.recent.slice(0, 3)));
  assert.strictEqual(await h.enter(row({ mint: 'C', pairAddress: 'PC', fetchedAt: h.now() - 5000 })), undefined); assert.ok(h.f().lossStreakPause >= 1);
  h.adv(30 * MIN + 1000);
  assert.ok(await h.enter(row({ mint: 'D', pairAddress: 'PD', fetchedAt: h.now() - 5000 })));
});

test('Manager v6: cannot loosen the stop beyond -4, the liquidity floor below $50k or touch the rug gates', () => {
  assert.ok(improver.isV6(RH()));
  assert.strictEqual(improver.HARD_V6['exit.stopLossPct'].max, 4); assert.strictEqual(improver.HARD_V6['entry.minLiquidityUsd'].min, 50000);
  assert.ok(improver.BOUNDS_V6['exit.stopLossPct'].max <= 4 && improver.BOUNDS_V6['entry.minLiquidityUsd'].min >= 50000);
  for (const k of Object.keys(improver.BOUNDS_V6)) assert.ok(!/rugCheck|trend\.maPeriod|lossStreak|nightSkip|sizing|costModel/.test(k), k);
  const book = JSON.parse(JSON.stringify(RH()));
  const tr = []; for (let i = 1; i <= 10; i++) tr.push({ id: 'T' + i, book: 'runner-hunter', bookVersion: 6, closedAt: new Date(NOW + i * MIN).toISOString(), pnlSol: -0.008, pnlPct: -8, exitReason: 'sl', holdMinutes: 20, legs: [], entrySignal: { top10Pct: 10 } });
  const st = { scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() }, books: { trades: tr.reverse() } };
  const e = improver.step(st, book, { baseVersion: 6, now: NOW });
  assert.strictEqual(e.rule, 'R1'); assert.strictEqual(e.change, 'entry.trend.minAbovePct'); assert.strictEqual(book.version, +(RH().version + 0.01).toFixed(2)); assert.ok(book.entry.trend.minAbovePct >= 1);
  assert.strictEqual(book.exit.stopLossPct, 4); assert.strictEqual(book.entry.minLiquidityUsd, 50000); assert.deepStrictEqual(book.entry.rugCheck, RH().entry.rugCheck);
});


test('exit ladder: failed/stale first quote -> 3%, 10%, 25%; stop fires only on a fresh quote; fill at the slippage used', async () => {
  assert.deepStrictEqual(config.books.exitLadder, { bps: [200, 300, 1000, 2500], maxQuoteAgeMs: 2000 });
  let h = harness(); await h.enter();
  h.okFromBps = 1000; await h.pass(0.95);
  const tr = h.trades[0]; assert.strictEqual(tr.exitReason, 'sl');
  const leg = tr.legs[0]; assert.strictEqual(leg.fillSlippageBps, 1000);
  assert.deepStrictEqual(leg.exitLadder.map(a => [a.slippageBps, a.result]), [[200, 'failed'], [300, 'failed'], [1000, 'ok']]);
  assert.ok(leg.exitLadder.every(a => typeof a.ms === 'number'));
  assert.strictEqual(leg.costs.simSlipPct, 10);
  near(tr.pnlPct, (0.98 * 0.95 * 0.90 - 1) * 100, 'net at 10% fill slip', 0.05);
  assert.strictEqual(h.state.books.exitLadder.byFillBps['1000'], 1);
  // stale (> 2 s) first quotes escalate too; a fresh 3% quote fills at 3%
  h = harness(); await h.enter(); h.staleBelow = 300; await h.pass(0.95);
  assert.strictEqual(h.trades[0].legs[0].fillSlippageBps, 300); assert.deepStrictEqual(h.trades[0].legs[0].exitLadder.map(a => a.result), ['stale', 'ok']);
  // no fresh quote at any rung: nothing fires from an old price
  h = harness(); await h.enter(); h.okFromBps = 99999; await h.pass(0.5);
  assert.strictEqual(h.trades.length, 0); assert.strictEqual(h.state.books.exitLadder.noFreshQuote, 1);
  h.okFromBps = 0; await h.pass(0.99); assert.strictEqual(h.trades.length, 0, '-1% move: no stop'); assert.strictEqual(h.state.books.open[0].legs.length, 0);
  // normal pass: one quote at 200 bps, fill at the flat 2%
  await h.pass(1.09); assert.strictEqual(h.trades[0].exitReason, 'tp'); assert.strictEqual(h.trades[0].legs[0].fillSlippageBps, 200); assert.strictEqual(h.trades[0].legs[0].costs.simSlipPct, 2);
});


test('t98u trend confirmation: price >= MA50 + 1% and MA50 rising (now > 5 candles ago); counters, maSlope, Manager floor', async () => {
  const T = Object.assign({}, RH().entry.trend, { minAbovePct: 1, requireMaRising: true, risingLookbackCandles: 5 });
  const b = JSON.parse(JSON.stringify(RH())); b.entry.trend = T;
  // own history 60 min: rising line 0.001 -> 0.00106
  const up = []; for (let sec = 60 * 60; sec >= 0; sec -= 45) up.push([NOW - sec * 1000, 0.001 + (3600 - sec) / 3600 * 0.00006]);
  const s = M15.smaFromTicks(up, NOW, T); assert.ok(s.maPrev > 0 && s.ma > s.maPrev && s.maSlopePct > 0, JSON.stringify(s));
  assert.ok(/^belowMA/.test(E.entryFails(b, row({ priceUsd: s.ma * 0.999 }), { now: NOW, ticks: { PR5: up } })));
  assert.ok(/^belowMinAbove/.test(E.entryFails(b, row({ priceUsd: s.ma * 1.005 }), { now: NOW, ticks: { PR5: up } })));
  assert.strictEqual(E.entryFails(b, row({ priceUsd: s.ma * 1.011 }), { now: NOW, ticks: { PR5: up } }), null);
  const down = up.map(([ts, p]) => [ts, 0.00206 - p]);
  const sd = M15.smaFromTicks(down, NOW, T); assert.ok(sd.ma < sd.maPrev);
  assert.ok(/^maNotRising/.test(E.entryFails(b, row({ priceUsd: sd.ma * 1.05 }), { now: NOW, ticks: { PR5: down } })));
  assert.strictEqual(M15.smaFromTicks(up.filter(x => NOW - x[0] <= 52 * MIN), NOW, T).maPrev, null, '< 55 min: no earlier SMA');
  assert.ok(/^maNotRising/.test(E.entryFails(b, row({ priceUsd: 0.002 }), { now: NOW, ticks: { PR5: up.filter(x => NOW - x[0] <= 52 * MIN) } })), 'fails closed');
  // GT candles: 60 newest-first closes, rising
  const c = []; for (let k = 0; k < 60; k++) c.push([Math.floor((NOW - k * MIN) / 1000), 1, 1, 1, 2 - k / 100, 5]);
  const g = M15.smaFromOhlcv(c, NOW, T); near(g.ma, 2 - 0.245, 'ma', 1e-9); near(g.maPrev, 2 - 0.295, 'prev', 1e-9);
  assert.strictEqual(M15.smaFromOhlcv(c.slice(0, 54), NOW, T).maPrev, null, '< 55 candles: no earlier SMA');
  // engine with the t98u params: counters + maSlope on the position
  const book = RH(), keep = book.entry.trend; book.entry.trend = T;
  try {
    let h = harness({ sma: { ma: 0.001, maPrev: 0.00099, maSlopePct: 1.0101, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 20 } });
    let p = await h.enter(row({ priceUsd: 0.001005 })); assert.strictEqual(p, undefined); assert.strictEqual(h.f().belowMinAbove, 1);
    h = harness({ sma: { ma: 0.001, maPrev: 0.00101, maSlopePct: -0.99, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 20 } });
    p = await h.enter(); assert.strictEqual(p, undefined); assert.strictEqual(h.f().maNotRising, 1);
    h = harness({ sma: { ma: 0.001, maPrev: 0.00099, maSlopePct: 1.0101, period: 50, candles: 50, source: 'geckoterminal-ohlcv-1m', newestAgeSec: 20 } });
    p = await h.enter(); assert.ok(p); assert.strictEqual(p.trend.maSlope, 1.0101); assert.strictEqual(p.trend.minAbovePct, 1); assert.strictEqual(p.trend.requireMaRising, true);
  } finally { book.entry.trend = keep; }
  // Manager: minAbovePct never below 1; requireMaRising is not a knob
  assert.strictEqual(improver.HARD_V6['entry.trend.minAbovePct'].min, 1); assert.strictEqual(improver.BOUNDS_V6['entry.trend.minAbovePct'].min, 1);
  assert.ok(!Object.keys(improver.BOUNDS_V6).some(k => /requireMaRising|risingLookback/.test(k)));
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' runner6 tests passed');
  if (passed !== tests.length) process.exit(1);
})();
