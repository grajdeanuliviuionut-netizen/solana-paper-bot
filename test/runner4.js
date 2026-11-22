// t89u (Liviu 22 Nov 13:18): runner-hunter v4 - Executor (slippage limit, priority fee, paper send path + Jito
// stub), paper fill realism (sim slippage, stop penalty, 0.5% fee per side), Rug Check gates + blacklist,
// Strategist exits, 3-loss/1 h pause, 5%/24 h halt, Manager v4 bounds. LIVE config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-runner4-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const X = require('../src/books/executor');
const H = require('../src/halt');
const improver = require('../src/improver');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
const NOW = Date.parse('2026-11-22T14:00:00Z');
const RH = () => config.books.list.find(b => b.id === 'runner-hunter');
const row = o => Object.assign({ pairAddress: 'PR4', mint: 'R4mint', symbol: 'RUN4', name: 'Run4', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 200000,
  volumeH1: 20000, volumeM5: 1000, volumeH6: 60000, volumeH24: 60000, priceChange: { m5: 2, h1: 10, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 30 * 3600000, dexId: 'raydium', fetchedAt: NOW - 5000, ageDays: 5 }, o || {});
const FEE = { microLamports: 3000, sol: 0.0000056, fallback: false, lamports: 5600 };
function harness(o) {
  o = o || {};
  let t = NOW; const h = { mult: 1.0, sellImpact: 0.4, buyImpact: 0.5, trades: [], mintCalls: 0, top: o.top10 || { ok: true, top10Pct: 12, maxHolderPct: 4, excludedPct: 20 }, mint: o.mint || null };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: h.buyImpact, route: 'Ray' }),
    sellQuote: async (mint, raw) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * h.mult)), priceImpactPct: h.sellImpact, route: 'Ray' })
  };
  const mintAuth = { check: async () => { h.mintCalls++; return h.mint || { pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }; } };
  const top10 = { check: async () => h.top };
  const m15 = { gt: async () => ({ pct: 3, fromAgeMin: 15, source: 'geckoterminal-ohlcv-1m' }) };
  const fees = { current: () => FEE };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, fees, random: () => 0.5, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v4', since: new Date(NOW - MIN).toISOString() } };
  h.adv = ms => { t += ms; };
  h.now = () => t;
  h.enter = async r => { await h.books.runEntries(h.state, [r || row({ fetchedAt: t - 5000 })], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'runner-hunter'); };
  h.pass = async (mult, ms) => { h.mult = mult; h.adv(ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  h.f = () => h.state.books.entryFilters['runner-hunter'].byFilter;
  return h;
}
const near = (a, b, msg, eps) => assert.ok(Math.abs(a - b) < (eps || 1e-9), (msg || '') + ' ' + a + ' vs ' + b);
// with random 0.5 -> sim slip 1.25%: credited tokens 9.875e9 raw; quote value at mult m = 0.049375 * m SOL
const pctAt = m => (0.049375 * m / 0.05 - 1) * 100;
const multFor = pct => (1 + pct / 100) * 0.05 / 0.049375;

test('live config: runner-hunter v4 (v3 entry filters + rug + slippage; strategist exits; cost model), v3/v2/v1 kept, epoch runner-v4, halt 5%/24 h', () => {
  const rh = RH();
  assert.strictEqual(rh.version, 4); assert.strictEqual(config.books.epoch, 'runner-v4');
  assert.deepStrictEqual(rh.entry, { minLiquidityUsd: 100000, maxLiquidityUsd: 900000, minVolumeToLiquidityH24: 0.1, minM5: 0, minM15: 0, maxH1: 25, maxTop10Pct: 15,
    maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
    stopCooldownHours: 24, lossStreakPause: { losses: 3, minutes: 60, pauseScanning: true } });
  assert.deepStrictEqual(rh.exit, { stopLossPct: 6, breakevenAtPct: 4, trailAfterPct: 4, trailPct: 3, momentum: { minPct: 4, withinMinutes: 15 }, maxHoldMinutes: 30,
    costModel: { simSlipMinPct: 0.5, simSlipMaxPct: 2.0, stopPenaltyPct: 3, feePctPerSide: 0.5, priorityFee: true, cuLimit: 200000 } });
  assert.ok(!rh.exit.partial, 'the +8% one-third partial is dropped');
  assert.deepStrictEqual(rh.previousVersions.map(v => v.version), [3, 2, 1]);
  assert.deepStrictEqual(config.halt, { enabled: true, windowHours: 24, dropPct: 5 });
  assert.strictEqual(config.manager.enabled, true); assert.strictEqual(config.books.sizeSol, 0.05);
  assert.ok(config.books.exitLoopMs <= 10000 && config.books.maxExitQuoteAgeSec <= 10);
});

test('strategist exits (pure): -6% stop; +4% -> stop to entry + 3% trail; not +4% in 15 min -> exit; 30 min max', () => {
  const ex = RH().exit, p = {};
  assert.strictEqual(E.decideExit(p, ex, -6, 1, 3).reason, 'sl');
  assert.strictEqual(E.decideExit(p, ex, -5.9, 1, 3), null);
  assert.strictEqual(E.decideExit(p, ex, 0, 4, 5).reason, 'breakeven');
  assert.strictEqual(E.decideExit(p, ex, 0, 3.9, 5), null, 'not armed below +4%');
  assert.strictEqual(E.decideExit(p, ex, 6.6, 10, 5).reason, 'trail');
  assert.strictEqual(E.decideExit(p, ex, 6.8, 10, 5), null);
  assert.strictEqual(E.decideExit(p, ex, 1, 3.9, 15).reason, 'no-momentum');
  assert.strictEqual(E.decideExit(p, ex, 1, 3.9, 14.9), null);
  assert.strictEqual(E.decideExit(p, ex, 4, 4.1, 20), null, 'reached +4% -> momentum rule satisfied');
  assert.strictEqual(E.decideExit(p, ex, 4, 4.1, 30).reason, 'time');
});

test('Executor: Slippage Abort over 150 bps (Jupiter impact or fill vs DexScreener), counted; 1.4% enters', async () => {
  let h = harness(); h.buyImpact = 1.6;
  assert.strictEqual(await h.enter(), undefined);
  assert.strictEqual(h.state.books.executor.slippageAborts, 1); assert.strictEqual(h.f().slippageAbort, 1);
  assert.ok(h.state.books.rejects.recent.some(r => /^Slippage Abort/.test(r.reason)));
  h = harness();
  assert.strictEqual(await h.enter(row({ priceNative: 0.0000049 })), undefined, 'fill 2% over the reference price');
  h = harness(); h.buyImpact = 1.4;
  const pos = await h.enter();
  assert.ok(pos); assert.strictEqual(pos.entrySlippagePct, 1.4); assert.strictEqual(pos.maxSlippageBps, 150);
});

test('paper realism: sim slip on buy + sell, 0.5% fee per side, priority fee; replaces the 1.1%; components logged', async () => {
  const h = harness();
  const pos = await h.enter();
  assert.strictEqual(pos.tokensRaw, '9875000000', 'quote 1e10 tokens - 1.25% simulated slippage');
  assert.strictEqual(pos.entryCosts.simSlipPct, 1.25); near(pos.entryCosts.feeSol, 0.00025); near(pos.entryCosts.priorityFeeSol, FEE.sol);
  await h.pass(1.01, 14 * MIN); assert.strictEqual(h.state.books.open.length, 1);
  await h.pass(1.01, 61000);
  const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'no-momentum'); assert.strictEqual(tr.costPctRoundTrip, null);
  const q = Math.floor(9875000000 * 5e-3 * 1.01) / 1e9, sell = q * (1 - 0.0125), fee = sell * 0.005;
  near(tr.legs[0].solOut, sell, 'sim fill'); near(tr.costs.quoteFillSol, q);
  near(tr.costs.feeSol, 0.00025 + fee); near(tr.costs.priorityFeeSol, 2 * FEE.sol); assert.strictEqual(tr.costs.stopPenaltySol, 0);
  near(tr.pnlSol, sell - 0.05 - 0.00025 - FEE.sol - fee - FEE.sol, 'pnl = sim fill - size - fees - priority (no 1.1%)', 1e-8);
  near(h.state.balance, 3 + tr.pnlSol, 'cash', 1e-8);
  assert.ok(tr.costs.simSlipSol > 0 && tr.legs[0].costs.simSlipPct === 1.25);
  assert.ok(Number.isFinite(tr.quoteFillPnlSol));
});

