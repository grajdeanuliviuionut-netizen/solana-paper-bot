// t83u (Liviu 22 Nov 06:46): only runner-hunter may enter. Runs on the LIVE config (no test/_active.js preload).
// Paused = no new entries; open positions of paused strategies are still marked and exited. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-pause-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const sellAgent = require('../src/sellAgent');
const { classifyBlocked } = require('../src/books/blocklist');
const { makeLegacyExits, makeStats } = require('../src/exitLoop');
const { generateSignals } = require('../src/buyAgent');
const { review } = require('../src/manager');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
let NOW = Date.parse('2026-11-22T06:50:00Z');
const row = o => Object.assign({ pairAddress: 'POOL1', mint: 'MINT1pump', symbol: 'MEME', name: 'Meme', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 50000,
  volumeH1: 20000, volumeM5: 1000, volumeH6: 60000, priceChange: { m5: 2, h1: 5, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 10 * MIN, dexId: 'pumpswap', fetchedAt: NOW - 5000, ageDays: 5 }, o || {});

test('live config: only runner-hunter is active (books + legacy); dip-hold slot reserve removed', () => {
  assert.deepStrictEqual(config.books.list.filter(b => !b.paused).map(b => b.id), ['runner-hunter']);
  assert.deepStrictEqual(config.strategies.filter(s => !s.paused).map(s => s.id), []);
  assert.deepStrictEqual(config.slotReserve, {});
  const st = { trades: [] };
  review(st, config);
  assert.deepStrictEqual(st.pausedIds.slice().sort(), ['aggressive-flow', 'buyer-turn', 'dip-buyers', 'dip-hold', 'momentum-entry']);
});

test('legacy: no strategy produces a signal (a dip-hold-shaped row signals nothing)', () => {
  const dip = row({ liquidityUsd: 100000, priceChange: { m5: 1, h1: -6 }, txns: { buys: 200, sells: 100 } });
  assert.strictEqual(generateSignals([dip, row()]).signals.length, 0);
});

let t = NOW;
function harness(mult) {
  const q = { buys: 0, holder: 0, m: mult };
  const quotes = {
    buyQuote: async (mint, sol) => { q.buys++; return { ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: 0.5, route: 'Pump' }; },
    sellQuote: async (mint, raw) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * q.m)), priceImpactPct: 0.4, route: 'Pump' })
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'ok', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const holderCheck = { check: async () => { q.holder++; return { pass: true, reason: 'ok', lpLockedPct: 100, top10Pct: 1, maxHolderPct: 1, creatorPct: 0 }; } };
  const trades = [];
  const books = E.makeBooks({ config, quotes, mintAuth, reentry, holderCheck, saveTrade: tr => trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  return { books, q, trades, state: { balance: 3, reentryCooldowns: {}, openPositions: [] } };
}

test('books: a row every book accepts -> only runner-hunter opens; paused books take no candidates, no RugCheck call', async () => {
  const h = harness(0.99);
  t = NOW;
  await h.books.runEntries(h.state, [row(), row({ mint: 'M2pump', pairAddress: 'P2', symbol: 'TWO' })], async () => ({ ok: true }));
  const open = h.state.books.open;
  assert.ok(open.length >= 1, JSON.stringify(h.state.books.rejects.recent.slice(0, 3)));
  assert.ok(open.every(p => p.book === 'runner-hunter'), open.map(p => p.book).join(','));
  assert.deepStrictEqual(Object.keys(h.state.books.lastScan.candidatesByBook), ['runner-hunter']);
  assert.strictEqual(h.q.holder, 0, 'graduation sniper paused -> no RugCheck holder checks');
  assert.strictEqual(h.state.books.gradSniper.candidates, 0);
  const rep = h.books.report(h.state);
  assert.deepStrictEqual(rep.filter(b => b.paused).map(b => b.strategyId).sort(), ['graduation-sniper', 'trending-pullback', 'volume-explosion']);
  assert.ok(rep.find(b => b.strategyId === 'runner-hunter').status === 'active');
});

test('paused BOOK: its open position is still marked and exited by the exit loop (stop on the Jupiter quote)', async () => {
  const h = harness(0.99);
  t = NOW;
  await h.books.runEntries(h.state, [row()], async () => ({ ok: true }));
  const p = h.state.books.open[0];
  // turn it into an open trending-pullback position (paused book), as one opened before the pause
  const tp = config.books.list.find(b => b.id === 'trending-pullback');
  Object.assign(p, { book: 'trending-pullback', strategyId: 'trending-pullback', bookName: tp.name, bookVersion: tp.version, strategyVersion: 'trending-pullback v1', exit: tp.exit });
  t += 10000; h.q.m = 0.85;   // -15% < -10% stop
  await h.books.runExits(h.state, makeStats());
  assert.strictEqual(h.state.books.open.length, 0, 'paused book position exited');
  const tr = h.state.books.trades[0];
  assert.strictEqual(tr.book, 'trending-pullback'); assert.strictEqual(tr.exitReason, 'sl');
});

test('paused LEGACY strategy: its open position is still exited on the Jupiter sell quote', async () => {
  const closed = [];
  const quotes = { sellQuote: async (mint, raw) => ({ ok: true, at: NOW, inAmount: raw, outAmount: String(Math.round(0.1 * 0.9 * 1e9)), priceImpactPct: 1 }), buyQuote: async () => ({ ok: false }), getSolUsd: async () => ({ v: 150, at: NOW }) };
  const lx = makeLegacyExits({ config, quotes, mintAuth: { check: async () => ({ pass: true, decimals: 6 }) }, sellAgent, computePnl: (pos, px) => ((px - pos.entryPrice) / pos.entryPrice - 0.011) * pos.sizeSol, classifyBlocked, onClose: tr => closed.push(tr), now: () => NOW });
  const state = { balance: 1, trades: [], pausedIds: ['dip-hold'], openPositions: [{ id: 'L1', strategyId: 'dip-hold', symbol: 'DIGS', mint: 'MINT_DIGS', pairAddress: 'P1', entryPrice: 0.001, sizeSol: 0.1,
    entryTime: new Date(NOW - 10 * MIN).toISOString(), exit: config.strategies.find(s => s.id === 'dip-hold').exit, highest: 0.001, lastPrice: 0.001, tokensRaw: '15000000000', lastLiquidityUsd: 80000 }] };
  await lx.run(state, makeStats());
  assert.strictEqual(state.openPositions.length, 0, 'paused dip-hold position exited');
  assert.strictEqual(closed[0].exitReason, 'sl');
});

test('app: GT new_pools feed is off while the graduation sniper is paused; pause state in /api/books + /api/bots payloads', async () => {
  const scannerPath = require.resolve('../src/agents/scanner');
  require.cache[scannerPath] = { id: scannerPath, filename: scannerPath, loaded: true, exports: { scan: async () => [] } };
  const np = require('../src/newPools');
  let feedCalls = 0;
  np._setDeps({ http: { get: async () => { feedCalls++; return { status: 200, data: { data: [] } }; } } });
  require('../src/httpBackoff')._setDeps({ http: { get: async () => ({ data: { data: [] } }) }, sleep: async () => {}, now: () => Date.now(), opts: { minGapMs: 0 } });
  require('../src/poolPrice').mainLimiter._setDeps({ sleep: async () => {}, opts: { minGapMs: 0 }, http: { get: async () => ({ data: [] }) } });
  const idx = require('../src/index');
  const noRoute = async () => { throw Object.assign(new Error('400'), { response: { status: 400, data: { error: 'COULD_NOT_FIND_ANY_ROUTE' } } }); };
  idx.booksLimiter.setHttp({ get: noRoute, post: noRoute });
  assert.strictEqual(idx.newPoolsEnabled(), false);
  await idx.tick();
  await idx.tick();
  assert.strictEqual(feedCalls, 0, 'no GeckoTerminal new_pools calls');
  assert.strictEqual(np.stats.calls, 0);
  const pv = idx.pauseView();
  assert.deepStrictEqual(pv.activeStrategies, ['runner-hunter']);
  assert.deepStrictEqual(pv.pausedStrategies.slice().sort(), ['aggressive-flow', 'buyer-turn', 'dip-buyers', 'dip-hold', 'graduation-sniper', 'momentum-entry', 'trending-pullback', 'volume-explosion']);
  assert.ok(/off/.test(pv.newPoolsFeed));
  const bv = idx.botsView();
  assert.deepStrictEqual(bv.pause.activeStrategies, ['runner-hunter']);
  assert.ok(bv.strategies.filter(s => s.id !== 'runner-hunter').every(s => s.status === 'PAUSED'), JSON.stringify(bv.strategies.map(s => [s.id, s.status])));
  assert.notStrictEqual(bv.strategies.find(s => s.id === 'runner-hunter').status, 'PAUSED');
  assert.ok(/new_pools off/.test(bv.agents.find(a => a.id === 'scanner').metric.sub));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok  ', name); }
    catch (e) { console.log('FAIL', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e); }
  }
  console.log(`${passed}/${tests.length} pause tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
