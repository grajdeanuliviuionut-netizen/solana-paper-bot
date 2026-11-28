// social-route-death-exit: instant full exit when the sell route / pool dies (social-spike book). PAPER ONLY, no network.
// Pure detection, engine exit (default honest booking + what-if credit), liquidity feed, 24 h cooldown, stopFills tagging.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-routedeath-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
delete process.env.SOCIAL_X_BEARER_TOKEN; delete process.env.SOCIAL_SPIKE_ENABLED;
const config = require('../src/config');
const E = require('../src/books/engine');
const RD = require('../src/books/routeDeath');
const stopFills = require('../src/stopFills');
const reentry = require('../src/reentry');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000, HOUR = 3600000;
const NOW = Date.parse('2026-11-24T17:00:00Z');
const SB = () => config.books.list.find(b => b.id === 'social-spike');
const RH = () => config.books.list.find(b => b.id === 'runner-hunter');
const CFG = RD.cfgFrom(SB().exit);

// ---------- pure ----------
test('live config: social-spike has routeDeath (credit OFF), runner-hunter has none; other social rules unchanged', () => {
  const c = SB().exit.routeDeath;
  assert.strictEqual(c.enabled, true); assert.strictEqual(c.noRouteConsecutive, 2); assert.strictEqual(c.maxPriceImpactPct, 20); assert.strictEqual(c.collapseDropPct, 50);
  assert.strictEqual(c.minLiquidityUsd, 30000); assert.strictEqual(c.liquidityDropPct, 50); assert.strictEqual(c.creditLastGoodQuote, false);
  assert.strictEqual(RH().exit.routeDeath, undefined); assert.strictEqual(RD.cfgFrom(RH().exit), null);
  assert.strictEqual(SB().exit.stopLossPct, 10); assert.strictEqual(SB().exit.takeProfitPct, 50); assert.deepStrictEqual(SB().exit.partial, { atPct: 25, sellPct: 50 });
  assert.strictEqual(RD.cfgFrom({ routeDeath: { enabled: false } }), null);
});
test('detect(): no-route needs N consecutive, impact > cap, one-check price collapse, liquidity floor / drop vs entry; ordinary moves do not fire', () => {
  const ok = (imp, extra) => Object.assign({ ok: true, outAmount: '1', priceImpactPct: imp }, extra || {});
  assert.strictEqual(RD.detect({ cfg: CFG, q: { ok: false, noRoute: true }, noRouteCount: 1 }), null, '1 no-route: wait');
  assert.strictEqual(RD.detect({ cfg: CFG, q: { ok: false, noRoute: true }, noRouteCount: 2 }).kind, 'no-route');
  assert.strictEqual(RD.detect({ cfg: CFG, q: { ok: false, error: 'timeout' }, noRouteCount: 9 }), null, 'a plain quote failure is not a route death');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(20), price: 1, prev: { price: 1 } }), null, 'impact == cap: ok');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(20.5), price: 1, prev: { price: 1 } }).kind, 'impact');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(99.99), price: 1e-13, prev: { price: 1e-6 } }).kind, 'impact', 'impact is checked first');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 0.5, prev: { price: 1 } }).kind, 'collapse', '-50% in one check');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 0.51, prev: { price: 1 } }), null, '-49%: a normal (stop) move');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 0.9, prev: { price: 1 } }), null, '-10%: the stop handles it');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 1, prev: { price: 1 }, liq: { usd: 30000 } }).kind, 'liquidity', 'floor $30k');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 1, prev: { price: 1 }, liq: { usd: 90000 }, entryLiq: 200000 }).kind, 'liquidity', '-55% vs entry');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 1, prev: { price: 1 }, liq: { usd: 120000 }, entryLiq: 200000 }), null, '-40%: ok');
  assert.strictEqual(RD.detect({ cfg: CFG, q: ok(1), price: 1, prev: { price: 1 }, liq: null, entryLiq: 200000 }), null, 'no feed: no liquidity rule');
  assert.strictEqual(RD.detect({ cfg: null, q: ok(100), price: 0, prev: { price: 1 } }), null, 'rule off');
});
test('credit(): only when enabled, same tokens, last good quote <= maxAge; otherwise refused with a reason', () => {
  const lg = { at: NOW - 8000, inAmount: '1', outAmount: '200000000', priceImpactPct: 0.4, route: 'Ray', tokensRemainingRaw: '100' };
  const on = Object.assign({}, CFG, { creditLastGoodQuote: true });
  assert.strictEqual(RD.credit({ cfg: CFG, lastGood: lg, tokensRemainingRaw: '100', now: NOW }).why, 'credit-off');
  assert.strictEqual(RD.credit({ cfg: on, lastGood: lg, tokensRemainingRaw: '100', now: NOW }).ok, true);
  assert.strictEqual(RD.credit({ cfg: on, lastGood: lg, tokensRemainingRaw: '100', now: NOW + 3000 }).why, 'quote-too-old');
  assert.strictEqual(RD.credit({ cfg: on, lastGood: lg, tokensRemainingRaw: '50', now: NOW }).why, 'tokens-changed');
  assert.strictEqual(RD.credit({ cfg: on, lastGood: null, tokensRemainingRaw: '50', now: NOW }).why, 'no-good-quote');
});

