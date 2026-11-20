// Minimal offline unit tests (no network). Run: npm test
const assert = require('assert');
const config = require('../src/config');
const fm = require('../src/fillModel');
const { evaluateReport, cloneCheck } = require('../src/rugGate');
const { evaluate } = require('../src/buyAgent');
const { decide, legPnlSol } = require('../src/sellAgent');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------- fill model ----------
test('entry fill: impact grows with size/liquidity, includes slippage+fee', () => {
  const small = fm.fillEntry({ midPrice: 1, sizeSol: 0.2, solUsd: 150, liquidityUsd: 1e6 });
  const big = fm.fillEntry({ midPrice: 1, sizeSol: 0.2, solUsd: 150, liquidityUsd: 10000 });
  assert.ok(big.impactPct > small.impactPct * 50);
  near(big.impactPct, 30 / 5000 * 100); // $30 into $5k side = 0.6%
  assert.ok(small.price > 1.0055 && small.price < 1.006); // ~0.3% slip + 0.25% fee
});
test('stop-out fill is 2-3x worse than a normal exit plus delay drift', () => {
  const rng = () => 0.99; // no failed exit
  const normal = fm.fillExit({ midPrice: 1, valueUsd: 30, liquidityUsd: 20000, reason: 'time', m5Pct: 10, rng });
  const stop = fm.fillExit({ midPrice: 1, valueUsd: 30, liquidityUsd: 20000, reason: 'sl', m5Pct: 10, rng });
  const nLoss = 1 - normal.price, sLoss = 1 - stop.price;
  assert.ok(stop.stop && !normal.stop);
  assert.ok(stop.driftPct > 0 && normal.driftPct === 0);
  assert.ok(sLoss / nLoss > 2, `ratio ${sLoss / nLoss}`);
  near(stop.slippagePct, config.fills.baseSlippagePct * config.fills.stopSlippageMult);
});
test('failed exit: extra drift + extra failed-tx cost; rate ~7.5%', () => {
  const ok = fm.fillExit({ midPrice: 1, valueUsd: 30, liquidityUsd: 20000, reason: 'tp', m5Pct: 5, rng: () => 0.5 });
  const failed = fm.fillExit({ midPrice: 1, valueUsd: 30, liquidityUsd: 20000, reason: 'tp', m5Pct: 5, rng: () => 0.01 });
  assert.ok(failed.failedFirst && !ok.failedFirst);
  assert.ok(failed.price < ok.price);
  assert.ok(failed.txCostSol > ok.txCostSol);
  let seed = 1; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let n = 0; for (let i = 0; i < 20000; i++) if (fm.fillExit({ midPrice: 1, valueUsd: 1, liquidityUsd: 1e6, reason: 'tp', rng }).failedFirst) n++;
  assert.ok(n / 20000 > 0.05 && n / 20000 < 0.10, `rate ${n / 20000}`);
});
test('tx costs: base+priority+tip per landed tx, no tip on failed', () => {
  const f = config.fills;
  near(fm.txCostSol(1, 0), f.baseFeeSol + f.priorityFeeSol + f.jitoTipSol);
  near(fm.txCostSol(1, 1), 2 * (f.baseFeeSol + f.priorityFeeSol) + f.jitoTipSol);
});
test('round trip on a $1M pool costs > 1.1%-ish and on $10k pool costs much more', () => {
  const rng = () => 0.99;
  const rt = liq => {
    const e = fm.fillEntry({ midPrice: 1, sizeSol: 0.2, solUsd: 150, liquidityUsd: liq });
    const x = fm.fillExit({ midPrice: 1, valueUsd: 30, liquidityUsd: liq, reason: 'time', rng });
    return (1 - x.price / e.price) * 100;
  };
  assert.ok(rt(1e6) > 1.0 && rt(1e6) < 1.3, `deep ${rt(1e6)}`);
  assert.ok(rt(10000) > 2, `shallow ${rt(10000)}`);
});