test('stop-loss exit: extra 3% penalty, stop level vs quote fill vs sim fill logged; over-limit exit impact still sells (flagged)', async () => {
  const h = harness();
  await h.enter();
  h.sellImpact = 2.5;
  await h.pass(multFor(-6.2));
  const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'sl'); assert.strictEqual(tr.legs[0].costs.stopPenaltyPct, 3);
  const q = tr.costs.quoteFillSol; near(tr.legs[0].solOut, q * 0.9875 * 0.97, 'quote - 1.25% - 3%', 1e-9);
  const sf = tr.stopFill;
  assert.strictEqual(sf.stopLevelPct, -6); near(sf.quoteFillPct, pctAt(multFor(-6.2)), 'quote fill', 1e-2);
  assert.ok(sf.simFillPct < sf.quoteFillPct - 3.5, 'sim fill below quote fill'); assert.strictEqual(sf.slippageExceeded, true);
  assert.strictEqual(h.state.books.executor.exitSlippageExceeded, 1); assert.strictEqual(tr.costs.slippageExceeded, true);
  assert.ok(h.state.stopCooldowns['mint:R4mint'], '24 h stop-out block kept');
  // breakeven stop: also a stop-loss exit (penalty), level 0
  const h2 = harness(); await h2.enter(); await h2.pass(multFor(4.2)); await h2.pass(multFor(-0.1));
  assert.strictEqual(h2.trades[0].exitReason, 'breakeven'); assert.strictEqual(h2.trades[0].legs[0].costs.stopPenaltyPct, 3);
  assert.ok(h2.trades[0].stopFill.stopLevelPct == 0);
  // trail exit: no stop penalty
  const h3 = harness(); await h3.enter(); await h3.pass(multFor(10)); await h3.pass(multFor(6.6));
  assert.strictEqual(h3.trades[0].exitReason, 'trail'); assert.strictEqual(h3.trades[0].legs[0].costs.stopPenaltyPct, 0);
});

