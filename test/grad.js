// Graduation sniper v2 tests (Liviu t76u): LP lock/burn, holder concentration, min pool age, entry
// impact checks (all fail closed, counted by category) and the second-quote confirmation on large drops.
const assert = require('assert');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const { evaluateReport, makeHolderCheck } = require('../src/books/holderCheck');
const { Limiter } = require('../src/books/limiter');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;
const NOW = Date.parse('2026-11-21T21:30:00Z');
const POOL = 'POOLgrad';
const GB = config.books.list.find(b => b.id === 'graduation-sniper');
const RULES = GB.entry;
const reentry = { blocked: () => null, recordExit() {} };

const report = o => Object.assign({
  creator: 'CREATOR1', creatorBalance: 0, token: { supply: 1e15, decimals: 6 }, rugged: false,
  markets: [{ pubkey: POOL, marketType: 'pump_fun_amm', lp: { lpLockedPct: 100 } }],
  knownAccounts: { [POOL]: { name: 'Pump Fun AMM', type: 'AMM' }, LOCKER1: { name: 'Locker', type: 'LOCKER' } },
  topHolders: [{ owner: POOL, pct: 20 }, { owner: '1nc1nerator11111111111111111111111111111111', pct: 15 }, { owner: 'LOCKER1', pct: 9 },
    { owner: 'A', pct: 4 }, { owner: 'B', pct: 3 }, { owner: 'C', pct: 2 }, { owner: 'D', pct: 2 }]
}, o || {});

test('config: v2 keeps the core rules (pump origin, m5 buys > sells, liq >= $30k, -10/+40, trail 10 after +15, 60 min, 0.05 SOL, 2 open) and adds the checks', () => {
  assert.strictEqual(E.label(GB), 'graduation-sniper v2');
  assert.deepStrictEqual(GB.exit && [GB.exit.stopLossPct, GB.exit.takeProfitPct, GB.exit.trailAfterPct, GB.exit.trailPct, GB.exit.maxHoldMinutes], [10, 40, 15, 10, 60]);
  assert.ok(RULES.pumpOrigin && RULES.m5BuysGtSells && RULES.minLiquidityUsd === 30000 && RULES.maxPoolAgeMin === 15 && RULES.minPoolAgeMin === 3);
  assert.deepStrictEqual([RULES.lpLockedMinPct, RULES.maxTop10Pct, RULES.maxSingleHolderPct, RULES.maxCreatorPct, RULES.maxRoundTripLossPct, RULES.maxSellImpactPct], [90, 30, 10, 5, 8, 5]);
  assert.strictEqual(config.books.sizeSol, 0.05); assert.strictEqual(config.books.maxOpenPerBook, 2);
  assert.ok(!GB.paused);
  for (const id of ['runner-hunter', 'volume-explosion', 'trending-pullback']) assert.ok(!config.books.list.find(b => b.id === id).entry.lpLockedMinPct, id + ' untouched');
});

test('LP check: >= 90% locked/burned passes; below, missing pool or missing data rejects (fail closed)', () => {
  const ok = evaluateReport(report(), POOL, RULES);
  assert.ok(ok.pass, ok.reason);
  assert.strictEqual(ok.lpLockedPct, 100);
  assert.strictEqual(ok.top10Pct, 11, 'pool vault, burn address and locker excluded');
  assert.strictEqual(ok.maxHolderPct, 4);
  const low = evaluateReport(report({ markets: [{ pubkey: POOL, lp: { lpLockedPct: 60 } }] }), POOL, RULES);
  assert.ok(!low.pass && low.category === 'lp' && /not locked/.test(low.reason));
  const missing = evaluateReport(report(), 'OTHERPOOL', RULES);
  assert.ok(!missing.pass && missing.category === 'lp' && /unknown/.test(missing.reason));
  assert.ok(!evaluateReport(null, POOL, RULES).pass);
  assert.ok(!evaluateReport(report({ markets: [{ pubkey: POOL, lp: {} }] }), POOL, RULES).pass, 'no lpLockedPct');
  assert.ok(!evaluateReport(report({ rugged: true }), POOL, RULES).pass);
});

