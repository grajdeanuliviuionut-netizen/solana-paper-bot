// PR11 tests: the four books (entries, exits, partial exits), stock block, mint/freeze check,
// stale-quote refusal, no-route total loss. No network: quotes / RPC / gate are mocked.
const assert = require('assert');
const config = require('../src/config');
const E = require('../src/books/engine');
const { classifyBlocked } = require('../src/books/blocklist');
const { evaluateMintAccount, makeMintAuth } = require('../src/books/mintAuth');
const reentry = require('../src/reentry');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;
const NOW = Date.parse('2026-11-21T18:40:00Z');
const book = id => config.books.list.find(b => b.id === id);
const row = o => Object.assign({ pairAddress: 'POOL1', mint: 'MINT1pump', symbol: 'MEME', name: 'Meme', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 50000,
  volumeH1: 20000, volumeM5: 1000, volumeH6: 60000, priceChange: { m5: 2, h1: 5, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 10 * MIN, dexId: 'pumpswap', fetchedAt: NOW - 5000 }, o || {});
const ctx = { now: NOW, snaps: {} };

test('config: 4 books, same 0.05 SOL size, 2 open each, name + version', () => {
  assert.strictEqual(config.books.list.length, 4);
  assert.strictEqual(config.books.sizeSol, 0.05);
  assert.strictEqual(config.books.maxOpenPerBook, 2);
  assert.deepStrictEqual(config.books.list.map(E.label), ['graduation-sniper v1', 'runner-hunter v1', 'volume-explosion v1', 'trending-pullback v1']);
});

test('graduation sniper entry: pump origin, pool <= 15 min, m5 buys > sells, liquidity >= $30k', () => {
  const b = book('graduation-sniper');
  assert.strictEqual(E.entryFails(b, row(), ctx), null);
  assert.ok(E.entryFails(b, row({ pairCreatedAt: NOW - 16 * MIN }), ctx));
  assert.ok(E.entryFails(b, row({ txnsM5: { buys: 10, sells: 10 } }), ctx));
  assert.ok(E.entryFails(b, row({ liquidityUsd: 29999 }), ctx));
  assert.ok(E.entryFails(b, row({ mint: 'MINTX', dexId: 'raydium' }), ctx), 'not pump origin');
  assert.strictEqual(E.entryFails(b, row({ mint: 'MINTX', dexId: 'pumpswap' }), ctx), null, 'pumpswap dex counts');
});

test('runner hunter entry: h1 volume >= 10% of liquidity (+ h1 >= 0, m5 >= 0)', () => {
  const b = book('runner-hunter');
  assert.strictEqual(E.entryFails(b, row({ volumeH1: 5000, liquidityUsd: 50000 }), ctx), null);
  assert.ok(E.entryFails(b, row({ volumeH1: 4999, liquidityUsd: 50000 }), ctx));
  assert.ok(E.entryFails(b, row({ priceChange: { m5: -1, h1: 5 } }), ctx));
});

test('volume explosion entry: m5 vol >= 10x (h1 - m5)/11, 0 < m5 <= 30, pool >= 60 min', () => {
  const b = book('volume-explosion');
  const old = NOW - 3 * 3600000;
  // h1 21000, m5 10000 -> base (11000/11)=1000 -> 10x
  const r = row({ pairCreatedAt: old, volumeH1: 21000, volumeM5: 10000, priceChange: { m5: 12, h1: 20 } });
  assert.strictEqual(E.m5VolumeVsHourAvg(r), 10);
  assert.strictEqual(E.entryFails(b, r, ctx), null);
  assert.ok(E.entryFails(b, Object.assign({}, r, { volumeM5: 9000 }), ctx), '< 10x');
  assert.ok(E.entryFails(b, Object.assign({}, r, { priceChange: { m5: 31 } }), ctx), 'm5 > 30');
  assert.ok(E.entryFails(b, Object.assign({}, r, { priceChange: { m5: 0 } }), ctx), 'm5 must be up');
  assert.ok(E.entryFails(b, Object.assign({}, r, { pairCreatedAt: NOW - 30 * MIN }), ctx), 'too young for an hour baseline');
});

test('trending pullback entry: h24 >= 100, 20-30% below the 24h high estimate, h1 vol > h6/6', () => {
  const b = book('trending-pullback');
  // price 1.0, h6 change -25% -> price 6h ago 1.333 -> drop 25%
  const r = row({ priceUsd: 1, priceChange: { m5: 0, h1: -2, h6: -25, h24: 150 }, volumeH1: 20000, volumeH6: 60000 });
  assert.ok(Math.abs(E.dropFromHighPct(r, [], NOW) - 25) < 1e-9);
  assert.strictEqual(E.entryFails(b, r, ctx), null);
  assert.ok(E.entryFails(b, Object.assign({}, r, { priceChange: { h6: -25, h24: 90 } }), ctx), 'h24 < 100');
  assert.ok(E.entryFails(b, Object.assign({}, r, { volumeH1: 9000 }), ctx), 'volume not rising');
  assert.ok(E.entryFails(b, Object.assign({}, r, { priceChange: { h6: -10, h24: 150 } }), ctx), 'only 10% off');
  // a stored snapshot higher than the implied prices raises the high: 1.6 -> drop 37.5% -> fail
  assert.ok(E.entryFails(b, r, { now: NOW, snaps: { MINT1pump: [[NOW - 3600000, 1.6]] } }), 'snapshot high');
});

test('exits per book: stops, targets, trails, max hold', () => {
  const p = {};
  const g = book('graduation-sniper').exit;
  assert.strictEqual(E.decideExit(p, g, -10, 0, 1).reason, 'sl');
  assert.strictEqual(E.decideExit(p, g, 40, 40, 1).reason, 'tp');
  assert.strictEqual(E.decideExit(p, g, 3.5, 15, 1).reason, 'trail');           // 1.035 <= 1.15*0.9
  assert.strictEqual(E.decideExit(p, g, 4, 14, 1), null);                        // trail not armed below +15
  assert.strictEqual(E.decideExit(p, g, 1, 2, 60).reason, 'time');
  const v = book('volume-explosion').exit;
  assert.strictEqual(E.decideExit(p, v, -8, 0, 1).reason, 'sl');
  assert.strictEqual(E.decideExit(p, v, 3.4, 10, 1).reason, 'trail');           // 1.034 <= 1.10*0.94
  assert.strictEqual(E.decideExit(p, v, 50, 50, 1), null, 'no fixed target');
  const t = book('trending-pullback').exit;
  assert.strictEqual(E.decideExit(p, t, 25, 25, 1).reason, 'tp');
  assert.strictEqual(E.decideExit(p, t, 10, 16, 1).reason, 'trail');            // 1.10 <= 1.16*0.95
  assert.strictEqual(E.decideExit(p, t, -10, 0, 1).reason, 'sl');
  const r = book('runner-hunter').exit;
  assert.strictEqual(E.decideExit({}, r, 10, 10, 1).action, 'partial');
  assert.strictEqual(E.decideExit({}, r, 5, 30, 1), null, 'no trail before the partial');
  assert.strictEqual(E.decideExit({ partialDone: true }, r, 10, 30, 1).reason, 'trail'); // 1.10 <= 1.30*0.85
  assert.strictEqual(E.decideExit({ partialDone: true }, r, -12, 30, 1).reason, 'sl');
  assert.strictEqual(E.decideExit({}, r, 1, 1, 240).reason, 'time');
});

test('stock block: TTWO, NIO, SPCX, SQQQ, AMC, DJT, xStocks, stables and wrapped majors', () => {
  // PR13 (t70u): by mint or full name. Real Backpack / xStocks mints:
  const real = { TTWO: 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo', SPCX: 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb', SQQQ: 'SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE',
    AMC: 'AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc', DJT: 'DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF', TSLAx: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', NVDAx: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' };
  for (const [s, m] of Object.entries(real)) assert.ok(/tokenised-stock/.test(classifyBlocked({ symbol: s, mint: m })), s);
  assert.ok(/tokenised-stock/.test(classifyBlocked({ symbol: 'NIO', mint: 'SomeOtherMint111', name: 'NIO Inc' })), 'NIO by full name');
  assert.ok(/tokenised-stock/.test(classifyBlocked({ symbol: 'NIOx', mint: 'XsNIOxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', name: 'NIO xStock' })), 'NIO xStock');
  assert.ok(/tokenised-stock/.test(classifyBlocked({ symbol: 'TTWO', mint: 'Abc', name: 'Take-Two Interactive' })), 'TTWO by full name');
  // ticker alone never blocks: the memecoin Max coin (MAX) and a pump.fun "TTWO" ticker
  assert.strictEqual(classifyBlocked({ symbol: 'Max', mint: '5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump', name: 'Max coin' }), null, 'Max coin not blocked');
  assert.strictEqual(classifyBlocked({ symbol: 'MAX', mint: '5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump', name: 'Max coin' }), null);
  assert.strictEqual(classifyBlocked({ symbol: 'TTWO', mint: 'TTWOfakepump', name: 'ttwo meme' }), null, 'pump.fun ticker alone is not a stock');
  assert.ok(/tokenised-stock/.test(classifyBlocked({ symbol: 'ABC', name: 'Apple xStock' })));
  assert.ok(/stablecoin/.test(classifyBlocked({ symbol: 'USDC' })));
  assert.ok(/wrapped/.test(classifyBlocked({ symbol: 'WETH' })));
  assert.strictEqual(classifyBlocked({ symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk' }), null);
});

test('mint/freeze check: revoked passes; authority, missing data, RPC error and Token-2022 traps reject (cached per mint)', async () => {
  const acct = (info, owner) => ({ owner: owner || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info } } });
  assert.ok(evaluateMintAccount(acct({ mintAuthority: null, freezeAuthority: null, decimals: 6 })).pass);
  assert.strictEqual(evaluateMintAccount(acct({ mintAuthority: 'X', freezeAuthority: null, decimals: 6 })).reason, 'mint-authority-not-revoked');
  assert.strictEqual(evaluateMintAccount(acct({ mintAuthority: null, freezeAuthority: 'X', decimals: 6 })).reason, 'freeze-authority-not-revoked');
  assert.ok(/missing-data/.test(evaluateMintAccount(null).reason));
  assert.ok(/missing-data/.test(evaluateMintAccount(acct({ decimals: 6 })).reason));
  assert.ok(/permanentDelegate/.test(evaluateMintAccount(acct({ mintAuthority: null, freezeAuthority: null, decimals: 6, extensions: [{ extension: 'permanentDelegate' }] }, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')).reason));
  let calls = 0;
  const lim = { post: async (bucket, url, body) => { calls++; assert.strictEqual(body.method, 'getAccountInfo'); if (body.params[0] === 'ERR') throw new Error('boom https://secret.example/key'); return { data: { result: { value: acct({ mintAuthority: null, freezeAuthority: null, decimals: 6 }) } } }; } };
  const ma = makeMintAuth(lim);
  assert.ok((await ma.check('M1')).pass);
  assert.ok((await ma.check('M1')).pass);
  assert.strictEqual(calls, 1, 'cached per mint');
  const bad = await ma.check('ERR');
  assert.ok(!bad.pass && /missing-data: rpc error/.test(bad.reason));
  assert.ok(!/secret/.test(bad.error), 'RPC url never leaks');
});

test('stale quotes are refused (> 30 s), fresh ones accepted', () => {
  assert.ok(E.quoteFresh({ ok: true, at: NOW - 29000 }, NOW, 30));
  assert.ok(!E.quoteFresh({ ok: true, at: NOW - 31000 }, NOW, 30));
  assert.ok(!E.quoteFresh({ ok: false, at: NOW }, NOW, 30));
});

// ---- runtime with mocked quotes ----
function harness(opts) {
  let t = NOW;
  const q = { buys: 0, sells: [] };
  const quotes = {
    buyQuote: async (mint, sol) => { q.buys++; return opts.buy ? opts.buy(sol, t) : { ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: 0.5, route: 'Pump' }; },
    sellQuote: async (mint, raw) => { q.sells.push(raw); return opts.sell(BigInt(raw), t); }
  };
  const mintAuth = { check: async () => (opts.rug || { pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const trades = [];
  const books = E.makeBooks({ config, quotes, mintAuth, reentry, saveTrade: tr => trades.push(tr), now: () => t });
  const state = { balance: 3, reentryCooldowns: {} };
  return { books, state, q, trades, adv: ms => { t += ms; }, now: () => t };
}
// value per raw token in lamports: 10000000000 raw = 0.05 SOL at entry -> 5e-12 SOL/raw
const sellAt = mult => (raw, t) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * mult)), priceImpactPct: 0.4, route: 'Pump' });
const gateOk = async () => ({ ok: true });

test('entry: Jupiter buy fill + sell-route check, book name/version, rug-check result and quotes on the position', async () => {
  let mult = 0.99;
  const h = harness({ sell: (raw, t) => sellAt(mult)(raw, t) });
  await h.books.runEntries(h.state, [row()], gateOk);
  const b = h.state.books;
  const pos = b.open.find(p => p.book === 'graduation-sniper');
  assert.ok(pos, JSON.stringify(b.rejects));
  assert.strictEqual(pos.strategyVersion, 'graduation-sniper v1');
  assert.strictEqual(pos.sizeSol, 0.05);
  assert.strictEqual(pos.entryQuote.outAmount, '10000000000');
  assert.strictEqual(pos.entryQuote.priceImpactPct, 0.5);
  assert.strictEqual(pos.rugCheck.pass, true);
  assert.strictEqual(pos.markSource, 'jupiter-sell-quote');
  assert.ok(Math.abs(h.state.balance - (3 - 0.05 * b.open.length)) < 1e-9);
  // capacity: a book never holds more than 2
  await h.books.runEntries(h.state, [row({ mint: 'A', pairAddress: 'PA' }), row({ mint: 'B', pairAddress: 'PB' }), row({ mint: 'C', pairAddress: 'PC' })], gateOk);
  assert.ok(h.state.books.open.filter(p => p.book === 'graduation-sniper').length <= 2);
});

test('entry refusals: stale scan row, stock block, failed rug check, no sell route, failed main-pool gate', async () => {
  const h = harness({ sell: sellAt(0.99) });
  await h.books.runEntries(h.state, [row({ fetchedAt: NOW - 31000 })], gateOk);
  await h.books.runEntries(h.state, [row({ symbol: 'TTWO', mint: 'TTWOmint' })], gateOk);
  assert.strictEqual(h.state.books.open.length, 0);
  const rs = h.state.books.rejects.recent.map(r => r.reason).join('|');
  assert.ok(/stale scan row/.test(rs) && /stock-block/.test(rs), rs);
  assert.strictEqual(h.q.buys, 0, 'no quote taken for a stale or blocked row');
  const h2 = harness({ sell: sellAt(0.99), rug: { pass: false, reason: 'freeze-authority-not-revoked' } });
  await h2.books.runEntries(h2.state, [row()], gateOk);
  assert.ok(/rug-check: freeze-authority-not-revoked/.test(JSON.stringify(h2.state.books.rejects)));
  const h3 = harness({ sell: (raw, t) => ({ ok: false, noRoute: true, at: t }) });
  await h3.books.runEntries(h3.state, [row()], gateOk);
  assert.ok(/no sell route/.test(JSON.stringify(h3.state.books.rejects)) && h3.state.books.open.length === 0);
  const h4 = harness({ sell: sellAt(0.99) });
  await h4.books.runEntries(h4.state, [row()], async () => ({ ok: false, reason: 'unverified' }));
  assert.ok(/main-pool check: unverified/.test(JSON.stringify(h4.state.books.rejects)) && h4.state.books.open.length === 0);
  const h5 = harness({ sell: sellAt(0.99), buy: (sol, t) => ({ ok: true, at: t - 31000, inAmount: String(sol * 1e9), outAmount: '10000000000', priceImpactPct: 0.1 }) });
  await h5.books.runEntries(h5.state, [row()], gateOk);
  assert.ok(/stale buy quote/.test(JSON.stringify(h5.state.books.rejects)) && h5.state.books.open.length === 0);
});

test('runner partial exit: sells 20% at +10%, trails the rest, books both legs net of 1.1%', async () => {
  let mult = 1.0;
  const h = harness({ sell: (raw, t) => sellAt(mult)(raw, t) });
  const r = row({ mint: 'RUNmint', pairAddress: 'PR', pairCreatedAt: NOW - 3 * 3600000, volumeH1: 10000, liquidityUsd: 50000 });
  await h.books.runEntries(h.state, [r], gateOk);
  const pos = h.state.books.open.find(p => p.book === 'runner-hunter');
  assert.ok(pos, JSON.stringify(h.state.books.rejects));
  h.state.books.open = [pos];
  const bal0 = h.state.balance;
  mult = 1.101; h.adv(5000); await h.books.runExits(h.state);
  assert.ok(pos.partialDone, 'partial taken');
  assert.strictEqual(pos.legs.length, 1);
  assert.strictEqual(pos.legs[0].sellPctOfOriginal, 20);
  assert.ok(Math.abs(pos.legs[0].pnlSol - (0.01101 - 0.01 - 0.01 * 0.011)) < 1e-8, 'leg pnl ' + pos.legs[0].pnlSol);
  assert.strictEqual(pos.tokensRemainingRaw, '8000000000');
  mult = 1.40; h.adv(5000); await h.books.runExits(h.state);
  assert.strictEqual(h.state.books.open.length, 1, 'riding');
  mult = 1.18; h.adv(5000); await h.books.runExits(h.state);           // 1.18 <= 1.40*0.85=1.19 -> trail
  assert.strictEqual(h.state.books.open.length, 0);
  const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'trail');
  assert.strictEqual(tr.strategyVersion, 'runner-hunter v1');
  const expect = (0.01101 - 0.01 - 0.00011) + (0.04 * 1.18 - 0.04 - 0.04 * 0.011);
  assert.ok(Math.abs(tr.pnlSol - expect) < 1e-8, tr.pnlSol + ' vs ' + expect);
  assert.ok(Math.abs(h.state.balance - (bal0 + 0.05 + expect)) < 1e-8, 'cash = basis + pnl');
  assert.ok(tr.exitQuote && tr.exitQuote.outAmount && tr.entryQuote.outAmount);
});

test('stop fills at the Jupiter sell quote (honest gap), and no route for 10 min books a total loss', async () => {
  let mult = 1.0;
  const h = harness({ sell: (raw, t) => sellAt(mult)(raw, t) });
  await h.books.runEntries(h.state, [row({ mint: 'SLmint', pairAddress: 'PS', pairCreatedAt: NOW - 3 * 3600000, volumeH1: 10000 })], gateOk);
  h.state.books.open = h.state.books.open.slice(0, 1);
  mult = 0.70; h.adv(5000); await h.books.runExits(h.state);
  const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'sl');
  assert.ok(Math.abs(tr.pnlPct - (-30 - 1.1)) < 1e-6, 'books the quoted -30%, not the -12% stop level: ' + tr.pnlPct);
  let route = true;
  const h2 = harness({ sell: (raw, t) => (route ? sellAt(1)(raw, t) : { ok: false, noRoute: true, at: t, error: 'COULD_NOT_FIND_ANY_ROUTE' }) });
  await h2.books.runEntries(h2.state, [row({ mint: 'NRmint', pairAddress: 'PN' })], gateOk);
  h2.state.books.open = h2.state.books.open.slice(0, 1);
  route = false;
  h2.adv(5000); await h2.books.runExits(h2.state);
  assert.strictEqual(h2.state.books.open.length, 1, 'holds while the route is missing < 10 min');
  h2.adv(10 * MIN); await h2.books.runExits(h2.state);
  assert.strictEqual(h2.trades[0].exitReason, 'no-route-total-loss');
  assert.ok(Math.abs(h2.trades[0].pnlPct - (-100 - 1.1)) < 1e-6);
});

test('exit refuses a stale sell quote', async () => {
  let stale = false;
  const h = harness({ sell: (raw, t) => Object.assign(sellAt(0.5)(raw, t), stale ? { at: t - 31000 } : {}) });
  await h.books.runEntries(h.state, [row({ mint: 'STmint', pairAddress: 'PT' })], gateOk);
  // entry took the sellAt(0.5) round trip: -50% > 10% cap -> rejected. Use a fresh harness at 1.0 then stale.
  assert.ok(/round trip/.test(JSON.stringify(h.state.books.rejects)));
  let m = 1;
  const h2 = harness({ sell: (raw, t) => Object.assign(sellAt(m)(raw, t), stale ? { at: t - 31000 } : {}) });
  await h2.books.runEntries(h2.state, [row({ mint: 'STmint', pairAddress: 'PT' })], gateOk);
  h2.state.books.open = h2.state.books.open.slice(0, 1);
  stale = true; m = 0.5; h2.adv(5000); await h2.books.runExits(h2.state);
  assert.strictEqual(h2.state.books.open.length, 1, 'no exit on a stale quote');
  assert.strictEqual(h2.state.books.open[0].staleQuoteRefusals, 1);
});

test('scoreboard per book: profit per trade, net without best, worst loss, progress', () => {
  const s = E.bookStats([{ pnlSol: 0.02, pnlPct: 40 }, { pnlSol: -0.005, pnlPct: -10 }, { pnlSol: 0.001, pnlPct: 2 }], [], 30);
  assert.strictEqual(s.trades, 3);
  assert.strictEqual(s.netWithoutBestSol, -0.004);
  assert.strictEqual(s.worstLossPct, -10);
  assert.strictEqual(s.progress, '3/30');
  assert.ok(Math.abs(s.profitPerTradeSol - 0.016 / 3) < 1e-6);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} books tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
