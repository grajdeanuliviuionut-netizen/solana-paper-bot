// t85u (Liviu 22 Nov 09:30): truly one strategy + runner-hunter v2 exits + the runner-v2 epoch switch.
// Runs on the LIVE config (no test/_active.js preload). No network: quotes are mocked.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-runner2-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const { generateSignals } = require('../src/buyAgent');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000;
const NOW = Date.parse('2026-11-22T10:00:00Z');
const row = o => Object.assign({ pairAddress: 'PR', mint: 'RUNmint', symbol: 'RUN', name: 'Run', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 50000,
  volumeH1: 20000, volumeM5: 1000, volumeH6: 60000, priceChange: { m5: 2, h1: 5, h6: 10, h24: 20 }, txns: { buys: 100, sells: 80 }, txnsM5: { buys: 20, sells: 10 },
  pairCreatedAt: NOW - 3 * 3600000, dexId: 'pumpswap', fetchedAt: NOW - 5000, ageDays: 5 }, o || {});
// 10000000000 raw = 0.05 SOL at entry; mult = sell-quote value vs entry
const sellAt = mult => (raw, t) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * mult)), priceImpactPct: 0.4, route: 'Pump' });
function harness() {
  let t = NOW; const h = { mult: 1.0, trades: [] };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: '10000000000', priceImpactPct: 0.5, route: 'Pump' }),
    sellQuote: async (mint, raw) => sellAt(h.mult)(BigInt(raw), t)
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'ok', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const holderCheck = { check: async () => ({ pass: true, reason: 'ok', lpLockedPct: 100, top10Pct: 1, maxHolderPct: 1, creatorPct: 0 }) };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, holderCheck, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [] };
  h.adv = ms => { t += ms; };
  h.open = async () => { await h.books.runEntries(h.state, [row()], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'runner-hunter'); };
  h.pass = async (mult, ms) => { h.mult = mult; h.adv(ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  return h;
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-8, (msg || '') + ' ' + a + ' vs ' + b);

test('live config: only runner-hunter may open; runner-hunter v2 exits; v1 kept in previousVersions; epoch runner-v2', () => {
  assert.deepStrictEqual(config.onlyStrategies, ['runner-hunter']);
  assert.strictEqual(config.books.epoch, 'runner-v2');
  assert.strictEqual(config.books.epochCloseout, true);
  const rh = config.books.list.find(b => b.id === 'runner-hunter');
  assert.strictEqual(rh.version, 2);
  assert.deepStrictEqual(rh.entry, { minVolumeToLiquidityH1: 0.10, minLiquidityUsd: 15000, minH1: 0, minM5: 0 }, 'entry unchanged');
  assert.deepStrictEqual(rh.exit, { stopLossPct: 6, partial: { atPct: 8, sellPct: 33.3333 }, trailAfterPartial: true, trailPct: 8, maxHoldMinutes: 240 });
  assert.deepStrictEqual(rh.previousVersions[0].exit, { stopLossPct: 12, partial: { atPct: 10, sellPct: 20 }, trailAfterPartial: true, trailPct: 15, maxHoldMinutes: 240 });
  assert.ok(config.books.exitLoopMs <= 10000 && config.books.maxExitQuoteAgeSec <= 10);
});

test('allow-list: an unpaused other book or legacy strategy still cannot open', async () => {
  const saved = config.books.list.map(b => b.paused), savedL = config.strategies.map(s => s.paused);
  try {
    for (const b of config.books.list) b.paused = false;
    for (const s of config.strategies) s.paused = false;
    const h = harness();
    await h.books.runEntries(h.state, [row(), row({ mint: 'M2pump', pairAddress: 'P2', symbol: 'TWO' })], async () => ({ ok: true }));
    assert.ok(h.state.books.open.length >= 1);
    assert.ok(h.state.books.open.every(p => p.book === 'runner-hunter'), h.state.books.open.map(p => p.book).join(','));
    assert.deepStrictEqual(Object.keys(h.state.books.lastScan.candidatesByBook), ['runner-hunter']);
    assert.strictEqual(h.books.allowed('dip-hold'), false);
    assert.strictEqual(h.books.allowed('runner-hunter'), true);
    // a pending epoch switch blocks every entry
    const h2 = harness(); h2.state.epochSwitch = { pending: true };
    await h2.books.runEntries(h2.state, [row()], async () => ({ ok: true }));
    assert.strictEqual((h2.state.books.open || []).length, 0);
  } finally { config.books.list.forEach((b, i) => { b.paused = saved[i]; }); config.strategies.forEach((s, i) => { s.paused = savedL[i]; }); }
  const dip = row({ liquidityUsd: 100000, priceChange: { m5: 1, h1: -6 }, txns: { buys: 200, sells: 100 } });
  assert.strictEqual(generateSignals([dip]).signals.length, 0);
});

test('v2 partial: nothing at +7.9%; sells 1/3 at +8% with 1.1% on that third only; trail 8% below the highest mark', async () => {
  const h = harness();
  const pos = await h.open();
  assert.ok(pos && pos.strategyVersion === 'runner-hunter v2');
  const bal0 = h.state.balance;
  await h.pass(1.079);
  assert.ok(!pos.partialDone && pos.legs.length === 0, 'no partial below +8%');
  await h.pass(1.0801);
  assert.ok(pos.partialDone, 'partial at +8%');
  assert.strictEqual(pos.legs.length, 1);
  assert.strictEqual(pos.legs[0].sellPctOfOriginal, 33.333);
  const part = 3333330000;            // 1/3 of 10000000000 raw at 1e-6 resolution
  assert.strictEqual(pos.legs[0].tokensRaw, String(part));
  const basis1 = 0.05 * part / 1e10;
  near(pos.legs[0].costSol, basis1 * 0.011, 'cost on the third');
  near(pos.legs[0].pnlSol, Math.floor(part * 5e-3 * 1.0801) / 1e9 - basis1 - basis1 * 0.011, 'leg pnl');
  near(pos.remainingFrac, 1 - part / 1e10);
  await h.pass(1.30);                 // new high
  assert.strictEqual(pos.peakPct, 30);
  await h.pass(1.197);                // 1.197 > 1.30 * 0.92 = 1.196 -> still riding
  assert.strictEqual(h.state.books.open.length, 1, 'riding above the trail');
  await h.pass(1.195);                // <= 1.196 -> trail
  assert.strictEqual(h.state.books.open.length, 0);
  const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'trail');
  const basis2 = 0.05 - basis1;
  const expect = pos.legs[0].pnlSol + (Math.floor((1e10 - part) * 5e-3 * 1.195) / 1e9 - basis2 * 1.011);
  near(tr.pnlSol, expect, 'trade pnl = both legs net of 1.1%');
  near(tr.legs.reduce((a, l) => a + l.costSol, 0), 0.05 * 0.011, 'total cost = 1.1% of the full size');
  near(h.state.balance, bal0 + 0.05 + expect, 'cash = basis + pnl');
});