test('holder check: top 10 > 30%, single holder > 10%, creator > 5% reject; unknown holders reject (fail closed)', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ owner: 'H' + i, pct: 3.5 }));
  const t10 = evaluateReport(report({ topHolders: many }), POOL, RULES);
  assert.ok(!t10.pass && t10.category === 'holders' && /top 10/.test(t10.reason), t10.reason);
  const whale = evaluateReport(report({ topHolders: [{ owner: 'W', pct: 12 }, { owner: 'A', pct: 2 }] }), POOL, RULES);
  assert.ok(!whale.pass && /single holder/.test(whale.reason));
  const dev = evaluateReport(report({ topHolders: [{ owner: 'A', pct: 2 }], creatorBalance: 6e13 }), POOL, RULES);   // 6% of supply
  assert.ok(!dev.pass && /creator/.test(dev.reason), dev.reason);
  const devH = evaluateReport(report({ topHolders: [{ owner: 'CREATOR1', pct: 7 }], creatorBalance: null, token: {} }), POOL, RULES);
  assert.ok(!devH.pass && /creator/.test(devH.reason), devH.reason);
  const unk = evaluateReport(report({ topHolders: [] }), POOL, RULES);
  assert.ok(!unk.pass && /unknown/.test(unk.reason));
  const devUnknown = evaluateReport(report({ creatorBalance: null, token: {} }), POOL, RULES);
  assert.ok(!devUnknown.pass && /creator balance unknown/.test(devUnknown.reason));
  // v1 wipes (RugCheck today): MIBGHO max holder 49.8%, pointy hat 83.8%, Horybel 49.9% -> all rejected
  for (const p of [49.8, 83.8, 49.9]) assert.ok(!evaluateReport(report({ topHolders: [{ owner: 'X', pct: p }] }), POOL, RULES).pass);
});

test('RugCheck client: 1 request, no retry, 429 -> 10 min pause + fail closed, cached per mint', async () => {
  let calls = 0, mode = '429';
  const http = { get: async () => { calls++; if (mode === '429') throw Object.assign(new Error('429'), { response: { status: 429, headers: {} } }); return { data: report() }; } };
  const lim = new Limiter({ buckets: { rugcheck: { minGapMs: 0, maxRetries: 0, cooldownMs: 600000 } }, baseBackoffMs: 1, maxBackoffMs: 1 }, http);
  const hc = makeHolderCheck(lim);
  const r1 = await hc.check('M1', POOL, RULES, NOW);
  assert.ok(!r1.pass && r1.category === 'lp' && /unavailable/.test(r1.reason));
  assert.strictEqual(calls, 1, 'no retry');
  assert.strictEqual(lim.stats().rugcheck.http429, 1);
  mode = 'ok';
  const r2 = await hc.check('M2', POOL, RULES, NOW);
  assert.ok(!r2.pass && calls === 1, 'cooldown: no request, still rejects');
  const lim2 = new Limiter({ buckets: { rugcheck: { minGapMs: 0, maxRetries: 0, cooldownMs: 600000 } }, baseBackoffMs: 1, maxBackoffMs: 1 }, http);
  const hc2 = makeHolderCheck(lim2);
  assert.ok((await hc2.check('M3', POOL, RULES, NOW)).pass);
  assert.ok((await hc2.check('M3', POOL, RULES, NOW + 60000)).pass);
  assert.strictEqual(hc2.stats.requests, 1); assert.strictEqual(hc2.stats.cacheHits, 1);
});

// Engine harness for the sniper.
const row = o => Object.assign({ pairAddress: POOL, mint: 'GRADpump', symbol: 'GRAD', name: 'Grad', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 50000, volumeH1: 20000, volumeM5: 1000, volumeH6: 60000,
  priceChange: { m5: 2, h1: 5, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 }, pairCreatedAt: NOW - 6 * MIN, dexId: 'pumpswap', fetchedAt: NOW - 2000 }, o || {});
function harness(o = {}) {
  let t = NOW;
  const sells = [];
  const quotes = {
    buyQuote: async (m, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: 0.5 }),
    sellQuote: async (m, raw) => { sells.push(String(raw)); return o.sell(BigInt(raw), t, sells.length); }
  };
  const holder = { calls: 0, check: async () => { holder.calls++; return o.holder || { pass: true, reason: 'ok', lpLockedPct: 100, top10Pct: 10, maxHolderPct: 3, creatorPct: 0 }; } };
  const books = E.makeBooks({ config, quotes, mintAuth: { check: async () => ({ pass: true, reason: 'ok', decimals: 6, mintAuthority: null, freezeAuthority: null }) }, reentry, now: () => t, holderCheck: holder, sleep: async ms => { t += ms; } });
  const state = { balance: 3, reentryCooldowns: {} };
  return { books, state, sells, holder, adv: ms => { t += ms; }, now: () => t };
}
const sellAt = (mult, impact) => (raw, t) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * mult)), priceImpactPct: impact == null ? 0.4 : impact });
const sniperOnly = h => { h.state.books.open = h.state.books.open.filter(p => p.book === 'graduation-sniper'); };