test('Rug Check: mint / freeze authority and top10 > 15% blacklist the mint for the epoch; data errors fail closed without blacklisting', async () => {
  let h = harness({ mint: { pass: false, reason: 'mint-authority-not-revoked' } });
  assert.strictEqual(await h.enter(), undefined);
  let r = h.state.books.rug;
  assert.strictEqual(r.blacklist.R4mint.reason, 'mint-authority-not-revoked'); assert.strictEqual(r.failed, 1);
  h.mint = null; h.adv(60000);
  assert.strictEqual(await h.enter(row({ fetchedAt: h.now() - 5000 })), undefined, 'blacklisted: never re-checked');
  assert.strictEqual(h.mintCalls, 1); assert.strictEqual(h.f().rugBlacklisted, 1);
  h.state.scoreboard.epoch = 'runner-v5';
  assert.ok(await h.enter(row({ fetchedAt: h.now() - 5000 })), 'blacklist is per epoch');
  h = harness({ mint: { pass: false, reason: 'freeze-authority-not-revoked' } });
  await h.enter(); assert.ok(h.state.books.rug.blacklist.R4mint);
  h = harness({ top10: { ok: true, top10Pct: 15.5, maxHolderPct: 5, excludedPct: 10 } });
  await h.enter(); assert.strictEqual(h.state.books.rug.blacklist.R4mint.reason, 'top10 > 15%');
  h = harness({ top10: { ok: false, reason: 'top10: rpc error' } });
  assert.strictEqual(await h.enter(), undefined); assert.ok(!h.state.books.rug.blacklist.R4mint, 'unavailable: not blacklisted'); assert.strictEqual(h.state.books.rug.unavailable, 1);
  h = harness({ mint: { pass: false, reason: 'missing-data: rpc error' } });
  assert.strictEqual(await h.enter(), undefined); assert.ok(!h.state.books.rug.blacklist.R4mint);
  h = harness();
  const pos = await h.enter(); assert.ok(pos.rugCheckV4 && pos.rugCheckV4.pass); assert.strictEqual(h.state.books.rug.passed, 1);
  // liquidity gate: the stricter v3 rule (>= $100k) rejects first; the rug gate (> $30k) is checked too
  assert.match(E.entryFails(RH(), row({ liquidityUsd: 31000 }), { now: NOW, snaps: {}, ticks: {} }), /^liquidityMin/);
});

