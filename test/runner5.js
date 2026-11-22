// t90u (Liviu 22 Nov 13:56): runner-hunter v5 "Boss Rules" - busy breakout entry, dynamic +2/+3/+4% TP, 25 min
// time limit, -6% stop with Data Feed Protection, 2-loss/30-min pause, Night Hours Skip, 5%-of-equity sizing,
// RugCheck top-10 + authorities, Manager v5 hard limits. LIVE config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-runner5-'));
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
  let t = o.now || NOW; const h = { mult: 1.0, fail: false, trades: [], top: o.top10 || { ok: true, top10Pct: 12, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' }, ph: o.ph === undefined ? { priorHigh: 0.001, fromMin: 45, toMin: 5, points: 40, source: 'geckoterminal-ohlcv-1m' } : o.ph, equity: o.equity || 4 };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: String(Math.round(sol / 0.05 * 10000000000)), priceImpactPct: 0.5, route: 'Ray' }),
    sellQuote: async (mint, raw) => h.fail ? { ok: false, error: 'timeout' } : ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * h.mult)), priceImpactPct: 0.4, route: 'Ray' })
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const top10 = { check: async () => h.top };
  const m15 = { gt: async () => ({ pct: 3, fromAgeMin: 15, source: 'geckoterminal-ohlcv-1m' }), priorHighGt: async () => h.ph };
  const fees = { current: () => FEE };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, fees, random: () => 0.5, equityNow: () => h.equity, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v5', since: new Date(NOW - MIN).toISOString() } };
  h.adv = ms => { t += ms; };
  h.now = () => t;
  h.enter = async r => { await h.books.runEntries(h.state, [r || row({ fetchedAt: t - 5000 })], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'runner-hunter' && (!r || p.mint === r.mint)); };
  h.pass = async (mult, ms) => { h.mult = mult; h.adv(ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  h.f = () => h.state.books.entryFilters['runner-hunter'].byFilter;
  return h;
}
const near = (a, b, msg, eps) => assert.ok(Math.abs(a - b) < (eps || 1e-9), (msg || '') + ' ' + a + ' vs ' + b);

test('live config is runner-hunter v5 (v4..v1 kept), epoch runner-v5, 4 h hold/trail/breakeven gone', () => {
  const b = RH();
  assert.strictEqual(config.books.epoch, 'runner-v5');
  assert.strictEqual(b.version, 5);
  assert.deepStrictEqual(b.previousVersions.map(v => v.version), [4, 3, 2, 1]);
  assert.deepStrictEqual(b.entry.lossStreakPause, { losses: 2, minutes: 30, pauseScanning: true });
  assert.deepStrictEqual(b.entry.nightSkip, { startHourUtc: 2, endHourUtc: 6 });
  assert.strictEqual(b.entry.breakout.minVolSpike, 3); assert.strictEqual(b.entry.sizing.pctOfEquity, 5);
  assert.strictEqual(b.entry.maxTop10Pct, 15); assert.strictEqual(b.entry.maxSlippageBps, 150); assert.strictEqual(b.entry.stopCooldownHours, 24);
  assert.strictEqual(b.exit.stopLossPct, 6); assert.strictEqual(b.exit.maxHoldMinutes, 25); assert.strictEqual(b.exit.feedStaleSec, 60);
  assert.deepStrictEqual([b.exit.takeProfit.weak.pct, b.exit.takeProfit.moderate.pct, b.exit.takeProfit.strong.pct], [2, 3, 4]);
  for (const k of ['breakevenAtPct', 'trailAfterPct', 'trailPct', 'momentum', 'partial']) assert.strictEqual(b.exit[k], undefined, k);
  assert.ok(b.exit.costModel && b.exit.costModel.stopPenaltyPct === 3);
  assert.strictEqual(config.halt.enabled, true);
});

test('busy breakout: volume spike >= 3x (m5 vs h1/12), m5 > 0, price above the own-history prior high', () => {
  const b = RH();
  assert.strictEqual(E.volSpikeOf(row()), 4);
  assert.ok(/^volSpike/.test(E.entryFails(b, row({ volumeM5: 2900 }), { now: NOW, ticks: {} })));
  assert.ok(/^m5/.test(E.entryFails(b, row({ priceChange: { m5: 0, h1: 10, h6: 10, h24: 20 } }), { now: NOW, ticks: {} })), 'flat token rejected');
  assert.strictEqual(E.entryFails(b, row(), { now: NOW, ticks: {} }), null, 'no own history -> decided by GT later');
  // own ticks 50..0 min ago: prior high (45..5 min ago) = 0.00105
  const s = []; for (let m = 50; m >= 0; m -= 1) s.push([NOW - m * MIN, m === 20 ? 0.00105 : 0.001]);
  assert.strictEqual(E.entryFails(b, row({ priceUsd: 0.00104 }), { now: NOW, ticks: { PR5: s } }), 'breakout: not above the prior high');
  assert.strictEqual(E.entryFails(b, row({ priceUsd: 0.00106 }), { now: NOW, ticks: { PR5: s } }), null);
  // a spike in the last 5 minutes is the breakout itself, not resistance
  const s2 = s.map(([ts, p]) => [ts, NOW - ts < 5 * MIN ? 0.002 : p]);
  assert.strictEqual(M15.priorHighFromTicks(s2, NOW, b.entry.breakout).priorHigh, 0.00105);
  assert.strictEqual(M15.priorHighFromTicks(s.slice(-20), NOW, b.entry.breakout), null, '< 30 min of history -> null');
  // GT candles: max HIGH in window, needs >= 10 candles and a fresh latest candle
  const c = []; for (let m = 0; m < 60; m++) c.push([Math.floor((NOW - m * MIN) / 1000), 1, m === 30 ? 1.2 : 1.1, 0.9, 1, 10]);
  const g = M15.priorHighFromOhlcv(c, NOW, b.entry.breakout); assert.strictEqual(g.priorHigh, 1.2); assert.strictEqual(g.source, 'geckoterminal-ohlcv-1m');
  assert.strictEqual(M15.priorHighFromOhlcv(c.map(r => [r[0] - 600, ...r.slice(1)]), NOW, b.entry.breakout), null, 'stale candles');
});

test('dynamic TP tier is deterministic from the entry momentum', () => {
  const tp = RH().exit.takeProfit;
  assert.deepStrictEqual([E.tpTier(tp, { volSpike: 7, m5: 4 }).pct, E.tpTier(tp, { volSpike: 7, m5: 4 }).tier], [4, 'strong']);
  assert.strictEqual(E.tpTier(tp, { volSpike: 4.5, m5: 0.5 }).pct, 3);
  assert.strictEqual(E.tpTier(tp, { volSpike: 3.2, m5: 2 }).pct, 3);
  assert.strictEqual(E.tpTier(tp, { volSpike: 3.2, m5: 0.5 }).pct, 2);
  assert.ok(/volume spike/.test(E.tpTier(tp, { volSpike: 3.2, m5: 0.5 }).why));
});

test('entry: GT breakout confirmed, TP tier logged, size = exactly 5% of marked equity', async () => {
  const h = harness({ equity: 4 });
  const p = await h.enter();
  assert.ok(p, 'entered');
  near(p.sizeSol, 0.2, 'size'); assert.deepStrictEqual([p.sizing.pctOfEquity, p.sizing.equityUsedSol, p.sizing.sizeSol], [5, 4, 0.2]);
  near(h.state.balance, 2.8, 'balance');
  assert.strictEqual(p.takeProfit.tier, 'moderate'); assert.strictEqual(p.takeProfit.pct, 3); assert.ok(p.takeProfit.why);
  assert.strictEqual(Date.parse(p.takeProfit.deadlineAt) - h.now(), 25 * MIN);
  assert.strictEqual(p.entrySignal.priorHighSource, 'geckoterminal-ohlcv-1m');
  assert.ok(p.feed && p.feed.stale === false);
});

test('entry rejects: GT prior high above price, no breakout data, mint authority from RugCheck', async () => {
  let h = harness({ ph: { priorHigh: 0.0012, fromMin: 45, toMin: 5, points: 40, source: 'geckoterminal-ohlcv-1m' } });
  assert.strictEqual(await h.enter(), undefined); assert.strictEqual(h.f().breakout, 1);
  h = harness({ ph: null });
  assert.strictEqual(await h.enter(), undefined); assert.strictEqual(h.f().breakoutNoData, 1);
  h = harness({ top10: { ok: true, top10Pct: 10, mintAuthority: 'Auth111', freezeAuthority: null, source: 'rugcheck' } });
  assert.strictEqual(await h.enter(), undefined);
  h = harness({ top10: { ok: false, reason: 'top10: unavailable', source: 'none' } });
  assert.strictEqual(await h.enter(), undefined, 'fail-closed');
});

test('exits: full TP at the tier, -6% stop, 25 min time exit; no breakeven/trail', async () => {
  let h = harness(); let p = await h.enter();
  const base = p.entryPrice; assert.ok(base > 0);
  await h.pass(1.02); assert.strictEqual(h.state.books.open.length, 1, '+2% < moderate +3%');
  await h.pass(1.05); assert.strictEqual(h.state.books.open.length, 0, 'mark incl. the 1.25% sim entry slip >= +3%');
  assert.ok(h.trades[0].pnlPct > 0 && h.trades[0].pnlPct < 3, 'net after costs ' + h.trades[0].pnlPct);
  assert.strictEqual(h.trades[0].exitReason, 'tp');
  h = harness(); p = await h.enter();
  await h.pass(1.04); await h.pass(0.995); assert.strictEqual(h.state.books.open.length, 1, 'no breakeven exit');
  await h.pass(0.93); assert.strictEqual(h.trades[0].exitReason, 'sl');
  h = harness(); p = await h.enter();
  await h.pass(1.01, 24 * MIN); assert.strictEqual(h.state.books.open.length, 1);
  await h.pass(1.01, 61000); assert.strictEqual(h.trades[0].exitReason, 'time');
});

test('Data Feed Protection: a stale feed never fires the stop; resumes on a fresh quote and logs the event', async () => {
  const h = harness(); await h.enter();
  h.fail = true;
  for (let i = 0; i < 14; i++) await h.pass(0.5);           // 70 s of failed quotes, price "crashed"
  assert.strictEqual(h.state.books.open.length, 1, 'held while stale');
  const p = h.state.books.open[0];
  assert.strictEqual(p.feed.stale, true); assert.strictEqual(h.state.books.feed.staleEvents, 1); assert.strictEqual(h.state.books.feed.openStale, 1);
  for (let i = 0; i < 400; i++) await h.pass(0.5);          // well past 25 min with no feed: still no blind exit
  assert.strictEqual(h.state.books.open.length, 1, 'no no-quote-total-loss for feed-protected positions');
  h.fail = false; await h.pass(0.99);                       // fresh quote: time limit decided on the fresh price
  assert.strictEqual(h.trades.length, 1); assert.strictEqual(h.trades[0].exitReason, 'time');
  const ev = h.state.books.feed.recent[0]; assert.ok(ev.end && ev.durationSec > 60, JSON.stringify(ev));
  assert.strictEqual(h.state.books.feed.openStale, 0);
});

test('Night Hours Skip 02:00-06:00 UTC: no entries, counted and logged once', async () => {
  const h = harness({ now: Date.parse('2026-11-22T03:00:00Z') });
  assert.strictEqual(await h.enter(), undefined);
  await h.enter();
  assert.strictEqual(h.state.books.night.skips, 2); assert.strictEqual(h.f().nightHoursSkip, 2);
  const h2 = harness({ now: Date.parse('2026-11-22T06:00:00Z') });
  assert.ok(await h2.enter(), '06:00 UTC trades again');
});

test('2 consecutive losses pause scanning and entries for 30 min; open positions keep exiting', async () => {
  const h = harness();
  await h.enter(row({ mint: 'A', pairAddress: 'PA' })); await h.pass(0.9);
  await h.enter(row({ mint: 'B', pairAddress: 'PB' })); await h.pass(0.9);
  assert.strictEqual(h.trades.length, 2);
  assert.ok(h.books.lossPaused(h.state, 'runner-hunter', h.now()));
  assert.strictEqual(await h.enter(row({ mint: 'C', pairAddress: 'PC', fetchedAt: h.now() - 5000 })), undefined); assert.ok(h.f().lossStreakPause >= 1, 'paused, not stale');
  h.adv(30 * MIN + 1000);
  assert.ok(await h.enter(row({ mint: 'D', pairAddress: 'PD', fetchedAt: h.now() - 5000 })), 'trades again after 30 min');
});

test('RugCheck top-10: per owner, LP/pool/AMM/burn excluded, authorities surfaced, fail-closed', () => {
  const rep = { mintAuthority: null, freezeAuthority: null, totalHolders: 900,
    markets: [{ pubkey: 'MKT', liquidityA: 'LPA', liquidityB: 'LPB' }],
    knownAccounts: { AMMOWN: { name: 'Raydium', type: 'AMM' } },
    topHolders: [{ address: 'x1', owner: 'AMMOWN', pct: 30 }, { address: 'LPA', owner: 'LPA', pct: 5 }, { address: 'x2', owner: 'W1', pct: 4 }, { address: 'x3', owner: 'W1', pct: 2 }, { address: 'x4', owner: 'W2', pct: 3 }] };
  const r = T10.evaluateRugcheck(rep, 'MKT');
  assert.strictEqual(r.ok, true); near(r.top10Pct, 9, 'top10');
  assert.strictEqual(r.mintAuthority, null); assert.strictEqual(r.freezeAuthority, null);
  assert.strictEqual(T10.evaluateRugcheck({ topHolders: [] }, 'MKT').ok, false);
  assert.strictEqual(T10.evaluateRugcheck(Object.assign({}, rep, { mintAuthority: 'Auth' }), 'MKT').mintAuthority, 'Auth');
});

test('Manager v5: one change per 10 trades, can only tighten the hard rules', () => {
  assert.ok(improver.isV5(RH()));
  assert.strictEqual(improver.HARD_V5['exit.stopLossPct'].max, 6); assert.strictEqual(improver.HARD_V5['exit.maxHoldMinutes'].max, 25);
  assert.strictEqual(improver.HARD_V5['entry.breakout.minVolSpike'].min, 3);
  for (const [k, b] of Object.entries(improver.BOUNDS_V5)) { const hl = improver.HARD_V5[k]; if (hl && hl.max != null) assert.ok(b.max <= hl.max, k); if (hl && hl.min != null) assert.ok(b.min >= hl.min, k); }
  const book = JSON.parse(JSON.stringify(RH()));
  const tr = []; for (let i = 1; i <= 10; i++) tr.push({ id: 'T' + i, book: 'runner-hunter', bookVersion: 5, closedAt: new Date(NOW + i * MIN).toISOString(), pnlSol: -0.003, pnlPct: -2, exitReason: 'time', holdMinutes: 25, legs: [], entrySignal: { h1: 5, top10Pct: 10 } });
  const st = { scoreboard: { epoch: 'runner-v5', since: new Date(NOW - MIN).toISOString() }, books: { trades: tr.reverse() } };
  const e = improver.step(st, book, { baseVersion: 5, now: NOW });
  assert.strictEqual(e.rule, 'R4'); assert.strictEqual(e.change, 'entry.minM5'); assert.strictEqual(book.version, 5.01);
  assert.strictEqual(book.exit.stopLossPct, 6); assert.strictEqual(book.exit.maxHoldMinutes, 25); assert.strictEqual(book.entry.breakout.minVolSpike, 3);
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' runner5 tests passed');
  if (passed !== tests.length) process.exit(1);
})();