// ---------- rug gate ----------
const POOL = 'POOL1111';
const goodReport = () => ({
  mintAuthority: null, freezeAuthority: null, rugged: false, score_normalised: 1,
  token: { decimals: 6 }, tokenMeta: { name: 'Good' }, totalMarketLiquidity: 100000,
  markets: [{ pubkey: POOL, lp: { lpLockedPct: 100 }, liquidityAAccount: { owner: POOL }, liquidityBAccount: { owner: POOL } }],
  topHolders: [{ address: 'A', owner: POOL, pct: 40 }, ...Array.from({ length: 12 }, (_, i) => ({ address: 'H' + i, owner: 'O' + i, pct: 2 }))],
  knownAccounts: {}, risks: [], graphInsidersDetected: 0, token_extensions: {}
});
test('rug gate passes a clean report (pool holder excluded)', () => {
  const r = evaluateReport(goodReport(), { pairAddress: POOL });
  assert.deepStrictEqual(r.reasons, []);
  near(r.facts.top10ExPoolPct, 20);
});
test('rug gate rejects mint/freeze authority, unlocked LP, missing LP, whales, concentration', () => {
  let rep = goodReport(); rep.mintAuthority = 'X'; rep.freezeAuthority = 'Y';
  let r = evaluateReport(rep, { pairAddress: POOL });
  assert.ok(r.reasons.includes('mint-authority') && r.reasons.includes('freeze-authority'));
  rep = goodReport(); rep.markets[0].lp.lpLockedPct = 10;
  assert.ok(evaluateReport(rep, { pairAddress: POOL }).reasons.some(x => x.startsWith('lp-locked')));
  assert.ok(evaluateReport(goodReport(), { pairAddress: 'OTHER' }).reasons.includes('lp-data-missing'));
  rep = goodReport(); rep.topHolders.push({ address: 'W', owner: 'W', pct: 6 }); rep.topHolders.sort((a, b) => b.pct - a.pct);
  assert.ok(evaluateReport(rep, { pairAddress: POOL }).reasons.some(x => x.startsWith('holder ')));
  rep = goodReport(); rep.topHolders = [{ address: 'A', owner: POOL, pct: 40 }, ...Array.from({ length: 10 }, (_, i) => ({ address: 'H' + i, owner: 'O' + i, pct: 4.9 }))];
  assert.ok(evaluateReport(rep, { pairAddress: POOL }).reasons.some(x => x.startsWith('top10')));
  assert.deepStrictEqual(evaluateReport(null).reasons, ['no-report']);
});
test('rug gate NCS extras: danger risk, insiders, token-2022 ext, liquidity disagreement', () => {
  const extra = config.strategies.find(s => s.type === 'ncs').extraRug;
  const rep = goodReport();
  rep.risks = [{ name: 'x', level: 'danger' }]; rep.graphInsidersDetected = 99;
  rep.token_extensions = { transferHook: { programId: 'P' } }; rep.totalMarketLiquidity = 1000;
  const r = evaluateReport(rep, { pairAddress: POOL, dexLiquidityUsd: 50000, extra });
  for (const k of ['rugcheck-danger', 'ext-transferHook', 'liq-source-disagree']) assert.ok(r.reasons.includes(k), k);
  assert.ok(r.reasons.some(x => x.startsWith('insiders')));
});
test('clone check by mint', () => {
  assert.ok(cloneCheck({ mint: 'fake', symbol: 'WIF' }, []).clone);
  assert.ok(!cloneCheck({ mint: config.majorTokens.wif, symbol: '$WIF' }, []).clone);
  assert.ok(cloneCheck({ mint: 'fake', symbol: 'PNUT' }, [{ mint: 'real', symbol: 'Pnut', name: 'Peanut' }]).clone);
  assert.ok(!cloneCheck({ mint: 'new', symbol: 'ZZZ' }, [{ mint: 'real', symbol: 'Pnut' }]).clone);
  assert.ok(!cloneCheck({ mint: 'real', symbol: 'Pnut' }, [{ mint: 'real', symbol: 'Pnut' }]).clone);
});

