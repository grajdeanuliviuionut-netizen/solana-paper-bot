// t85u: P&L by strategy since a scoreboard start must sum to the equity change (residual ~0). No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const P = require('../src/pnl');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const SINCE = '2026-11-21T18:42:46.000Z';
const at = m => new Date(Date.parse(SINCE) + m * 60000).toISOString();
const leg = (m, basis, solOut, reason) => ({ at: at(m), basisSol: basis, solOut, costSol: +(basis * 0.011).toFixed(9), pnlSol: +(solOut - basis - basis * 0.011).toFixed(9), reason });

// A small world: start equity 3.0 (cash 2.85 + 0.15 legacy carried at cost).
function world() {
  const cash0 = 2.85;
  const legacyCarried = { id: 'L0', symbol: 'OLD', strategyId: 'dip-hold', legacy: true, sizeSol: 0.15, entryTime: at(-30), closedAt: at(5), pnlSol: 0.15 * (-0.05 - 0.011) };
  const legacyNew = { id: 'L1', symbol: 'NEW', strategyId: 'momentum-entry', legacy: true, sizeSol: 0.075, entryTime: at(10), closedAt: at(20), pnlSol: 0.075 * (0.08 - 0.011) };
  // book trade with a 20% partial then the rest (HODL-like)
  const hodlLegs = [leg(40, 0.01, 0.0112, 'partial-tp'), leg(90, 0.04, 0.036, 'trail')];
  const hodl = { id: 'B1', symbol: 'HODL', book: 'runner-hunter', bookVersion: 1, strategyId: 'runner-hunter', sizeSol: 0.05, entryTime: at(30), closedAt: at(90), legs: hodlLegs, pnlSol: hodlLegs.reduce((a, l) => a + l.pnlSol, 0) };
  const grad = { id: 'B2', symbol: 'RUG', book: 'graduation-sniper', bookVersion: 1, strategyId: 'graduation-sniper', sizeSol: 0.05, entryTime: at(50), closedAt: at(60), legs: [leg(60, 0.05, 0, 'no-route-total-loss')], pnlSol: -0.05055 };
  // open book position with a partial already sold (80% remainder held)
  const open = { id: 'B3', symbol: 'RUN', book: 'runner-hunter', bookVersion: 1, strategyId: 'runner-hunter', sizeSol: 0.05, entryTime: at(100), legs: [leg(110, 0.01, 0.0111, 'partial-tp')], costBasisRemainingSol: 0.04, remainingFrac: 0.8, lastQuote: { outAmount: String(0.042e9) } };
  const closed = [legacyCarried, legacyNew, hodl, grad];
  // cash flow: start, minus entries, plus sells (legacy: size + pnl; book legs: solOut - cost)
  let cash = cash0;
  cash += 0.15 + legacyCarried.pnlSol;
  cash -= 0.075; cash += 0.075 + legacyNew.pnlSol;
  cash -= 0.05; for (const l of hodlLegs) cash += l.solOut - l.costSol;
  cash -= 0.05; cash += 0 - grad.legs[0].costSol;
  cash -= 0.05; cash += open.legs[0].solOut - open.legs[0].costSol;
  return { closed, open, cash, win: { epoch: 'books-v1', since: SINCE, startEquity: 3.0, startBalance: cash0 } };
}

test('book legs, legacy closes, a carried legacy position and an open partial sum to the equity change (residual 0)', () => {
  const w = world();
  const o = P.reconcile({ trades: P.mergeTrades([], w.closed), openBook: [w.open], openLegacy: [], balance: w.cash, win: w.win, costPct: 1.1 });
  assert.ok(Math.abs(o.residualSol) < 1e-6, 'residual ' + o.residualSol);
  assert.strictEqual(o.reconciled, true);
  const rh = o.rows.find(x => x.key === 'runner-hunter v1');
  assert.strictEqual(rh.trades, 1); assert.strictEqual(rh.open, 1); assert.strictEqual(rh.partialLegs, 2);
  assert.ok(Math.abs(rh.realisedOpenSol - w.open.legs[0].pnlSol) < 1e-9);
  // costs are pro rata per leg: 1.1% of each leg's basis
  assert.ok(Math.abs(rh.costsSol - 0.011 * (0.01 + 0.04 + 0.01)) < 1e-9, String(rh.costsSol));
  // unrealised = quote value - remaining basis x 1.011
  assert.ok(Math.abs(rh.unrealisedSol - (0.042 - 0.04 * 1.011)) < 1e-9);
  assert.ok(Math.abs(o.markedChangeSol - (o.equityChangeSol + o.unrealisedSol)) < 1e-9);
  assert.ok(o.rows.find(x => x.key === 'dip-hold legacy'));
  assert.ok(o.rows.find(x => x.key === 'graduation-sniper v1'));
});