test('v2 trail is not armed before the partial (a +7% peak then a fall does not trail out)', async () => {
  const h = harness();
  const pos = await h.open();
  await h.pass(1.07); await h.pass(0.96);
  assert.strictEqual(h.state.books.open.length, 1);
  assert.ok(!pos.partialDone);
});

test('v2 stop: -5.9% holds, -6% stops on the sell quote; stop fill logs the level vs the actual fill', async () => {
  const h = harness();
  await h.open();
  await h.pass(0.941);
  assert.strictEqual(h.state.books.open.length, 1);
  await h.pass(0.925);
  const tr = h.trades[0];
  assert.strictEqual(tr.exitReason, 'sl');
  near(tr.pnlPct, -7.5 - 1.1, 'books the quoted fill, not the stop level');
  const sf = h.state.stopFills[0];
  assert.strictEqual(sf.stopLevelPct, -6);
  near(sf.actualFillPct, -7.5);
  near(sf.overshootPct, -1.5);
  assert.ok(sf.lastCheckPnlPct != null && sf.sinceLastCheckSec === 5, JSON.stringify(sf));
  assert.ok('actualFillPrice' in sf || 'fillPrice' in sf || 'actualFillPriceSolPerToken' in sf, Object.keys(sf).join(','));
});

test('v2 max hold: closes at 4 h on the quote', async () => {
  const h = harness();
  await h.open();
  await h.pass(1.02, 239 * MIN);
  assert.strictEqual(h.state.books.open.length, 1);
  await h.pass(1.02, 1 * MIN);
  assert.strictEqual(h.trades[0].exitReason, 'time');
  near(h.trades[0].pnlSol, 0.05 * 0.02 - 0.05 * 0.011);
});

