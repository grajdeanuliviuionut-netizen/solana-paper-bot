// PR14 tests: one exit loop for all open trades on Jupiter sell quotes (no network, no wallet).
const assert = require('assert');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const sellAgent = require('../src/sellAgent');
const { classifyBlocked } = require('../src/books/blocklist');
const { makeLegacyExits, nextDelayMs, makeStats } = require('../src/exitLoop');
const stopFills = require('../src/stopFills');
const { makeBooks } = require('../src/books/engine');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const MIN = 60000;
let NOW = Date.parse('2026-11-21T20:00:00Z');
const computePnl = (pos, px) => ((px - pos.entryPrice) / pos.entryPrice - 0.011) * pos.sizeSol;

// Fake Jupiter: sell quote returns sizeSol * mult SOL for the full token amount.
function harness(opts = {}) {
  const calls = [];
  const quotes = {
    sellQuote: async (mint, raw) => { calls.push(['sell', mint, raw]); return opts.sell(mint, raw, NOW); },
    buyQuote: async () => ({ ok: false, error: 'unused' }),
    getSolUsd: async () => ({ v: 150, at: NOW })
  };
  const mintAuth = { check: async () => ({ pass: true, decimals: 6 }) };
  const closed = [];
  const state = { balance: 1, openPositions: [], trades: [] };
  const lx = makeLegacyExits({ config, quotes, mintAuth, sellAgent, computePnl, classifyBlocked, onClose: t => closed.push(t), now: () => NOW });
  return { state, lx, closed, calls, quotes };
}
const pos = (o = {}) => Object.assign({ id: 'L1', strategyId: 'dip-hold', symbol: 'DIGS', mint: 'MINT_DIGS', pairAddress: 'P1', entryPrice: 0.001, sizeSol: 0.1,
  entryTime: new Date(NOW - 10 * MIN).toISOString(), exit: config.strategies.find(s => s.id === 'dip-hold').exit, highest: 0.0011, lastPrice: 0.0011, tokensRaw: '15000000000', lastLiquidityUsd: 80000 }, o);
const sellAt = mult => (mint, raw, t) => ({ ok: true, at: t, inAmount: raw, outAmount: String(Math.round(0.1 * mult * 1e9)), priceImpactPct: 1.7 });

test('cadence: 5 s target; with many open trades the period stretches to n * 60/exitQuotesPerMin (Jupiter budget), never a busy loop', () => {
  const cfg = { targetMs: 5000, exitQuotesPerMin: 45 };
  assert.strictEqual(nextDelayMs(1200, 1, cfg), 3800);
  assert.strictEqual(nextDelayMs(4000, 3, cfg), 1000);
  assert.strictEqual(nextDelayMs(7700, 7, cfg), Math.ceil(7 * 60000 / 45) - 7700); // 7 open -> 9.33 s period
  assert.strictEqual(nextDelayMs(9000, 0, cfg), 200, 'min rest');
  // 7 open trades -> at most 45 exit quotes/min
  const period = 7700 + nextDelayMs(7700, 7, cfg);
  assert.ok((7 * 60000) / period <= 45.01);
});

test('legacy: marked from a Jupiter sell quote for the exact token amount (not DexScreener); stop fires on the quote', async () => {
  let mult = 0.99;
  const h = harness({ sell: (m, r, t) => sellAt(mult)(m, r, t) });
  h.state.openPositions = [pos()];
  const st = makeStats();
  await h.lx.run(h.state, st);
  const p = h.state.openPositions[0];
  assert.deepStrictEqual(h.calls[0], ['sell', 'MINT_DIGS', '15000000000']);
  assert.strictEqual(p.markSource, 'jupiter-sell-quote');
  assert.ok(Math.abs(p.markPct - (-1)) < 1e-9);
  assert.ok(Math.abs(p.lastPrice - 0.00099) < 1e-12, 'entry-price equivalent of the quote');
  assert.strictEqual(p.highest, 0.001, 'DexScreener high dropped on the first Jupiter mark');
  NOW += 5000; mult = 0.97;
  await h.lx.run(h.state, st);
  assert.strictEqual(h.state.openPositions.length, 1, '-3% < 5% stop: hold');
  NOW += 5000; mult = 0.92;                                     // -8% on a -5% stop
  await h.lx.run(h.state, st);
  assert.strictEqual(h.state.openPositions.length, 0);
  const tr = h.closed[0];
  assert.strictEqual(tr.exitReason, 'sl');
  assert.strictEqual(tr.exitPriceSource, 'jupiter-sell-quote');
  assert.ok(Math.abs(tr.pnlSol - 0.1 * (-0.08 - 0.011)) < 1e-9, 'pnl = quoted -8% minus 1.1% costs: ' + tr.pnlSol);
  assert.ok(Math.abs(h.state.balance - (1 + 0.1 + tr.pnlSol)) < 1e-12);
  assert.strictEqual(st.intervals.length, 2);
  assert.deepStrictEqual(st.intervals, [5, 5]);
  const v = st.view({ targetMs: 5000, exitQuotesPerMin: 45, maxExitQuoteAgeSec: 10 }, 0);
  assert.strictEqual(v.checkIntervalSec.median, 5);
});