test('a capped in-memory list (state.trades max 100) leaves a residual; trades.jsonl closes it', () => {
  const w = world();
  const mem = w.closed.filter(t => t.id !== 'L0');          // the oldest legacy close fell off the in-memory list
  const capped = P.reconcile({ trades: P.mergeTrades([], mem), openBook: [w.open], openLegacy: [], balance: w.cash, win: w.win });
  assert.ok(Math.abs(capped.residualSol - w.closed[0].pnlSol) < 1e-6, 'residual equals the dropped trade: ' + capped.residualSol);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-'));
  const file = path.join(TMP, 'trades.jsonl');
  fs.writeFileSync(file, w.closed.map(t => JSON.stringify(t)).join('\n') + '\n{torn');
  const state = { balance: w.cash, trades: mem.filter(t => t.legacy), books: { trades: mem.filter(t => !t.legacy), open: [w.open] }, openPositions: [], scoreboard: w.win };
  const o = P.report(state, { costRoundtripPct: 1.1 }, { tradesFile: file });
  assert.strictEqual(o.source.tradesJsonl, true);
  assert.strictEqual(o.source.merged, 4, 'deduplicated by id + closedAt');
  assert.ok(Math.abs(o.residualSol) < 1e-6, 'residual ' + o.residualSol);
});

test('a position carried across a start only counts its in-window legs; a closed epoch uses its own window', () => {
  const w = world();
  const split = at(95);
  const before = P.reconcile({ trades: P.mergeTrades([], w.closed), openBook: [w.open], openLegacy: [], balance: w.cash, win: Object.assign({}, w.win, { until: split, endEquity: 0 }) });
  const rhBefore = before.rows.find(x => x.key === 'runner-hunter v1');
  assert.strictEqual(rhBefore.trades, 1);
  assert.strictEqual(rhBefore.realisedOpenSol, 0, 'the open partial at +110 min is after the split');
  const after = P.reconcile({ trades: P.mergeTrades([], w.closed), openBook: [w.open], openLegacy: [], balance: w.cash, win: { since: split, startEquity: 0 } });
  const rhAfter = after.rows.find(x => x.key === 'runner-hunter v1');
  assert.strictEqual(rhAfter.trades, 0);
  assert.ok(Math.abs(rhAfter.realisedOpenSol - w.open.legs[0].pnlSol) < 1e-9);
  assert.strictEqual(after.rows.length, 1, 'only runner-hunter after the split');
  // carried closed trade: entry before the split, legs on both sides -> only the later leg counts
  const carried = { id: 'C', book: 'runner-hunter', bookVersion: 1, strategyId: 'runner-hunter', sizeSol: 0.05, closedAt: at(100), legs: [leg(80, 0.01, 0.011, 'partial-tp'), leg(100, 0.04, 0.035, 'sl')], pnlSol: 0 };
  const c = P.reconcile({ trades: [P.compact(carried)], openBook: [], openLegacy: [], balance: 0, win: { since: split, startEquity: 0 } });
  assert.strictEqual(c.rows[0].carriedTrades, 1);
  assert.ok(Math.abs(c.rows[0].realisedSol - carried.legs[1].pnlSol) < 1e-9);
});

(async () => {
  for (const [n, f] of tests) { try { await f(); passed++; console.log('ok  ' + n); } catch (e) { console.error('FAIL ' + n + '\n  ' + (e.stack || e)); process.exitCode = 1; } }
  console.log(passed + '/' + tests.length + ' pnl tests passed');
})();