// ---------- entry gates ----------
const ncs = config.strategies.find(s => s.type === 'ncs');
const basePair = () => ({
  mint: 'M1', pairAddress: 'P1', symbol: 'T', dexId: 'pumpswap', priceUsd: 0.001, liquidityUsd: 20000, mcapUsd: 1e5,
  volumeH1: 40000, volumeM5: 6000, priceChange: { m5: 8, h1: 50, h6: 0, h24: 0 },
  txns: { buys: 300, sells: 200 }, txnsM5: { buys: 30, sells: 10 }, pairAgeMin: 30, ageDays: 0.02,
  liqChangeVsPrevPct: 0
});
test('NCS: passing pair gets tier A; tier B down to $8k when young', () => {
  assert.deepStrictEqual(evaluate(basePair(), ncs).fails, []);
  assert.strictEqual(evaluate(basePair(), ncs).tier, 'A');
  const b = basePair(); b.liquidityUsd = 9000; b.volumeM5 = 3500; b.volumeH1 = 20000;
  const r = evaluate(b, ncs); assert.deepStrictEqual(r.fails, []); assert.strictEqual(r.tier, 'B'); assert.strictEqual(r.sizeMult, 0.5);
  b.pairAgeMin = 90; assert.ok(evaluate(b, ncs).fails.includes('tierLiquidity'));
});
test('NCS: each gate rejects', () => {
  const cases = [
    ['bondingCurve', p => { p.dexId = 'pumpfun'; }], ['pairAge', p => { p.pairAgeMin = 2; }],
    ['m5Range', p => { p.priceChange.m5 = 1; }], ['m5BuysGtSells', p => { p.txnsM5 = { buys: 10, sells: 12 }; }],
    ['volumeM5', p => { p.volumeM5 = 100; }], ['h1Max', p => { p.priceChange.h1 = 400; }],
    ['liqDropVsPrev', p => { p.liqChangeVsPrevPct = -15; }], ['washH1', p => { p.volumeH1 = 20000 * 13; }],
    ['washM5', p => { p.volumeM5 = 20000 * 4; }], ['honeypotSells', p => { p.txnsM5 = { buys: 30, sells: 2 }; }]
  ];
  for (const [gate, mut] of cases) { const p = basePair(); mut(p); assert.ok(evaluate(p, ncs).fails.includes(gate), gate); }
});
test('legacy strategies keep $50k floor and exclude JUP/Bonk by mint', () => {
  const af = config.strategies.find(s => s.id === 'aggressive-flow');
  const p = basePair(); p.liquidityUsd = 40000;
  assert.ok(evaluate(p, af).fails.includes('minLiquidity'));
  p.mint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  assert.deepStrictEqual(evaluate(p, af).fails, ['excludedMint']);
});

// ---------- exits ----------
const now = Date.now();
const ncsPos = (over = {}) => ({ strategyType: 'ncs', exit: ncs.exit, entryPrice: 1, entryFillPrice: 1.01, sizeSol: 0.1, entryTime: new Date(now).toISOString(), highest: 1, remainingFrac: 1, entryLiquidityUsd: 20000, ...over });
test('NCS exits: tp1 partial 50%, tp2, sl, breakeven + trail after tp1, time stops, emergency', () => {
  let d = decide(ncsPos(), 1.26, true, null, now); assert.strictEqual(d.action, 'partial'); near(d.sellFrac, 0.5);
  d = decide(ncsPos({ tp1Done: true, remainingFrac: 0.5, highest: 1.6 }), 1.61, true, null, now); assert.strictEqual(d.reason, 'tp2'); near(d.sellFrac, 0.5);
  assert.strictEqual(decide(ncsPos(), 0.87, true, null, now).reason, 'sl');
  assert.strictEqual(decide(ncsPos({ tp1Done: true, remainingFrac: 0.5, highest: 1.3 }), 0.99, true, null, now).reason, 'breakeven');
  assert.strictEqual(decide(ncsPos({ tp1Done: true, remainingFrac: 0.5, highest: 1.5 }), 1.25, true, null, now).reason, 'trail');
  assert.strictEqual(decide(ncsPos(), 1.03, true, null, now + 16 * 60000).reason, 'time-flat');
  assert.strictEqual(decide(ncsPos(), 1.10, true, null, now + 16 * 60000), null);
  assert.strictEqual(decide(ncsPos(), 1.10, true, null, now + 31 * 60000).reason, 'time');
  assert.strictEqual(decide(ncsPos(), 2.0, false, null, now), null); // stale price never triggers TP
  assert.strictEqual(decide(ncsPos(), 1, true, { liquidityUsd: 13000, txnsM5: { buys: 5, sells: 5 } }, now).reason, 'emergency-liq');
  assert.strictEqual(decide(ncsPos(), 1, true, { liquidityUsd: 20000, txnsM5: { buys: 12, sells: 0 } }, now).reason, 'emergency-nosells');
});
test('leg pnl uses modelled entry fill', () => {
  near(legPnlSol({ sizeSol: 0.2, entryFillPrice: 1.01 }, 1.01 * 1.1, 0.5), 0.2 * 0.5 * 0.1);
});

// ---------- config hash ----------
test('config hash changes when a strategy changes (resets the 50-trade count)', () => {
  const s = JSON.parse(JSON.stringify(ncs));
  const h1 = config.configHashFor(s);
  s.exit.stopLossPct = 11;
  assert.notStrictEqual(h1, config.configHashFor(s));
  assert.strictEqual(config.configHashFor(ncs), config.strategyHashes[ncs.id]);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);