test('stop fill record: stop level, expected stop price, last check before the trigger, actual fill, overshoot, quote age, impact, liquidity, time since check', async () => {
  let mult = 0.97;
  const h = harness({ sell: (m, r, t) => Object.assign(sellAt(mult)(m, r, t), { at: t - 2000 }) });
  h.state.openPositions = [pos()];
  await h.lx.run(h.state);
  NOW += 6000; mult = 0.88;
  await h.lx.run(h.state);
  const sf = h.closed[0].stopFill;
  assert.ok(sf, 'stopFill on the trade');
  assert.strictEqual(h.state.stopFills[0], sf);
  assert.strictEqual(sf.stopLevelPct, -5);
  assert.ok(Math.abs(sf.expectedStopPrice - 0.00095) < 1e-12);
  assert.strictEqual(sf.lastCheckPnlPct, -3);
  assert.strictEqual(sf.lastCheckBefore.quoteAgeSec, 2);
  assert.strictEqual(sf.actualFillPct, -12);
  assert.ok(Math.abs(sf.actualFillPrice - 0.00088) < 1e-12);
  assert.strictEqual(sf.overshootPct, -7);
  assert.strictEqual(sf.quoteAgeSec, 2);
  assert.strictEqual(sf.priceImpactPct, 1.7);
  assert.strictEqual(sf.liquidityUsd, 80000);
  assert.strictEqual(sf.sinceLastCheckSec, 6);
  assert.strictEqual(sf.gapBetweenChecksPct, -9);
  assert.strictEqual(sf.netPnlPct, -13.1);
  for (const k of ['strategyId', 'strategyVersion', 'symbol', 'mint', 'at']) assert.ok(sf[k], k);
  const sum = stopFills.summary({ stopFills: [sf, Object.assign({}, sf, { overshootPct: -1, strategyId: 'runner-hunter' }), Object.assign({}, sf, { overshootPct: -2, strategyId: 'runner-hunter' })] });
  assert.strictEqual(sum.count, 3);
  assert.strictEqual(sum.medianOvershootPct, -2);
  assert.strictEqual(sum.maxOvershootPct, -7);
  assert.ok(Math.abs(sum.avgOvershootPct - (-10 / 3)) < 1e-3);
  assert.strictEqual(sum.byStrategy['runner-hunter'].count, 2);
});

test('quote older than 10 s is never acted on', async () => {
  const h = harness({ sell: (m, r, t) => Object.assign(sellAt(0.5)(m, r, t), { at: t - 11000 }) });
  h.state.openPositions = [pos()];
  await h.lx.run(h.state);
  assert.strictEqual(h.state.openPositions.length, 1);
  assert.strictEqual(h.state.openPositions[0].staleQuoteRefusals, 1);
  assert.strictEqual(h.lx.stats.staleRefusals, 1);
});