test('guardrail: 3 losses in a row -> no scanning or entries for 1 h, exits keep running; resumes after 1 h', async () => {
  const h = harness();
  for (let i = 1; i <= 3; i++) { assert.ok(await h.enter(row({ mint: 'L' + i, pairAddress: 'LP' + i, fetchedAt: h.now() - 5000 })), 'entry ' + i); await h.pass(multFor(-7)); }
  const g = h.books.guard(h.state);
  assert.strictEqual(g.pauses.length, 1); assert.strictEqual(Date.parse(g.pausedUntil['runner-hunter']) - h.now(), 60 * MIN);
  h.adv(59 * MIN);
  assert.strictEqual(await h.enter(row({ mint: 'N1', pairAddress: 'NP1', fetchedAt: h.now() - 5000 })), undefined);
  assert.ok(h.f().lossStreakPause >= 1);
  h.adv(2 * MIN);
  assert.ok(await h.enter(row({ mint: 'N2', pairAddress: 'NP2', fetchedAt: h.now() - 5000 })), 'resumes');
});

test('halt: -5% within a rolling 24 h (any epoch) halts, persists, never auto-clears; manual clear restarts the window', async () => {
  const pts = [{ t: new Date(NOW - 30 * 3600000).toISOString(), markEquity: 4 }, { t: new Date(NOW - 20 * 3600000).toISOString(), markEquity: 3.0, epoch: 'old' },
    { t: new Date(NOW - 60000).toISOString(), markEquity: 2.86, epoch: 'new' }];
  const st = {};
  const d = H.drawdown(pts, NOW, { windowHours: 24 });
  assert.strictEqual(d.peak, 3); near(d.dropPct, 4.667, '', 1e-3);
  assert.strictEqual(H.check(st, pts, NOW, config.halt).triggered, false);
  pts.push({ t: new Date(NOW).toISOString(), markEquity: 2.84 });
  assert.strictEqual(H.check(st, pts, NOW, config.halt).triggered, true);
  assert.ok(H.isHalted(st) && /5\.33/.test(st.halt.reason) && st.halt.id);
  pts.push({ t: new Date(NOW + 60000).toISOString(), markEquity: 3.5 });
  H.check(st, pts, NOW + 60000, config.halt); assert.ok(H.isHalted(st), 'recovery does not clear');
  const h = harness(); h.state.halt = st.halt;
  assert.strictEqual(await h.enter(), undefined); assert.match(h.state.books.lastScan.note, /HALTED/);
  assert.strictEqual(H.tokenOk('x', {}), null); assert.strictEqual(H.tokenOk('wrong-token-123456', { KILL_TOKEN: 'k'.repeat(20) }), false);
  assert.strictEqual(H.tokenOk('k'.repeat(20), { KILL_TOKEN: 'k'.repeat(20) }), true);
  H.clear(st, 'test', NOW + 120000);
  assert.ok(!H.isHalted(st));
  assert.strictEqual(H.check(st, pts.concat([{ t: new Date(NOW + 130000).toISOString(), markEquity: 2.8 }]), NOW + 130000, config.halt).triggered, false, 'old peak before the restart ignored');
  assert.strictEqual(H.check(st, [{ t: new Date(NOW + 125000).toISOString(), markEquity: 3 }, { t: new Date(NOW + 130000).toISOString(), markEquity: 2.8 }], NOW + 130000, config.halt).triggered, true);
});