// ---------- stopFills ----------
test('stopFills: death-like fills (impact >= 50% / fill <= -90%) are tagged and kept out of the overshoot stats', () => {
  const mk = (id, over, imp, fill) => ({ at: '2026-11-25T00:00:00Z', strategyId: id, symbol: id + over, overshootPct: over, priceImpactPct: imp, actualFillPct: fill });
  const rows = [mk('social-spike', -90, 100, -100), mk('social-spike', -89.9, 99.94, -99.9), mk('social-spike', -2, 0.5, -12), mk('runner-hunter', -3, 1, -5.5), mk('runner-hunter', -31, 4, -33.5)];
  assert.strictEqual(rows.filter(stopFills.isDeathLike).length, 2);
  const s = stopFills.summary({ stopFills: rows });
  assert.strictEqual(s.count, 3); assert.strictEqual(s.countAll, 5); assert.strictEqual(s.maxOvershootPct, -31, 'the -90% is no longer the headline overshoot');
  assert.strictEqual(s.byStrategy['social-spike'].count, 1); assert.strictEqual(s.byStrategy['social-spike'].maxOvershootPct, -2);
  assert.strictEqual(s.routeDeath.count, 2); assert.strictEqual(s.routeDeath.byStrategy['social-spike'].count, 2);
  const b = stopFills.build({ pos: { symbol: 'X', id: 'p' }, strategyId: 'social-spike', strategyVersion: 'v', stopLevelPct: 10, entryPriceSolPerToken: 1, prevCheck: { at: new Date(NOW).toISOString(), pct: 1, price: 1, quoteAgeSec: 0 },
    fill: { price: 1e-13, pct: -100, quoteAgeSec: 0, priceImpactPct: 100 }, netPnlPct: -102, liquidityUsd: 1e5, now: NOW });
  assert.strictEqual(b.deathLike, true);
});