test('no-route debounce: total loss only after 5 consecutive no-route answers AND 10 min; a quote in between resets it', async () => {
  let route = false;
  const h = harness({ sell: (m, r, t) => (route ? sellAt(1)(m, r, t) : { ok: false, noRoute: true, at: t, error: 'COULD_NOT_FIND_ANY_ROUTE' }) });
  h.state.openPositions = [pos()];
  for (let i = 0; i < 4; i++) { await h.lx.run(h.state); NOW += 5 * MIN; }
  assert.strictEqual(h.state.openPositions.length, 1, '4 no-routes over 20 min: hold');
  route = true; await h.lx.run(h.state);
  assert.strictEqual(h.state.openPositions[0].noRouteCount, 0, 'route back resets');
  route = false;
  for (let i = 0; i < 5; i++) { NOW += 5000; await h.lx.run(h.state); }
  assert.strictEqual(h.state.openPositions.length, 1, '5 in a row but only 20 s: hold');
  NOW += 10 * MIN; await h.lx.run(h.state);
  assert.strictEqual(h.state.openPositions.length, 0);
  assert.strictEqual(h.closed[0].exitReason, 'no-route-total-loss');
  assert.ok(Math.abs(h.closed[0].pnlSol - (-0.1 * 1.011)) < 1e-12);
});

test('carried position (no token amount): tokens estimated from size * SOL/USD / entry price, flagged tokensEstimated', async () => {
  const h = harness({ sell: sellAt(1) });
  h.state.openPositions = [pos({ tokensRaw: undefined })];
  await h.lx.run(h.state);
  const p = h.state.openPositions[0];
  assert.strictEqual(p.tokensRaw, String(0.1 * 150 / 0.001 * 1e6));  // 15000 tokens, 6 decimals
  assert.strictEqual(p.tokensEstimated, true);
  assert.strictEqual(h.calls[0][2], p.tokensRaw);
});

test('stock-blocked legacy position closes at the Jupiter quote; positions pushed by the scan meanwhile are kept', async () => {
  const h = harness({ sell: sellAt(1.02) });
  const a = pos({ id: 'S', symbol: 'TSLAx', name: 'Tesla xStock', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB' });
  h.state.openPositions = [a];
  const orig = h.quotes.sellQuote;
  h.quotes.sellQuote = async (m, r) => { h.state.openPositions.push(pos({ id: 'NEW', mint: 'MINT_NEW' })); return orig(m, r); };
  await h.lx.runOne(h.state, a);
  assert.strictEqual(h.closed[0].exitReason, 'stock-block');
  assert.deepStrictEqual(h.state.openPositions.map(p => p.id), ['NEW']);
});

test('books: stop exit logs the stop fill with the last check before the trigger (engine)', async () => {
  // Minimal engine harness: one open book position, Jupiter sell quotes at a multiplier.
  let mult = 0.95;
  const quotes = { sellQuote: async (m, raw) => ({ ok: true, at: NOW, inAmount: raw, outAmount: String(Math.round(0.05 * mult * 1e9)), priceImpactPct: 2.1 }) };
  const books = makeBooks({ config, quotes, mintAuth: {}, reentry: { recordExit() {}, blocked() { return null; } }, log: null, saveTrade: null, now: () => NOW });
  const state = { balance: 1 };
  const b = books.ensure(state);
  const ex = config.books.list.find(x => x.id === 'runner-hunter').exit;
  b.open.push({ id: 'B1', book: 'runner-hunter', strategyVersion: 'runner-hunter v1', symbol: 'RAMBO', mint: 'MR', entryTime: new Date(NOW - 5 * MIN).toISOString(), sizeSol: 0.05, costBasisRemainingSol: 0.05,
    tokensRaw: '1000000000', tokensRemainingRaw: '1000000000', decimals: 6, entryPrice: 0.05 / 1000, exit: ex, legs: [], lastLiquidityUsd: 37930 });
  const st = makeStats();
  await books.runExits(state, st);
  NOW += 7000; mult = 0.80;
  await books.runExits(state, st);
  assert.strictEqual(b.open.length, 0);
  const sf = state.stopFills[0];
  assert.strictEqual(sf.strategyId, 'runner-hunter');
  assert.strictEqual(sf.stopLevelPct, -ex.stopLossPct);
  assert.strictEqual(sf.lastCheckPnlPct, -5);
  assert.strictEqual(sf.actualFillPct, -20);
  assert.strictEqual(sf.overshootPct, -20 + ex.stopLossPct);
  assert.strictEqual(sf.sinceLastCheckSec, 7);
  assert.strictEqual(sf.liquidityUsd, 37930);
  assert.strictEqual(b.trades[0].stopFill, sf, 'on the trade record');
  assert.deepStrictEqual(st.intervals, [7]);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(passed + '/' + tests.length + ' exits tests passed');
  if (passed !== tests.length) process.exit(1);
})();