test('priority fee: median of non-zero slots, cached, never blocks; fallback before the first answer; read-only method', async () => {
  const calls = [];
  const lim = { post: async (b, u, body) => { calls.push([b, body.method]); return { data: { result: [0, 1000, 3000, 5000, 0].map(f => ({ slot: 1, prioritizationFee: f })) } }; } };
  const f = X.makePriorityFee(lim, { cuLimit: 200000 });
  const c0 = f.current(NOW); assert.strictEqual(c0.fallback, true); assert.strictEqual(c0.microLamports, 50000);
  await f.refresh('', NOW);
  const c = f.current(NOW + 1000);
  assert.strictEqual(c.microLamports, 3000); assert.strictEqual(c.medianAllMicroLamports, 1000); assert.strictEqual(c.lamports, 5600); near(c.sol, 0.0000056);
  assert.deepStrictEqual(calls[0], ['feerpc', 'getRecentPrioritizationFees']);
  f.current(NOW + 2000); assert.strictEqual(calls.length, 1, 'cached');
  const zl = { post: async (b, u, body) => { calls.push([b, JSON.stringify(body.params)]); return { data: { result: [0, 0, 0].map(f => ({ slot: 1, prioritizationFee: f })) } }; } };
  const z = X.makePriorityFee(zl);
  const pz = await z.forAccount('POOL1', NOW);
  assert.strictEqual(calls[calls.length - 1][1], '[["POOL1"]]', 'per-pool query (write-locked pool account)');
  assert.strictEqual(pz.fallback, true); assert.strictEqual(pz.microLamports, 50000); assert.strictEqual(pz.lamports, 15000);
  const bad = X.makePriorityFee({ post: async () => { throw new Error('429 https://x/y'); } });
  await bad.refresh('', NOW); assert.strictEqual(bad.current(NOW).fallback, true); assert.ok(!/https/.test(bad.stats.lastError));
});

test('send path: paper only; Jito bundle stub is disabled and never sends', async () => {
  const sp = X.makeSendPath();
  assert.strictEqual(sp.mode, 'paper'); assert.strictEqual(sp.paths.jito.enabled, false);
  const r = await sp.submit({ side: 'buy' }); assert.strictEqual(r.sent, false); assert.strictEqual(r.simulated, true);
  const j = await sp.paths.jito.submit({}); assert.strictEqual(j.sent, false);
});

test('Manager v4: only tightens hard rules (top10 <= 15, slippage <= 150 bps, stop <= 6, hold <= 30); entry knobs within bounds', () => {
  assert.ok(improver.isV4(RH()));
  for (const [k, hard] of Object.entries(improver.HARD_V4)) assert.ok(improver.BOUNDS_V4[k].max <= hard, k);
  assert.ok(!Object.keys(improver.BOUNDS_V4).some(k => /trail|breakeven|momentum|rugCheck|lossStreak|costModel/.test(k)));
  const P = () => JSON.parse(JSON.stringify({ entry: RH().entry, exit: RH().exit }));
  const s = { trades: 10, winRatePct: 0, netSol: -0.02, stops: 5, fastStops: 5, avgStopOvershootPct: -0.5, trails: 0, timeExits: 0, partials: 0, noMomentum: 0 };
  let p = P(); p.entry.minM5 = 3;
  let d = improver.decide(s, p, true); assert.strictEqual(d.rule, 'R3'); assert.strictEqual(d.from, 6); assert.strictEqual(d.to, 5, 'stop tightened');
  p = P(); d = improver.decide(Object.assign({}, s, { fastStops: 0, avgEntrySlippagePct: 1.2 }), p, true); assert.strictEqual(d.rule, 'R10'); assert.strictEqual(d.to, 125);
  p = P(); d = improver.decide(Object.assign({}, s, { fastStops: 0, losersAvgTop10: 14, winnersAvgTop10: 6 }), p, true); assert.strictEqual(d.knob, 'entry.maxTop10Pct'); assert.strictEqual(d.to, 12.5);
  // a full 10-trade block through step(): one change, new version 4.01, bounds respected
  const book = JSON.parse(JSON.stringify(RH()));
  const tr = []; for (let i = 1; i <= 10; i++) tr.push({ id: 'T' + i, book: 'runner-hunter', bookVersion: 4, closedAt: new Date(NOW + i * MIN).toISOString(), pnlSol: -0.003, pnlPct: -9, exitReason: 'no-momentum', holdMinutes: 15, legs: [], entrySignal: { h1: 5, top10Pct: 10 } });
  const st = { scoreboard: { epoch: 'runner-v4', since: new Date(NOW - MIN).toISOString() }, books: { trades: tr.reverse() } };
  const e = improver.step(st, book, { baseVersion: 4, now: NOW });
  assert.strictEqual(e.rule, 'R5'); assert.strictEqual(e.change, 'entry.minM5'); assert.strictEqual(book.version, 4.01);
  assert.strictEqual(book.exit.stopLossPct, 6); assert.strictEqual(book.entry.maxTop10Pct, 15);
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' runner4 tests passed');
  if (passed !== tests.length) process.exit(1);
})();