test('age: pools younger than 3 min are not entered; counted once per mint as "age"', async () => {
  assert.strictEqual(E.entryFails(GB, row({ pairCreatedAt: NOW - 2 * MIN }), { now: NOW }), 'pool younger than 3m');
  assert.strictEqual(E.entryFails(GB, row({ pairCreatedAt: NOW - 16 * MIN }), { now: NOW }), 'pool older than 15m');
  assert.strictEqual(E.entryFails(GB, row(), { now: NOW }), null);
  const h = harness({ sell: sellAt(0.99) });
  await h.books.runEntries(h.state, [row({ pairCreatedAt: NOW - 2 * MIN })], async () => ({ ok: true }));
  await h.books.runEntries(h.state, [row({ pairCreatedAt: NOW - 2.5 * MIN })], async () => ({ ok: true }));
  const g = h.books.gradView(h.state);
  assert.strictEqual(g.rejectsByCategory.age, 1);
  assert.strictEqual(g.candidates, 1);
  assert.strictEqual(h.state.books.open.filter(p => p.book === 'graduation-sniper').length, 0);
});

test('LP / holder rejects from the engine are counted by category and fail closed', async () => {
  const h = harness({ sell: sellAt(0.99), holder: { pass: false, category: 'lp', reason: 'lp: not locked/burned (< 90%)', lpLockedPct: 40 } });
  await h.books.runEntries(h.state, [row()], async () => ({ ok: true }));
  assert.strictEqual(h.state.books.open.filter(p => p.book === 'graduation-sniper').length, 0);
  assert.strictEqual(h.books.gradView(h.state).rejectsByCategory.lp, 1);
  assert.ok(h.state.books.rejects.byBook['graduation-sniper']['lp: not locked/burned (< 90%)'] === 1);
  const h2 = harness({ sell: sellAt(0.99), holder: { pass: false, category: 'holders', reason: 'holders: single holder > 10%' } });
  await h2.books.runEntries(h2.state, [row()], async () => ({ ok: true }));
  assert.strictEqual(h2.books.gradView(h2.state).rejectsByCategory.holders, 1);
  // no holder check wired -> reject (fail closed)
  const h3 = harness({ sell: sellAt(0.99) });
  const b3 = E.makeBooks({ config, quotes: { buyQuote: async () => ({ ok: true }), sellQuote: async () => ({ ok: true }) }, mintAuth: { check: async () => ({ pass: true, decimals: 6 }) }, reentry, now: () => NOW });
  await b3.runEntries(h3.state, [row()], async () => ({ ok: true }));
  assert.strictEqual(b3.gradView(h3.state).rejectsByCategory.lp, 1);
  assert.strictEqual((h3.state.books.open || []).length, 0);
});

test('impact: round trip worse than -8% or sell impact > 5% rejects (category impact); a clean route enters with the holder check on the position', async () => {
  const h = harness({ sell: sellAt(0.91) });      // -9% round trip
  await h.books.runEntries(h.state, [row()], async () => ({ ok: true }));
  assert.strictEqual(h.state.books.open.filter(p => p.book === 'graduation-sniper').length, 0);
  assert.strictEqual(h.books.gradView(h.state).rejectsByCategory.impact, 1);
  const h2 = harness({ sell: sellAt(0.98, 6) });  // round trip fine, impact 6%
  await h2.books.runEntries(h2.state, [row()], async () => ({ ok: true }));
  assert.strictEqual(h2.books.gradView(h2.state).rejectsByCategory.impact, 1);
  const h3 = harness({ sell: sellAt(0.97, 1) });
  await h3.books.runEntries(h3.state, [row()], async () => ({ ok: true }));
  const p = h3.state.books.open.find(x => x.book === 'graduation-sniper');
  assert.ok(p, JSON.stringify(h3.state.books.rejects));
  assert.strictEqual(p.strategyVersion, 'graduation-sniper v2'); assert.strictEqual(p.bookVersion, 2);
  assert.ok(p.holderCheck && p.holderCheck.pass);
  assert.strictEqual(h3.books.gradView(h3.state).entries, 1);
});

async function openSniper(sellFn) {
  let mode = { fn: sellAt(0.99, 1) };
  const h = harness({ sell: (raw, t, n) => mode.fn(raw, t, n) });
  await h.books.runEntries(h.state, [row()], async () => ({ ok: true }));
  sniperOnly(h);
  assert.strictEqual(h.state.books.open.length, 1);
  h.adv(5000); await h.books.runExits(h.state);       // a normal check (+-0)
  mode.fn = sellFn;
  return h;
}