test('epoch switch: leftovers closed at a Jupiter sell quote, then runner-v2 starts at the switch equity; equity change == runner-hunter P&L', async () => {
  const since = '2026-11-21T18:42:46.000Z';
  const now = Date.now();
  const iso = m => new Date(now + m * MIN).toISOString();
  const leg = { reason: 'partial-tp', at: iso(-30), basisSol: 0.01, solOut: 0.0112, costSol: 0.00011, pnlSol: 0.00109, tokensRaw: '2000000000', sellPctOfOriginal: 20 };
  const st = {
    balance: 2.5, activity: [], decisions: [], paperReset: 'work-1', trades: [],
    scoreboard: { epoch: 'books-v1', since, startEquity: 2.7, startBalance: 2.6 },
    openPositions: [{ id: 'LG1', symbol: 'DIPX', strategyId: 'dip-hold', mint: 'DIPmint', sizeSol: 0.075, entryPrice: 0.001, entryTime: iso(-60), tokensRaw: '75000000', decimals: 6 }],
    books: { open: [
      { id: 'BK1', book: 'volume-explosion', bookVersion: 1, strategyId: 'volume-explosion', strategyVersion: 'volume-explosion v1', symbol: 'VOLX', mint: 'VOLmint', sizeSol: 0.05, entryTime: iso(-50), decimals: 6, tokensRaw: '10000000000', tokensRemainingRaw: '10000000000', remainingFrac: 1, costBasisRemainingSol: 0.05, legs: [], exit: { stopLossPct: 8, trailAfterPct: 10, trailPct: 6, maxHoldMinutes: 60 } },
      { id: 'BK2', book: 'runner-hunter', bookVersion: 1, strategyId: 'runner-hunter', strategyVersion: 'runner-hunter v1', symbol: 'RUNV1', mint: 'RV1mint', sizeSol: 0.05, entryTime: iso(-40), decimals: 6, tokensRaw: '10000000000', tokensRemainingRaw: '8000000000', remainingFrac: 0.8, costBasisRemainingSol: 0.04, partialDone: true, peakPct: 12, legs: [leg], exit: config.books.list.find(b => b.id === 'runner-hunter').previousVersions[0].exit }
    ], trades: [] }
  };
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(st));
  const idx = require('../src/index');
  const s = idx.getState();
  assert.strictEqual(s.scoreboard.epoch, 'books-v1', 'board waits for the leftovers');
  assert.ok(s.epochSwitch && s.epochSwitch.pending && s.epochSwitch.to === 'runner-v2');
  assert.deepStrictEqual(idx.leftovers().map(p => p.id).sort(), ['BK1', 'LG1']);
  // quotes: dip-hold -3%, volume-explosion -10%, runner v1 +5% (all fresh); a failed first quote is retried
  let fail = 1;
  idx.quotes.sellQuote = async (mint, raw) => {
    if (mint === 'DIPmint' && fail-- > 0) return { ok: false, error: 'timeout' };
    const m = mint === 'DIPmint' ? 0.97 : mint === 'VOLmint' ? 0.90 : 1.05;
    const per = mint === 'DIPmint' ? 0.075 / 75000000 : 0.05 / 10000000000;
    return { ok: true, at: Date.now(), inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * per * m * 1e9)), priceImpactPct: 0.3, route: 'x' };
  };
  await idx.exitLoopOnce();
  assert.strictEqual(s.epochSwitch.pending, true, 'one leftover quote failed -> still pending');
  assert.strictEqual(s.openPositions.length, 1);
  await idx.exitLoopOnce();
  assert.strictEqual(s.epochSwitch.pending, false);
  assert.strictEqual(s.scoreboard.epoch, 'runner-v2');
  assert.strictEqual(s.openPositions.length, 0);
  assert.deepStrictEqual(s.books.open.map(p => p.id), ['BK2'], 'runner-hunter keeps its open position');
  const closes = s.scoreboard.leftoverCloses;
  assert.strictEqual(closes.length, 2);
  const dip = closes.find(c => c.strategyId === 'dip-hold'), vol = closes.find(c => c.strategyId === 'volume-explosion');
  near(dip.pnlSol, 0.075 * (-0.03 - 0.011), 'dip-hold close');
  near(vol.pnlSol, 0.05 * 0.9 - 0.05 - 0.05 * 0.011, 'volume-explosion close');
  const logged = fs.readFileSync(process.env.TRADES_FILE, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(t => t.exitReason === 'epoch-close');
  assert.deepStrictEqual(logged.map(t => t.strategyId).sort(), ['dip-hold', 'volume-explosion'], 'both written to trades.jsonl');
  assert.strictEqual(s.trades.length, 0, 'legacy list archived at the board start (old epoch)');
  // start equity = equity at the switch (cash + runner basis), recorded explicitly; old board kept in history
  near(s.scoreboard.startEquity, s.balance + 0.04, 'start equity');
  near(s.scoreboard.startBalance, s.balance);
  assert.ok(s.scoreboard.startMarkedEquity != null);
  const hist = s.scoreboardHistory.find(x => x.epoch === 'books-v1');
  assert.ok(hist && hist.until === s.scoreboard.since);
  near(hist.endEquity, s.scoreboard.startEquity);
  assert.ok(fs.existsSync(s.scoreboard.archiveFile));
  const arch = JSON.parse(fs.readFileSync(s.scoreboard.archiveFile, 'utf8'));
  assert.strictEqual(arch.bookTrades.length, 1, 'book trades archived (kept in state too)');
  // the closed board still reconciles; the new board starts at 0 with only runner-hunter
  const old = idx.pnlView('books-v1');
  assert.ok(Math.abs(old.residualSol + (2.7 - 2.6 - 0.075 - 0.05 - 0.04)) < 1, 'old window answers');
  let p = idx.pnlView();
  assert.strictEqual(p.window.epoch, 'runner-v2');
  near(p.equityChangeSol, 0); near(p.residualSol, 0);
  // runner v1 carried position stops out in the new epoch: equity change == runner-hunter P&L
  idx.quotes.sellQuote = async (mint, raw) => ({ ok: true, at: Date.now(), inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-12 * 0.80 * 1e9)), priceImpactPct: 0.3, route: 'x' });
  await idx.exitLoopOnce();
  assert.strictEqual(s.books.open.length, 0);
  p = idx.pnlView();
  near(p.residualSol, 0, 'residual');
  assert.deepStrictEqual(p.byStrategy.map(x => x.strategyId), ['runner-hunter']);
  near(p.byStrategy[0].totalSol, p.equityChangeSol, 'equity change == runner-hunter');
  near(p.equityChangeSol, 0.04 * 0.80 - 0.04 - 0.04 * 0.011, 'only the in-epoch leg counts (the pre-switch partial does not)');
  assert.strictEqual(p.rows[0].carriedTrades, 1);
});

(async () => {
  for (const [n, f] of tests) { try { await f(); passed++; console.log('ok  ' + n); } catch (e) { console.error('FAIL ' + n + '\n  ' + (e.stack || e)); process.exitCode = 1; } }
  console.log(passed + '/' + tests.length + ' runner2 tests passed');
  process.exit(process.exitCode || 0);
})();