// ---------- engine ----------
const FEE = { microLamports: 3000, sol: 0.0000056, fallback: false, lamports: 5600 };
// token mid = 0.000005 SOL; size 0.2 SOL (5% of 4); the $500 probe = 2.5 SOL at SOL $200. Position quotes: out = raw * 5e-3 * h.mult.
function harness(spikes, opts) {
  opts = opts || {};
  let t = NOW; const h = { mult: 1.0, trades: [], equity: 4, noRoute: false, impact: 0.4, liq: null, quoteLog: [], logs: [] };
  const quotes = {
    getSolUsd: async () => ({ v: 200, at: t }),
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: String(Math.round(sol / 0.05 * 10000000000)), priceImpactPct: 0.5, route: 'Ray' }),
    sellQuote: async (mint, raw) => { const probe = Number(raw) > 1e11; h.quoteLog.push(Number(raw));
      if (!probe && h.noRoute) return { ok: false, noRoute: true, error: 'No routes found' };
      return { ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * (probe ? 1 : h.mult))), priceImpactPct: probe ? 0.4 : h.impact, route: 'Pump.fun Amm' }; }
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const top10 = { check: async () => ({ ok: true, top10Pct: 12, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' }) };
  const social = { spikeFor: mint => spikes[mint] || null, recordSignal: () => {} };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15: { gt: async () => null, smaGt: async () => null }, fees: { current: () => FEE }, social, random: () => 0.5, equityNow: () => h.equity,
    saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; }, log: (ty, sym, r) => h.logs.push([ty, sym, r]), liquidityFeed: opts.feed ? (() => h.liq) : undefined });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() } };
  h.row = o => Object.assign({ pairAddress: 'P_HOT', mint: 'HOTmint', symbol: 'HOT', name: 'Hot', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 150000,
    volumeH1: 1000, volumeM5: 100, volumeH6: 6000, volumeH24: 9000, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { buys: 10, sells: 10 }, txnsM5: { buys: 1, sells: 1 },
    pairCreatedAt: NOW - 30 * HOUR, dexId: 'raydium', fetchedAt: t - 5000, ageDays: 1 }, o || {});
  h.enter = async r => { await h.books.runEntries(h.state, [r || h.row()], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'social-spike'); };
  h.pass = async (mult, ms) => { if (mult != null) h.mult = mult; t += (ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  h.at = () => t;
  return h;
}
const SP = { HOTmint: { mint: 'HOTmint', symbol: 'HOT', spikePct: 180, last1h: 900, baselinePerHour: 320, unit: 'txns/h', source: 'dexscreener', sourceLabel: 'test', rank: 1, at: NOW } };

test('no route: closes on the 2nd consecutive no-route (~10 s), not after 10 min; reason route-dying-exit, total loss, tagged; 1 transient no-route recovers', async () => {
  let h = harness(SP); await h.enter();
  await h.pass(1.04); await h.pass(1.04);
  h.noRoute = true; await h.pass();
  assert.strictEqual(h.trades.length, 0, '1st no-route: still open'); assert.strictEqual(h.state.books.open[0].noRouteCount, 1);
  h.noRoute = false; await h.pass(1.04); assert.strictEqual(h.state.books.open[0].noRouteCount, 0, 'recovered: counter reset, nothing booked');
  h.noRoute = true; await h.pass(); await h.pass();
  assert.strictEqual(h.trades.length, 1); const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'route-dying-exit'); assert.strictEqual(tr.legs[0].reason, 'route-dying-exit'); assert.strictEqual(tr.legs[0].solOut, 0, 'no route: nothing sold');
  assert.strictEqual(tr.legs[0].routeDeath.kind, 'no-route'); assert.strictEqual(tr.legs[0].routeDeath.credit, 'none');
  assert.ok(tr.legs[0].routeDeath.lastGoodAgeSec >= 5 && tr.legs[0].routeDeath.lastGoodAgeSec <= 10, 'last good quote age: ' + tr.legs[0].routeDeath.lastGoodAgeSec);
  assert.ok(Math.abs(tr.holdMinutes - 25 / 60) < 0.2, 'closed within seconds, hold ' + tr.holdMinutes);
  assert.strictEqual(h.state.books.routeDeath.exits, 1); assert.strictEqual(h.state.books.routeDeath.byKind['no-route'], 1);
  assert.ok(h.logs.some(l => l[0] === 'ROUTE-DEATH' && /no-route/.test(l[2])));
  assert.ok(h.state.stopCooldowns['mint:HOTmint'], '24 h no re-buy after a route death'); assert.ok(!(h.state.stopFills || []).length, 'not a stop fill');
});
test('dying quote (priceImpact ~100%, price -100% in one check): exits as route-dying-exit at that quote, NOT as a -100% "sl"; no stopFills row', async () => {
  const h = harness(SP); await h.enter();
  await h.pass(1.04);
  h.impact = 99.99; await h.pass(1e-7);
  assert.strictEqual(h.trades.length, 1); const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'route-dying-exit'); assert.notStrictEqual(tr.exitReason, 'sl');
  assert.strictEqual(tr.legs[0].routeDeath.kind, 'impact'); assert.ok(tr.legs[0].solOut < 1e-3, 'executable quote is ~0');
  assert.ok(!(h.state.stopFills || []).length); assert.strictEqual(tr.stopFill, undefined);
  assert.ok(h.state.stopCooldowns['mint:HOTmint']);
});
test('collapse without high impact: -60% in one check exits as route-dying-exit at the real quote (partial value kept); -40% one-check drop is a normal stop', async () => {
  let h = harness(SP); await h.enter();
  await h.pass(1.0); await h.pass(0.40);
  assert.strictEqual(h.trades[0].exitReason, 'route-dying-exit'); assert.strictEqual(h.trades[0].legs[0].routeDeath.kind, 'collapse');
  assert.ok(h.trades[0].legs[0].solOut > 0.07, 'sold 0.40 x the position at the quote, not written off: ' + h.trades[0].legs[0].solOut);
  h = harness(SP); await h.enter();
  await h.pass(1.0); await h.pass(0.60);   // -40%: below the 50% collapse line, past the -10% stop
  assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.strictEqual(h.state.stopFills.length, 1);
});
test('regular exits unchanged: -10% stop, +25% half, +50% TP, time cap; a -11% step is an ordinary sl', async () => {
  let h = harness(SP); await h.enter(); await h.pass(0.91); assert.strictEqual(h.trades.length, 0); await h.pass(0.889); assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.strictEqual(h.state.stopFills[0].deathLike, false);
  h = harness(SP); await h.enter(); await h.pass(1.3); assert.ok(h.state.books.open[0].partialDone); await h.pass(1.52); assert.strictEqual(h.trades[0].exitReason, 'tp');
  h = harness(SP); await h.enter(); await h.pass(1.0, 240 * MIN + 1000); assert.strictEqual(h.trades[0].exitReason, 'time');
});
test('after the +25% half: the remainder dying at once exits as route-dying-exit (the DOG / KOOP pattern), partial profit kept', async () => {
  const h = harness(SP); await h.enter();
  await h.pass(1.3); assert.ok(h.state.books.open[0].partialDone);
  h.noRoute = true; await h.pass(); await h.pass();
  const tr = h.trades[0]; assert.strictEqual(tr.exitReason, 'route-dying-exit'); assert.strictEqual(tr.legs.length, 2); assert.strictEqual(tr.legs[0].reason, 'partial-tp'); assert.ok(tr.legs[0].pnlSol > 0);
  assert.ok(tr.holdMinutes < 1, 'was 10+ min of failed route checks before'); assert.strictEqual(h.state.books.open.length, 0, 'cap slot freed');
});
test('what-if credit (creditLastGoodQuote:true): credits the last good quote minus the 2% paper slip when it is <= 10 s old; refuses (keeps the loss, logs why) when older', async () => {
  const live = SB(); const was = live.exit.routeDeath.creditLastGoodQuote;
  try {
    live.exit.routeDeath.creditLastGoodQuote = true; live.exit.routeDeath.noRouteConsecutive = 1;
    let h = harness(SP); await h.enter(); await h.pass(1.10);
    const basis = h.state.books.open[0].sizeSol; h.noRoute = true; await h.pass();
    let l = h.trades[0].legs[0]; assert.strictEqual(l.routeDeath.credit, 'lastGoodQuote'); assert.ok(l.solOut > 0);
    const expected = Number(h.trades[0].legs[0].quote.outAmount) / 1e9 * 0.98; assert.ok(Math.abs(l.solOut - expected) < 1e-6, l.solOut + ' vs ' + expected);
    assert.ok(l.solOut > basis, 'last good mark was +10%: credit > cost basis'); assert.strictEqual(h.state.books.routeDeath.credited, 1);
    live.exit.routeDeath.noRouteConsecutive = 2;
    h = harness(SP); await h.enter(); await h.pass(1.10); h.noRoute = true; await h.pass(null, 6000); await h.pass(null, 6000);   // live passes take 5 s + ~4 s of ladder retries: the 2nd no-route is >10 s after the last good quote
    l = h.trades[0].legs[0]; assert.strictEqual(l.routeDeath.credit, 'none'); assert.strictEqual(l.routeDeath.creditRefused, 'quote-too-old'); assert.strictEqual(l.solOut, 0, 'loss kept');
  } finally { live.exit.routeDeath.creditLastGoodQuote = was; live.exit.routeDeath.noRouteConsecutive = 2; }
});
test('optional liquidity feed: pool liquidity below $30k or -50% from entry exits at once; no feed -> rule inert', async () => {
  let h = harness(SP, { feed: true }); await h.enter();
  h.liq = { usd: 140000 }; await h.pass(1.02); assert.strictEqual(h.trades.length, 0);
  h.liq = { usd: 70000 }; await h.pass(1.02);
  assert.strictEqual(h.trades[0].exitReason, 'route-dying-exit'); assert.strictEqual(h.trades[0].legs[0].routeDeath.kind, 'liquidity'); assert.ok(h.trades[0].legs[0].solOut > 0.15, 'still sold at the (fine) quote');
  h = harness(SP); await h.enter(); await h.pass(1.02); assert.strictEqual(h.trades.length, 0);
});
test('check trail: last 12 checks (pct, price, impact) kept on the position / trade for the next warning-time review', async () => {
  const h = harness(SP); await h.enter();
  for (let i = 0; i < 15; i++) await h.pass(1.01);
  assert.strictEqual(h.state.books.open[0].checkTrail.length, 12);
  h.impact = 99; await h.pass(1e-6);
  const tr = h.trades[0]; assert.strictEqual(tr.checkTrail.length, 12); assert.strictEqual(tr.checkTrail[11].dying, 'impact');
});
test('runner-hunter is not touched: no routeDeath config, its no-route handling keeps the 5 consecutive + 10 min rule', async () => {
  assert.strictEqual(RH().exit.routeDeath, undefined);
  const src = fs.readFileSync(path.join(__dirname, '../src/books/engine.js'), 'utf8');
  assert.ok(/rdMod\.cfgFrom\(\(live && live\.exit && live\.exit\.routeDeath\) \? live\.exit : pos\.exit\)/.test(src));
  assert.strictEqual(RD.cfgFrom({ stopLossPct: 2.5 }), null);
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 7).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' route-death tests passed');
  if (passed !== tests.length) process.exit(1);
})();