test('confirm: a >= 50% one-check drop is re-quoted 4 s later; confirmed -> booked from the SECOND quote, both quotes on the stop fill', async () => {
  let k = 0;
  const h = await openSniper((raw, t) => { k++; return sellAt(k === 1 ? 0.02 : 0.03, k === 1 ? 98 : 97)(raw, t); });
  h.adv(5000); const t0 = h.now(); await h.books.runExits(h.state);
  assert.strictEqual(h.now() - t0, 4000, 'waited confirmDelayMs');
  assert.strictEqual(h.state.books.open.length, 0);
  const tr = h.state.books.trades[0];
  assert.strictEqual(tr.exitReason, 'sl');
  assert.ok(Math.abs(tr.legs[0].solOut - 0.05 * 0.03 * 0.99 / 0.99) < 2e-4, 'booked from the second quote: ' + tr.legs[0].solOut);
  const sf = h.state.stopFills[0];
  assert.strictEqual(sf.confirmed, true);
  assert.ok(sf.firstQuote && sf.confirmQuote && sf.firstQuote.pct < -97 && sf.confirmQuote.pct < -96);
  assert.ok(sf.probeQuote && sf.probeQuote.tokensRaw, 'probe at 10% size');
  const g = h.books.gradView(h.state);
  assert.strictEqual(g.confirmsTriggered, 1); assert.strictEqual(g.confirmsConfirmed, 1);
});

test('confirm: second quote recovers -> nothing booked off the broken first quote (confirmed false); second quote fails -> hold', async () => {
  let k = 0;
  const h = await openSniper((raw, t) => { k++; return k === 1 ? sellAt(0.01, 99)(raw, t) : sellAt(0.97, 1)(raw, t); });
  h.adv(5000); await h.books.runExits(h.state);
  assert.strictEqual(h.state.books.open.length, 1, 'held');
  const p = h.state.books.open[0];
  assert.strictEqual(p.lastConfirm.confirmed, false);
  assert.ok(p.markPct > -5, 'marked from the second quote');
  let j = 0;
  const h2 = await openSniper((raw, t) => { j++; return j === 1 ? sellAt(0.3, 60)(raw, t) : { ok: false, error: 'timeout', at: t }; });
  h2.adv(5000); await h2.books.runExits(h2.state);
  assert.strictEqual(h2.state.books.open.length, 1, 'no booking off a single quote');
  assert.strictEqual(h2.books.gradView(h2.state).confirmsTriggered, 1);
  assert.strictEqual(h2.books.gradView(h2.state).confirmsConfirmed, 0);
});

test('confirm is graduation-sniper only: a runner-hunter -60% check books at once', async () => {
  let mult = 0.99;
  const h = harness({ sell: (raw, t) => sellAt(mult)(raw, t) });
  const RH = config.books.list.find(b => b.id === 'runner-hunter');
  const b = h.books.ensure(h.state);
  b.open.push({ id: 'R', book: 'runner-hunter', bookVersion: 1, strategyVersion: 'runner-hunter v1', symbol: 'R', mint: 'RM', entryTime: new Date(NOW).toISOString(), sizeSol: 0.05, costBasisRemainingSol: 0.05,
    tokensRaw: '10000000000', tokensRemainingRaw: '10000000000', decimals: 6, entryPrice: 5e-6, exit: RH.exit, legs: [] });
  h.adv(5000); await h.books.runExits(h.state);
  mult = 0.4; const t0 = h.now(); h.adv(5000); await h.books.runExits(h.state);
  assert.strictEqual(b.open.length, 0); assert.strictEqual(h.now() - t0, 5000, 'no confirm wait');
});

test('v2 stats separate: v1 trades kept as history (previousVersions), v2 scoreboard starts fresh', () => {
  const h = harness({ sell: sellAt(1) });
  const b = h.books.ensure(h.state);
  b.trades.push({ book: 'graduation-sniper', strategyVersion: 'graduation-sniper v1', pnlSol: -0.0497, pnlPct: -99.5, closedAt: new Date(NOW - MIN).toISOString() });
  b.trades.push({ book: 'graduation-sniper', bookVersion: 1, strategyVersion: 'graduation-sniper v1', pnlSol: -0.05, pnlPct: -100, closedAt: new Date(NOW - MIN).toISOString() });
  const rep = h.books.report(h.state).find(x => x.strategyId === 'graduation-sniper');
  assert.strictEqual(rep.label, 'graduation-sniper v2');
  assert.strictEqual(rep.trades, 0);
  assert.strictEqual(rep.previousVersions.length, 1);
  assert.strictEqual(rep.previousVersions[0].label, 'graduation-sniper v1');
  assert.strictEqual(rep.previousVersions[0].trades, 2);
  assert.ok(rep.v2 && rep.v2.rejectsByCategory);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(passed + '/' + tests.length + ' grad tests passed');
  if (passed !== tests.length) process.exit(1);
})();
