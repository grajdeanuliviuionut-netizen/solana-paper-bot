// Cross-strategy same-mint guard (RA 22 Nov, FIONA held by trending-pullback AND dip-hold). No network.
const assert = require('assert');
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const { heldMint, REASON } = require('../src/books/sameMint');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
const NOW = Date.parse('2026-11-22T04:00:00Z');
// A row every book's entry rules accept is not needed: graduation-sniper accepts this row (pump origin, 10 min).
const row = o => Object.assign({ pairAddress: 'POOL1', mint: 'MINT1pump', symbol: 'MEME', name: 'Meme', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 50000,
  volumeH1: 20000, volumeM5: 1000, volumeH6: 60000, priceChange: { m5: 2, h1: 5, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 10 * MIN, dexId: 'pumpswap', fetchedAt: NOW - 5000 }, o || {});
function harness() {
  let t = NOW;
  const q = { buys: 0 };
  const quotes = {
    buyQuote: async (mint, sol) => { q.buys++; return { ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: 0.5, route: 'Pump' }; },
    sellQuote: async (mint, raw) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * 0.99)), priceImpactPct: 0.4, route: 'Pump' })
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'ok', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const holderCheck = { check: async () => ({ pass: true, reason: 'ok', lpLockedPct: 100, top10Pct: 12, maxHolderPct: 3, creatorPct: 0 }) };
  const books = E.makeBooks({ config, quotes, mintAuth, reentry, holderCheck, saveTrade: () => {}, now: () => t, sleep: async ms => { t += ms; } });
  const state = { balance: 3, reentryCooldowns: {}, openPositions: [] };
  return { books, state, q };
}
const gateOk = async () => ({ ok: true });
const holdsOf = (st, mint) => (st.openPositions || []).filter(p => p.mint === mint).length + ((st.books && st.books.open) || []).filter(p => p.mint === mint).length;

test('helper: free mint -> null; held in legacy or book -> sameMintHeld with who holds it; no mint fails closed', () => {
  const st = { openPositions: [{ id: 1, strategyId: 'dip-hold', mint: 'L1', pairAddress: 'PL' }], books: { open: [{ id: 'bk1', book: 'trending-pullback', strategyId: 'trending-pullback', mint: 'B1', pairAddress: 'PB' }] } };
  assert.strictEqual(heldMint(st, { mint: 'FREE' }), null);
  const a = heldMint(st, { mint: 'L1' }); assert.strictEqual(a.reason, REASON); assert.strictEqual(a.heldBy[0].strategyId, 'dip-hold'); assert.strictEqual(a.heldBy[0].kind, 'legacy');
  const b = heldMint(st, { mint: 'B1' }); assert.strictEqual(b.heldBy[0].strategyId, 'trending-pullback'); assert.strictEqual(b.heldBy[0].kind, 'book');
  const c = heldMint(st, { mint: null, pairAddress: 'X' }); assert.ok(c && c.failClosed, 'no mint -> blocked');
  // an open position missing its mint still blocks the same pool
  const st2 = { openPositions: [{ id: 2, strategyId: 'momentum-entry', mint: null, pairAddress: 'PX' }] };
  assert.ok(heldMint(st2, { mint: 'M', pairAddress: 'PX' }));
  assert.strictEqual(REASON, 'sameMintHeld');
});

test('book blocked by a LEGACY hold (FIONA case reversed): no quote, sameMintHeld reject', async () => {
  const h = harness();
  h.state.openPositions.push({ id: 7, strategyId: 'dip-hold', mint: 'MINT1pump', pairAddress: 'POOL1', symbol: 'MEME', entryTime: new Date(NOW).toISOString(), sizeSol: 0.0878 });
  await h.books.runEntries(h.state, [row()], gateOk);
  assert.strictEqual(h.state.books.open.length, 0);
  assert.strictEqual(h.q.buys, 0, 'no Jupiter quote spent on a held mint');
  assert.ok(h.state.books.rejects.byReason[REASON] >= 1, JSON.stringify(h.state.books.rejects.byReason));
  const r = h.state.books.rejects.recent.find(x => x.reason === REASON);
  assert.ok(r && r.heldBy[0].strategyId === 'dip-hold' && /dip-hold \(legacy\)/.test(r.detail));
  assert.ok(h.state.books.sameMint.blocked >= 1);
  // grad sniper v2 candidate log shows the reject too
  assert.ok(h.state.books.gradSniper.candidateLog.some(x => x.reason === REASON && x.result === 'rejected'));
});

test('book blocked by ANOTHER book, and a book cannot double itself', async () => {
  const h = harness();
  await h.books.runEntries(h.state, [row()], gateOk);
  assert.strictEqual(holdsOf(h.state, 'MINT1pump'), 1, 'only one book holds the mint');
  const holder = h.state.books.open[0].book;
  await h.books.runEntries(h.state, [row()], gateOk);
  await h.books.runEntries(h.state, [row()], gateOk);
  assert.strictEqual(holdsOf(h.state, 'MINT1pump'), 1, 'still one holding after more passes');
  const bb = h.state.books.rejects.byBook[holder] || {};
  assert.ok(bb[REASON] >= 1, 'the holding book itself was refused: ' + JSON.stringify(h.state.books.rejects.byBook));
});

test('unheld mints still enter; closed trades do not block', async () => {
  const h = harness();
  h.state.openPositions.push({ id: 8, strategyId: 'dip-hold', mint: 'OTHER', pairAddress: 'PO' });
  h.state.trades = [{ strategyId: 'dip-hold', mint: 'MINT1pump', pairAddress: 'POOL_OLD', closedAt: new Date(NOW - 300 * MIN).toISOString(), pnlSol: -0.01 }];
  h.state.books = { open: [], trades: [{ book: 'trending-pullback', mint: 'MINT1pump', pairAddress: 'POOL_OLD', closedAt: new Date(NOW - 300 * MIN).toISOString(), pnlSol: -0.01 }] };
  await h.books.runEntries(h.state, [row()], gateOk);
  assert.strictEqual(h.state.books.open.filter(p => p.mint === 'MINT1pump').length, 1, JSON.stringify(h.state.books.rejects.recent.slice(0, 3)));
  const newId = h.state.books.open.find(p => p.mint === 'MINT1pump').id;
  // later books in the same pass are refused only because of the NEW holding, never the closed trades
  assert.ok(h.state.books.rejects.recent.filter(x => x.reason === REASON).every(x => x.heldBy.length === 1 && x.heldBy[0].positionId === newId));
  // a fully closed position object (remainingFrac 0 / closedAt) never blocks either
  assert.strictEqual(heldMint({ openPositions: [{ mint: 'Z', remainingFrac: 0 }], books: { open: [{ mint: 'Z', closedAt: 'x' }] } }, { mint: 'Z' }), null);
});

test('legacy reject store: rejectLegacy records sameMintHeld per legacy strategy', () => {
  const h = harness();
  h.books.rejectLegacy(h.state, 'dip-hold', { symbol: 'FIONA', mint: 'B34n' }, REASON, { detail: 'mint already held by trending-pullback (book)' });
  const b = h.state.books;
  assert.strictEqual(b.rejects.byReason[REASON], 1);
  assert.strictEqual(b.rejects.byBook['dip-hold legacy'][REASON], 1);
  assert.strictEqual(b.rejects.recent[0].book, 'dip-hold legacy');
  assert.strictEqual(b.sameMint.byStrategy['dip-hold'], 1);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} samemint tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
