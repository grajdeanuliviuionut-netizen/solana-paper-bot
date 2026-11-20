// Minimal offline unit tests (no network). Run: npm test
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
// Keep test state/near-miss/skip files out of ./data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-test-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
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

// Real RugCheck market payloads (fetched 2026-11-20 16:2x London, trimmed to the lp fields).
// RIEMANN 2H3CV59d...: pool created directly on PumpSwap by the token creator; RugCheck's lp.holders
// shows the creator wallet holds 99.99999999942% of the LP -> genuinely unlocked (not burned).
// LOOSY HF2RBP...pump: a pump.fun graduate whose PumpSwap LP is burned -> RugCheck already reports 100%.
const RIEMANN_MARKET = { pubkey: '6oWKYwo5LC7Uv76ivyMXF5nuTghSZpkwYGb4rZqsnDT2', marketType: 'pump_fun_amm',
  lp: { lpMint: 'BZb5AHAGf4tWCt4cai7uwkkudtvQCvxAY2PzJqVXx45W', lpLocked: 101, lpUnlocked: 17320508075588, lpTotalSupply: 17320508075689,
    lpLockedPct: 5.831237718815143e-10, lpLockedUSD: 5.940702743029853e-7,
    holders: [{ address: '93vBQ4ofQ5TNvyXgtWEZ65Rk3W1gGA3Teg4ALmgFaBGs', amount: 17320508075588, pct: 99.99999999941687, owner: 'ALrmWwdQ79Mrg2jYoKwFjsWBmZiuLFjVP6oTyzQAVXRh', insider: false }] } };
const LOOSY_MARKET = { pubkey: 'Bfiq9eLOOSYPOOL', marketType: 'pump_fun_amm',
  lp: { lpLocked: 4193388282605, lpUnlocked: 0, lpTotalSupply: 4193388282605, lpLockedPct: 100 } };
test('rug gate LP: burned pump.fun LP (real LOOSY payload) passes; creator-held PumpSwap LP (real RIEMANN payload) still rejects', () => {
  // Pool pubkey mapped to the fixture POOL so the pool-holder exclusion matches; lp fields are verbatim.
  let rep = goodReport(); Object.assign(rep.markets[0], { marketType: LOOSY_MARKET.marketType, lp: LOOSY_MARKET.lp });
  assert.deepStrictEqual(evaluateReport(rep, { pairAddress: POOL }).reasons, []);
  rep = goodReport(); rep.creator = 'ALrmWwdQ79Mrg2jYoKwFjsWBmZiuLFjVP6oTyzQAVXRh'; Object.assign(rep.markets[0], { marketType: RIEMANN_MARKET.marketType, lp: RIEMANN_MARKET.lp });
  assert.deepStrictEqual(evaluateReport(rep, { pairAddress: POOL }).reasons, ['lp-locked 0%<90']);
  assert.strictEqual(RIEMANN_MARKET.lp.holders[0].owner, rep.creator); // the LP sits in the creator wallet
});

test('clone check: one retry after a short backoff, then fail closed', async () => {
  const rg = require('../src/rugGate');
  let calls = 0;
  const flaky = failN => ({ get: async () => { calls++; if (calls <= failN) { const e = new Error('socket hang up'); throw e; } return { data: [{ id: 'real', symbol: 'ZQX', name: 'Zqx', isVerified: true }] }; } });
  rg.clearCaches(); calls = 0; rg.setHttp(flaky(1));
  let v = await rg.verifiedTokensFor('ZQX', { retryMs: 5 });
  assert.ok(v.ok); assert.strictEqual(calls, 2); assert.strictEqual(v.attempts, 2);
  rg.clearCaches(); calls = 0; rg.setHttp(flaky(5));
  v = await rg.verifiedTokensFor('ZQY', { retryMs: 5 });
  assert.ok(!v.ok); assert.strictEqual(calls, 2); // exactly one retry, then fail closed
  rg.clearCaches(); calls = 0; rg.setHttp(flaky(0));
  v = await rg.verifiedTokensFor('ZQZ', { retryMs: 5 });
  assert.ok(v.ok); assert.strictEqual(calls, 1);
  rg.setHttp(require('axios')); rg.clearCaches();
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
const ncsPos = (over = {}) => ({ strategyType: 'ncs', exit: ncs.exit, entryPrice: 1, entryFillPrice: 1.01, sizeSol: 0.1, entryTime: new Date(now - 61000).toISOString(), // past the 60s grace (batch2)
  highest: 1, remainingFrac: 1, entryLiquidityUsd: 20000, ...over });
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

// ---------- tokenized-equity denylist ----------
const denylist = require('../src/denylist');
const { generateSignals } = require('../src/buyAgent');
const TTWO = 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo';
test('denylist: TTWO mint, Backpack/xStocks names, xStocks-style mints; memecoins pass', () => {
  assert.ok(denylist.staticCheck({ mint: TTWO, symbol: 'TTWO', name: 'Take-Two' }));
  assert.ok(denylist.staticCheck({ mint: 'AnyMint1111', symbol: 'NVDA', name: 'Nvidia - Backpack Securities' }));
  assert.ok(denylist.staticCheck({ mint: 'AnyMint2222', symbol: 'TSLAx', name: 'Tesla xStock' }));
  assert.ok(denylist.staticCheck({ mint: 'XsNewUnlistedMint1111111111111111111111111', symbol: 'ABCx', name: 'ABC' }));
  assert.strictEqual(denylist.staticCheck({ mint: 'F8DXZJPgZPrMVkSjXn24jzcFS7fZ9QaFUGVwHDsupump', symbol: 'Gino', name: 'Gino' }), null);
  assert.strictEqual(denylist.staticCheck({ mint: 'Bxx1pump', symbol: 'catx', name: 'cat x' }), null); // lowercase ticker + no issuer
  assert.strictEqual(denylist.staticCheck({ mint: 'Bxx2pump', symbol: 'FIONA', name: 'Fiona the Hippo' }), null);
});
test('denylist: Jupiter tags / issuer accounts', () => {
  assert.ok(/jupiter-tag/.test(denylist.jupiterCheck({ id: 'm1', symbol: 'AAA', name: 'AAA', tags: ['verified', 'stocks', 'rwa'] })));
  assert.ok(/issuer/.test(denylist.jupiterCheck({ id: 'm2', symbol: 'AAA', name: 'AAA', tags: ['unknown'], dev: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS' })));
  assert.strictEqual(denylist.jupiterCheck({ id: 'm3', symbol: 'MEME', name: 'Meme', tags: ['unknown', 'token-2022'], dev: 'x' }), null);
  assert.strictEqual(denylist.jupiterCheck(null), null);
});
test('denylist: buyAgent rejects tokenized equity as its own reason, counts it, no near-miss, no signal', () => {
  const p = Object.assign(basePair(), { mint: TTWO, symbol: 'TTWO', name: 'Take-Two Interactive Software - Backpack Securities' });
  assert.deepStrictEqual(evaluate(basePair(), ncs).fails, []); // same pair, ordinary mint: passes
  for (const s of config.strategies) assert.deepStrictEqual(evaluate(p, s).fails, ['tokenized-equity']);
  const counts = {}, near = [], skips = [];
  const { signals, gateStats } = generateSignals([p], {
    count: (sid, g) => { counts[g] = (counts[g] || 0) + 1; },
    nearMiss: r => near.push(r), skip: r => skips.push(r)
  });
  assert.strictEqual(signals.length, 0);
  assert.strictEqual(near.length, 0);
  assert.strictEqual(counts['tokenized-equity'], config.strategies.length);
  for (const st of Object.values(gateStats)) assert.strictEqual(st.fails['tokenized-equity'], 1);
  assert.ok(skips.every(k => k.reason === 'tokenized-equity' && k.mint === TTWO));
});
test('denylist is a universe filter: not in any strategy config hash', () => {
  const ncsStrat = config.strategies.find(x => x.type === 'ncs');
  assert.ok(!JSON.stringify(ncsStrat).includes('TTWofw'));
  for (const st of config.strategies) assert.ok(!JSON.stringify(st).includes('TTWofw'), st.id);
});

// ---------- slot-full skips ----------
const { slotStatus, formatSkips } = require('../src/slots');
const rej = require('../src/rejections');
test('slot-full skip: strategy cap, global cap, balance stop; logged to rejections + scan line', () => {
  const strat = { id: 'momentum-entry', maxOpen: 2 };
  const cfg = { maxOpen: 3, fullStopBalance: 2.5 };
  const pos = id => ({ strategyId: id });
  assert.strictEqual(slotStatus({ balance: 4, openPositions: [pos('momentum-entry')] }, strat, cfg), null);
  const s1 = slotStatus({ balance: 4, openPositions: [pos('momentum-entry'), pos('momentum-entry')] }, strat, cfg);
  assert.deepStrictEqual(s1, { reason: 'slot-full skip', scope: 'strategy', open: 2, max: 2 });
  const s2 = slotStatus({ balance: 4, openPositions: [pos('a'), pos('b'), pos('c')] }, strat, cfg);
  assert.strictEqual(s2.reason, 'slot-full skip'); assert.strictEqual(s2.scope, 'global');
  assert.strictEqual(slotStatus({ balance: 1, openPositions: [] }, strat, cfg).reason, 'balance-stop');
  const rec = { strategyId: strat.id, ...s1, mint: 'MintSlot1111', symbol: 'SLOT' };
  rej.skip(rec); rej.skip(rec); // counted twice, listed once (10 min dedupe)
  const snap = rej.snapshot();
  assert.strictEqual(snap.hourly[snap.currentHour][strat.id]['slot-full skip'], 2);
  assert.strictEqual(rej.skips.filter(k => k.mint === 'MintSlot1111').length, 1);
  const line = formatSkips([rec, rec, { strategyId: 'aggressive-flow', reason: 'tokenized-equity', mint: TTWO, symbol: 'TTWO' }]);
  assert.strictEqual(line, `slot-full skip: momentum-entry:MintSlot1111(SLOT) | tokenized-equity: aggressive-flow:${TTWO}(TTWO)`);
});

// ---------- fill gap + state persistence ----------
test('fill gap: positive = Jupiter worse than model, on both sides', () => {
  near(fm.fillGapPct('buy', 1.1, 1.0), 10);
  near(fm.fillGapPct('buy', 0.9, 1.0), -10);
  near(fm.fillGapPct('sell', 0.9, 1.0), 10);
  assert.strictEqual(fm.fillGapPct('sell', null, 1), null);
});
test('state (balance + open positions) carries over a buildId change', () => {
  const { loadState, saveState } = require('../src/logger');
  const st = loadState(4, 'build-old');
  st.balance = 3.1234; st.openPositions = [{ id: 'p1', mint: 'M', strategyId: 'momentum-entry' }];
  saveState(st);
  const st2 = loadState(4, 'build-new');
  assert.strictEqual(st2.balance, 3.1234);
  assert.strictEqual(st2.openPositions.length, 1);
  assert.strictEqual(st2.build, 'build-new');
  assert.strictEqual(st2.startedAt, st.startedAt);
  assert.strictEqual(st2.buildHistory[st2.buildHistory.length - 1].from, 'build-old');
});


// ---------- quote sanity (RUDY 2026-11-20 11:29) ----------
const jup = require('../src/jupiterQuote');
const qs = require('../src/quoteSanity');
const SOL = jup.SOL_MINT;
const RUDY = 'HmBGdetVsQTRHh2wCa4HykUpKA7NJ1B8S16tUpYiWeaZ';
const RUDY_MODEL = 4.502170211721098e-05;
const SOL_USD = 71.95;
// Fake Jupiter: routes keyed by `${inputMint}>${outputMint}` -> fn(amount) => quote body | Error
function fakeJup(routes) {
  return { get: async (url, { params }) => {
    const fn = routes[`${params.inputMint}>${params.outputMint}`];
    if (!fn) { const e = new Error('Request failed'); e.response = { status: 400, data: { error: 'No routes found', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' } }; throw e; }
    return { data: fn(params.amount, params) };
  } };
}
const body = (inM, outM, inAmt, outAmt, impactFrac, label = 'Pump.fun Amm') => ({
  inputMint: inM, outputMint: outM, inAmount: String(inAmt), outAmount: String(outAmt), swapMode: 'ExactIn',
  priceImpactPct: String(impactFrac), routePlan: [{ swapInfo: { label, inputMint: inM, outputMint: outM } }]
});
// Healthy pool for RUDY at the model price: 0.2 SOL ($14.39) -> ~319,600 RUDY.
const goodTokensRaw = Math.round((0.2 * SOL_USD) / (RUDY_MODEL * 1.01) * 1e6);
async function entryCheck(routes, opts = {}) {
  jup.setHttp(fakeJup(routes));
  const buy = await jup.shadowBuyQuote({ mint: RUDY, decimals: 6, sizeSol: 0.2, solUsd: SOL_USD });
  const reverse = buy.ok ? await jup.sellRawQuote({ mint: RUDY, raw: buy.rawOut, decimals: 6, solUsd: SOL_USD }) : null;
  return { buy, reverse, res: qs.checkEntry({ buy, reverse, modelPrice: RUDY_MODEL, decimals: 6, jupDecimals: opts.jupDecimals, sizeSol: opts.sizeSol }, opts.cfg) };
}
const goodRoutes = () => ({
  [`${SOL}>${RUDY}`]: amt => body(SOL, RUDY, amt, goodTokensRaw, 0.004),
  [`${RUDY}>${SOL}`]: amt => body(RUDY, SOL, amt, 197000000, 0.006)
});
test('units: SOL/token raw amounts are exact integers (toRaw/fromRaw)', () => {
  assert.strictEqual(jup.toRaw(0.2, 9), '200000000');
  assert.strictEqual(jup.toRaw(41360.40055464931, 6), '41360400555');
  assert.strictEqual(jup.fromRaw('4016', 6), 0.004016);
  assert.throws(() => jup.toRaw(1, undefined));
});
test('RUDY repro: 0.2 SOL -> 4016 raw (0.004016 RUDY), impact 99.99999% => $3,58x/token; rejected', async () => {
  const { buy, res } = await entryCheck({
    [`${SOL}>${RUDY}`]: amt => body(SOL, RUDY, amt, 4016, 0.9999999873523959)
    // drained pool: no reverse route
  });
  assert.ok(buy.ok); // the quote itself is internally consistent (mints/amounts/decimals all correct)
  assert.ok(buy.quotedPriceUsd > 3500 && buy.quotedPriceUsd < 3700, String(buy.quotedPriceUsd));
  assert.ok(buy.priceImpactPct > 99.9999);
  assert.strictEqual(res.pass, false);
  assert.ok(res.reasons.some(r => r.startsWith('impact')));
  assert.ok(res.reasons.some(r => r.startsWith('gap')));
  assert.ok(res.reasons.includes('reverse-no-route'));
});
test('quoteSanity passes a healthy quote (worse-of may then use it)', async () => {
  const { res } = await entryCheck(goodRoutes());
  assert.ok(res.pass, res.reasons.join(';'));
  assert.ok(Math.abs(res.gapPct) < 2);
});
test('quoteSanity rule: priceImpact > MAX_PRICE_IMPACT_PCT (5) rejects on its own', async () => {
  const r = goodRoutes(); r[`${SOL}>${RUDY}`] = amt => body(SOL, RUDY, amt, goodTokensRaw, 0.06);
  const { res } = await entryCheck(r);
  assert.deepStrictEqual(res.reasons, ['impact 6.00%>5%']);
});
test('quoteSanity rule: |quote vs model| > MAX_QUOTE_GAP_PCT (15) rejects on its own', async () => {
  const r = goodRoutes(); r[`${SOL}>${RUDY}`] = amt => body(SOL, RUDY, amt, Math.round(goodTokensRaw / 1.25), 0.01);
  const { res } = await entryCheck(r);
  assert.strictEqual(res.reasons.length, 1); assert.ok(res.reasons[0].startsWith('gap 2'), res.reasons[0]);
  const r2 = goodRoutes(); r2[`${SOL}>${RUDY}`] = amt => body(SOL, RUDY, amt, Math.round(goodTokensRaw * 1.3), 0.01); // too GOOD is also suspect
  assert.ok((await entryCheck(r2)).res.reasons[0].startsWith('gap -'));
});
test('quoteSanity rule: reverse quote (token -> SOL at expected size) with no route rejects on its own', async () => {
  const r = goodRoutes(); delete r[`${RUDY}>${SOL}`];
  const { res, reverse } = await entryCheck(r);
  assert.ok(reverse.noRoute);
  assert.deepStrictEqual(res.reasons, ['reverse-no-route']);
});
test('quoteSanity: reverse quote sells exactly the forward outAmount', async () => {
  let soldAmt = null;
  const r = goodRoutes(); r[`${RUDY}>${SOL}`] = amt => { soldAmt = amt; return body(RUDY, SOL, amt, 197000000, 0.006); };
  await entryCheck(r);
  assert.strictEqual(soldAmt, String(goodTokensRaw));
});
test('quote validation: wrong output mint / changed inAmount / decimals mismatch are rejected', async () => {
  const r = goodRoutes(); r[`${SOL}>${RUDY}`] = amt => body(SOL, 'SomeOtherMint111', amt, goodTokensRaw, 0.004);
  const a = await entryCheck(r);
  assert.ok(!a.buy.ok && a.buy.mismatch); assert.ok(a.res.reasons[0].startsWith('quote-mismatch'));
  const r2 = goodRoutes(); r2[`${SOL}>${RUDY}`] = amt => body(SOL, RUDY, '100000000', goodTokensRaw, 0.004);
  assert.ok((await entryCheck(r2)).buy.mismatch);
  const c = await entryCheck(goodRoutes(), { jupDecimals: 9 });
  assert.ok(c.res.reasons[0].startsWith('decimals-mismatch'));
});
test('exit: insane sell quote falls back to model; sane one is usable', () => {
  const insane = qs.checkExit({ sell: { ok: true, priceImpactPct: 99.9 }, quotedAdj: 1e-9, modelPrice: 1e-4 });
  assert.ok(insane.insane && !insane.usable);
  const sane = qs.checkExit({ sell: { ok: true, priceImpactPct: 1.4 }, quotedAdj: 0.91e-4, modelPrice: 1e-4 });
  assert.ok(sane.usable && !sane.insane);
});

// ---------- aggressive-flow paused (shadow) + slot priorities ----------
const shadow = require('../src/shadow');
test('no strategy is paused/shadowed; aggressive-flow trades at half size (0.1) behind 3% gap cap (batch1) + 3% round trip', () => {
  // Every LIVE strategy trades; the only shadow is the PR5.1 research variant momentum-h1ratio.
  for (const st of config.strategies.filter(x => x.id !== 'momentum-h1ratio')) assert.ok(!shadow.isDisabled(st) && !shadow.isShadow(st), st.id);
  assert.ok(shadow.isShadow(config.strategies.find(x => x.id === 'momentum-h1ratio')));
  const af = config.strategies.find(s => s.id === 'aggressive-flow');
  assert.strictEqual(af.sizeSol, 0.02); // PR5 (batch2 0.05)
  const cfg = config.quoteSanityFor(af);
  assert.strictEqual(cfg.maxQuoteGapPct, 3); assert.strictEqual(cfg.maxRoundTripLossPct, 3);
  const p = Object.assign(basePair(), { liquidityUsd: 200000, volumeH1: 200000, txnsM5: { buys: 30, sells: 20 }, priceChange: { m5: 1, h1: 3, h6: 0, h24: 0 } });
  const split = shadow.splitSignals(generateSignals([p]).signals);
  assert.ok(split.real.some(sg => sg.strategyId === 'aggressive-flow')); assert.ok(split.shadow.every(sg => sg.strategyId === 'momentum-h1ratio'));
});
test('shadow code path (kept for future use): a shadowed strategy opens no real entries, tracks shadow ones without touching balance', () => {
  const saved = config.strategyOps['aggressive-flow'];
  config.strategyOps['aggressive-flow'] = { enabled: false, shadow: true, priority: 9 };
  try {
  const af = config.strategies.find(s => s.id === 'aggressive-flow');
  const mom = config.strategies.find(s => s.id === 'momentum-entry');
  assert.ok(shadow.isDisabled(af) && shadow.isShadow(af));
  assert.ok(!shadow.isDisabled(mom));
  const p = Object.assign(basePair(), { liquidityUsd: 200000, volumeH1: 200000, txnsM5: { buys: 30, sells: 20 }, priceChange: { m5: 1, h1: 3, h6: 0, h24: 0 } });
  const { signals } = generateSignals([p]);
  assert.ok(signals.some(sg => sg.strategyId === 'aggressive-flow'), 'aggressive-flow still scans');
  const split = shadow.splitSignals(signals);
  assert.ok(split.real.every(sg => sg.strategyId !== 'aggressive-flow'));
  assert.ok(split.shadow.some(sg => sg.strategyId === 'aggressive-flow') && split.shadow.every(sg => ['aggressive-flow', 'momentum-h1ratio'].includes(sg.strategyId)));
  const st = { balance: 3, openPositions: [] };
  const sig = split.shadow.find(sg => sg.strategyId === 'aggressive-flow');
  assert.ok(shadow.canOpen(st, af, sig.mint));
  const q = { mint: sig.mint, priceUsd: 0.001, liquidityUsd: 200000, priceChange: { m5: 1 } };
  const modelFill = fm.fillEntry({ midPrice: 0.001, sizeSol: 0.2, solUsd: 150, liquidityUsd: 200000 });
  const pos = shadow.open(st, { strat: af, sig, q, modelFill, entryFill: modelFill.price, entryFillSource: 'depth', sizeSol: 0.2, decimals: 6, quote: { quotedPriceUsd: 0.00101, priceImpactPct: 0.3 } });
  assert.ok(!shadow.canOpen(st, af, sig.mint)); // one shadow position per mint
  assert.strictEqual(st.balance, 3); assert.strictEqual(st.openPositions.length, 0);
  // Hypothetical TP exit (+7% > tp 6%)
  const closed = shadow.processExits(st, { [sig.pairAddress]: { ...q, priceUsd: 0.00107 } }, 150, Date.now() + 60000, () => 0.99);
  assert.strictEqual(closed.length, 1); assert.strictEqual(closed[0].exitReason, 'tp'); assert.ok(closed[0].pnlSol > 0);
  assert.strictEqual(st.balance, 3); assert.strictEqual(st.shadow.open.length, 0);
  assert.ok(!shadow.canOpen(st, af, sig.mint)); // cooldown after exit
  assert.strictEqual(shadow.summary(st)['aggressive-flow'].trades, 1);
  assert.ok(pos.id.startsWith('sh-'));
  } finally { config.strategyOps['aggressive-flow'] = saved; }
});
test('free slots: momentum-entry up to 8; NCS capped at 2 by the allocator (spec max 5 kept in the hash), tier A served first', () => {
  const { orderCandidates } = require('../src/slots');
  const mom = config.strategies.find(s => s.id === 'momentum-entry');
  const pos = (id, tier) => ({ strategyId: id, tier, sizeSol: 0.05 });
  const seven = Array.from({ length: 7 }, () => pos('momentum-entry'));
  assert.strictEqual(slotStatus({ balance: 4, openPositions: seven }, mom, config), null);
  // batch2: momentum's allocator cap is 12 (bounded by the global cap), not 8.
  assert.strictEqual(slotStatus({ balance: 4, openPositions: seven.concat([pos('momentum-entry')]) }, mom, config), null);
  assert.strictEqual(slotStatus({ balance: 4, openPositions: Array.from({ length: 12 }, () => pos('momentum-entry')) }, mom, config).scope, 'global');
  const twoA = Array.from({ length: 2 }, () => pos(ncs.id, 'A'));
  assert.strictEqual(slotStatus({ balance: 4, openPositions: twoA }, ncs, config, 'A').max, 2);
  assert.strictEqual(ncs.maxOpen, 5);
  const twelve = Array.from({ length: 12 }, () => pos('x'));
  assert.strictEqual(slotStatus({ balance: 4, openPositions: twelve }, mom, config).scope, 'global');
  const order = orderCandidates([
    { strategyId: ncs.id, tier: 'B', mint: 'b' }, { strategyId: 'momentum-entry', mint: 'm' }, { strategyId: ncs.id, tier: 'A', mint: 'a' }
  ], config).map(c => c.mint);
  assert.strictEqual(order[2], 'b');
  assert.strictEqual(mom.sizeSol, 0.2); // sizes unchanged
});
test('full stop uses equity: 2.33 cash + 6 x 0.2 open is not stopped; real drawdown is', () => {
  const { equityOf } = require('../src/slots');
  const mom = config.strategies.find(s => s.id === 'momentum-entry');
  const six = Array.from({ length: 6 }, () => ({ strategyId: 'momentum-entry', sizeSol: 0.2, remainingFrac: 1 }));
  near(equityOf({ balance: 2.3269, openPositions: six }), 3.5269);
  assert.strictEqual(slotStatus({ balance: 2.3269, openPositions: six }, mom, config), null);
  // Full stop 1.5 SOL equity (2026-11-20 13:08): 1.2 cash + 1.2 open = 2.4 equity still trades; 0.25 + 1.2 = 1.45 stops.
  assert.strictEqual(config.fullStopBalance, 1.5);
  assert.strictEqual(slotStatus({ balance: 1.2, openPositions: six }, mom, config), null);
  assert.strictEqual(slotStatus({ balance: 0.25, openPositions: six }, mom, config).reason, 'balance-stop');
  assert.strictEqual(slotStatus({ balance: 0.1, openPositions: Array.from({ length: 9 }, () => ({ strategyId: 'x', sizeSol: 0.3 })) }, mom, config).scope, 'cash');
});
test('config hashes: all three changed (sell-quote exits + per-strategy gap caps; aggressive-flow also half size)', () => {
  assert.deepStrictEqual(config.strategyHashes, {
    'aggressive-flow': 'b7f4cc472695', 'momentum-entry': 'c1ab00a8e531', ncs_fresh_momentum_v1: 'bf331c3a05d5', 'momentum-h1ratio': 'cfc41521e67d'
  });
});

// ---------- NCS spec audit ----------
test('NCS spec: no previous liquidity poll cannot pass (Gino entered on scan #1 after a restart)', () => {
  const p = basePair(); p.liqChangeVsPrevPct = null;
  assert.deepStrictEqual(evaluate(p, ncs).fails, ['liqPrevMissing']);
  const p2 = basePair(); p2.liqChangeVsPrevPct = -10.5;
  assert.deepStrictEqual(evaluate(p2, ncs).fails, ['liqDropVsPrev']);
});
test('NCS spec: bonding-curve pools excluded by dexId or DEX Screener label (DBC / LaunchLab)', () => {
  for (const [dexId, labels] of [['pumpfun', []], ['meteora', ['DBC']], ['raydium', ['LaunchLab']], ['moonshot', []]]) {
    const p = basePair(); p.dexId = dexId; p.labels = labels;
    assert.ok(evaluate(p, ncs).fails.includes('bondingCurve'), dexId);
  }
  const ok = basePair(); ok.dexId = 'pumpswap'; ok.labels = []; assert.deepStrictEqual(evaluate(ok, ncs).fails, []);
  const ok2 = basePair(); ok2.dexId = 'meteora'; ok2.labels = ['DLMM']; assert.deepStrictEqual(evaluate(ok2, ncs).fails, []);
});
test('NCS spec boundaries: age 5..240, m5 +3..+40 inclusive, buys > sells strictly, wash 12/3, tier B <= 60 min', () => {
  const e = (mut) => { const p = basePair(); mut(p); return evaluate(p, ncs).fails; };
  assert.ok(e(p => { p.pairAgeMin = 4.9; }).includes('pairAge'));
  assert.ok(!e(p => { p.pairAgeMin = 5; }).includes('pairAge'));
  assert.ok(e(p => { p.pairAgeMin = 240.1; }).includes('pairAge'));
  assert.ok(!e(p => { p.priceChange.m5 = 3; }).includes('m5Range'));
  assert.ok(e(p => { p.priceChange.m5 = 2.99; }).includes('m5Range'));
  assert.ok(e(p => { p.priceChange.m5 = 40.01; }).includes('m5Range'));
  assert.ok(e(p => { p.txnsM5 = { buys: 15, sells: 15 }; }).includes('m5BuysGtSells'));
  assert.ok(e(p => { p.volumeH1 = 20000 * 12.01; }).includes('washH1'));
  assert.ok(!e(p => { p.volumeH1 = 20000 * 12; }).includes('washH1'));
  assert.ok(e(p => { p.liquidityUsd = 9000; p.volumeM5 = 3500; p.volumeH1 = 20000; p.pairAgeMin = 61; }).includes('tierLiquidity'));
  assert.strictEqual(ncs.universe.tokenFirstSeenMaxHours, 6);
});
test('NCS spec rug extras: creator rug history; token-2022 extensions matched by spec prefix', () => {
  const rep = goodReport();
  rep.risks = [{ name: 'Creator history of rugged tokens', level: 'warn' }];
  assert.ok(evaluateReport(rep, { pairAddress: POOL, dexLiquidityUsd: 100000, extra: ncs.extraRug }).reasons.includes('creator-rug-history'));
  const rep2 = goodReport(); rep2.token_extensions = { confidentialTransferMint: { authority: 'x' } };
  assert.ok(evaluateReport(rep2, { pairAddress: POOL, dexLiquidityUsd: 100000, extra: ncs.extraRug }).reasons.includes('ext-confidentialTransferMint'));
});
test('quoteSanity rule: reverse-quote impact at size > MAX_REVERSE_IMPACT_PCT (3) rejects', async () => {
  const r = goodRoutes(); r[`${RUDY}>${SOL}`] = amt => body(RUDY, SOL, amt, 190000000, 0.035);
  const { res } = await entryCheck(r);
  assert.deepStrictEqual(res.reasons, ['reverse-impact 3.50%>3%']);
});
test('rejections detail: per-mint rows with failed gate + value (last 200)', () => {
  const rows = [];
  const p = basePair(); p.priceChange.m5 = 1;
  generateSignals([p], { detail: r => rows.push(r) });
  const n = rows.find(r => r.strategyId === ncs.id);
  assert.strictEqual(n.gate, 'm5Range'); assert.strictEqual(n.value, 1); assert.strictEqual(n.mint, 'M1');
  for (let i = 0; i < 250; i++) rej.detail({ strategyId: 'x', mint: 'm' + i, gate: 'g', value: i });
  assert.strictEqual(rej.details.length, 200); assert.strictEqual(rej.details[0].value, 249);
});

test('momentum-entry time stop: exits at max hold only if PnL < 0, else arms a trail', () => {
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  // highest 1.02: peak below the PR5 +3% breakeven arm and at the +2% early-fail bar (current config exits apply).
  const mk = () => ({ strategyId: 'momentum-entry', strategyType: 'simple', entryTime: new Date(t0).toISOString(), entryPrice: 1, highest: 1.02, remainingFrac: 1, exit: { takeProfitPct: 10, stopLossPct: 6, maxHoldMinutes: 40 } });
  const late = t0 + 41 * 60000;
  const loss = decide(mk(), 0.99, true, null, late);
  assert.strictEqual(loss.reason, 'time');
  const p = mk();
  assert.strictEqual(decide(p, 1.03, true, null, late), null); // in profit: hold, trail armed at 1.03
  assert.ok(p.timeTrailArmedAt); assert.strictEqual(p.timeTrailHigh, 1.03);
  assert.strictEqual(decide(p, 1.06, true, null, late + 10000), null); // new high 1.06
  assert.strictEqual(p.timeTrailHigh, 1.06);
  assert.strictEqual(decide(p, 1.02, true, null, late + 20000), null); // -3.8% from high, still >0
  assert.strictEqual(decide(p, 1.0065, true, null, late + 30000).reason, 'time-trail'); // -5.05% from high
  const q = mk(); decide(q, 1.02, true, null, late);
  assert.strictEqual(decide(q, 0.995, true, null, late + 10000).reason, 'time'); // dropped under 0%
  assert.strictEqual(decide(mk(), 1.02, true, null, t0 + 11 * 60000), null); // before max hold (12): unchanged
});

// ---------- PR2.3: per-strategy gap caps, round trip, exits judged on the sell quote ----------
const stratById = id => config.strategies.find(s => s.id === id);
test('per-strategy quote gap caps: momentum-entry 5%, aggressive-flow 3% (batch1), NCS 8%, default 15%', async () => {
  assert.strictEqual(config.quoteSanityFor(stratById('momentum-entry')).maxQuoteGapPct, 5);
  assert.strictEqual(config.quoteSanityFor(stratById('ncs_fresh_momentum_v1')).maxQuoteGapPct, 8);
  assert.strictEqual(config.quoteSanityFor(stratById('aggressive-flow')).maxQuoteGapPct, 3);
  assert.strictEqual(config.quoteSanityFor(null).maxQuoteGapPct, 15); // global default (no override)
  // Quote ~6.6% worse than model (LOOSY-like): momentum rejects, NCS passes; ~11%: both reject, default passes.
  const at = f => { const r = goodRoutes(); r[`${SOL}>${RUDY}`] = amt => body(SOL, RUDY, amt, Math.round(goodTokensRaw / f), 0.01); return r; };
  const mom = config.quoteSanityFor(stratById('momentum-entry')), ncsC = config.quoteSanityFor(stratById('ncs_fresh_momentum_v1'));
  const r1m = (await entryCheck(at(1.055), { cfg: mom })).res, r1n = (await entryCheck(at(1.055), { cfg: ncsC })).res;
  assert.strictEqual(r1m.pass, false); assert.ok(r1m.reasons[0].startsWith('gap ') && r1m.reasons[0].endsWith('>5%'), r1m.reasons[0]);
  assert.ok(r1n.pass, r1n.reasons.join(';'));
  const r2n = (await entryCheck(at(1.10), { cfg: ncsC })).res;
  assert.ok(r2n.reasons[0].endsWith('>8%'), r2n.reasons[0]);
  assert.ok((await entryCheck(at(1.10))).res.pass);
});
test('round trip: buy at size then sell those tokens back; > 3% loss rejects as quoteSanity:roundtrip', async () => {
  const cfg = config.quoteSanityFor(stratById('momentum-entry'));
  assert.strictEqual(cfg.maxRoundTripLossPct, 3);
  const ok = (await entryCheck(goodRoutes(), { cfg, sizeSol: 0.2 })).res; // 0.197 back = 1.5% loss
  assert.ok(ok.pass, ok.reasons.join(';')); near(ok.roundTripLossPct, 1.5, 1e-9);
  const r = goodRoutes(); r[`${RUDY}>${SOL}`] = amt => body(RUDY, SOL, amt, 192000000, 0.01); // 0.192 back = 4% loss, impact 1%
  const bad = (await entryCheck(r, { cfg, sizeSol: 0.2 })).res;
  assert.deepStrictEqual(bad.reasons, ['roundtrip 4.00%>3%']);
  assert.strictEqual(qs.reasonLabel(bad.reasons), 'quoteSanity:roundtrip');
  assert.strictEqual(qs.reasonLabel(['impact 6.00%>5%']), 'quoteSanity');
});
test('exits judged on the sell quote: TP does not trigger while the quote is below TP; a quote-backed TP is net positive', () => {
  const { judgeExit, isProfitReason } = require('../src/sellAgent');
  const t0 = Date.now() - 5 * 60000;
  const pos = { strategyId: 'momentum-entry', strategyType: 'simple', entryTime: new Date(t0).toISOString(), entryPrice: 1, entryFillPrice: 1.03,
    entryTxCostSol: fm.txCostSol(1), sizeSol: 0.2, remainingFrac: 1, highest: 1.12, exit: stratById('momentum-entry').exit };
  // Mid is +12% (old rule: TP at +10%), but Jupiter would only pay 1.10/token: net ~+6%, below TP -> no exit.
  const j1 = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.10 }, midPrice: 1.12, liquidityUsd: 100000, solUsd: 72 });
  assert.strictEqual(j1.source, 'jupiter');
  assert.ok(j1.netPct > 0 && j1.netPct < 10, String(j1.netPct));
  assert.strictEqual(decide(pos, j1.price, true, null), null);
  // Quote 1.15/token: net >= 10% -> TP fires, and its booked PnL (fill = quote) is positive after costs.
  const j2 = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.15 }, midPrice: 1.16, liquidityUsd: 100000, solUsd: 72 });
  const d = decide(pos, j2.price, true, null);
  assert.strictEqual(d.reason, 'tp'); assert.ok(isProfitReason(d.reason));
  const legNet = legPnlSol(pos, j2.execPrice, d.sellFrac) - fm.txCostSol(1) - pos.entryTxCostSol;
  assert.ok(legNet > 0, String(legNet)); near(legNet, j2.netSol, 1e-12);
  // No quote: model fallback (mid minus modeled impact/slippage/fee), never more optimistic than mid.
  const j3 = judgeExit(pos, { quote: null, midPrice: 1.12, liquidityUsd: 100000, solUsd: 72 });
  assert.strictEqual(j3.source, 'model'); assert.ok(j3.execPrice < 1.12);
  // SL is judged on the quote too: mid only -3% but quote -8% net -> stop.
  const j4 = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 0.96 }, midPrice: 0.97, liquidityUsd: 100000, solUsd: 72 });
  assert.strictEqual(decide(pos, j4.price, true, null).reason, 'sl');
});
test('NCS sizing: tier A = base size (sizeMult 1), tier B = half (0.5)', () => {
  const ncs = stratById('ncs_fresh_momentum_v1');
  assert.strictEqual(ncs.universe.tiers.A.sizeMult, 1.0);
  assert.strictEqual(ncs.universe.tiers.B.sizeMult, 0.5);
});

test('entry grace (aggressive-flow + momentum-entry): first 60s only a -15% hard stop from the entry fill (sell quote) can fire', () => {
  const { judgeExit } = require('../src/sellAgent');
  for (const id of ['aggressive-flow', 'momentum-entry']) {
    const ex = stratById(id).exit;
    const [g, h] = id === 'momentum-entry' ? [30, 10] : [60, 15]; // momentum: 98074ad (30s / 10%)
    assert.strictEqual(ex.graceSec, g); assert.strictEqual(ex.hardStopPct, h); assert.strictEqual(ex.judgeOn, 'sell-quote');
    const now = Date.now();
    const pos = { strategyId: id, strategyType: 'simple', entryTime: new Date(now - 9000).toISOString(), entryPrice: 1, entryFillPrice: 1.04,
      entryTxCostSol: fm.txCostSol(1), sizeSol: 0.1, remainingFrac: 1, highest: 1.0, exit: ex };
    // iAgent: 9s after entry, sell quote -5.9% vs the entry FILL -> no stop during grace (old rule fired 'sl').
    const j = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.04 * 0.941 }, midPrice: 1.0, liquidityUsd: 100000, solUsd: 72 });
    assert.ok(j.netPct < -5.9 && j.netPct > -7, String(j.netPct));
    assert.strictEqual(decide(pos, j.price, true, null, now), null);
    // +20% within grace: no TP either (only the hard stop can fire).
    const up = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.04 * 1.2 }, midPrice: 1.2, liquidityUsd: 100000, solUsd: 72 });
    assert.strictEqual(decide(pos, up.price, true, null, now), null);
    // -16% from the fill within grace -> hard stop (a stop reason for the fill model).
    const crash = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.04 * 0.84 }, midPrice: 0.9, liquidityUsd: 100000, solUsd: 72 });
    assert.strictEqual(decide(pos, crash.price, true, null, now).reason, 'hard-stop');
    assert.ok(fm.isStopReason('hard-stop'));
    // After 60s the normal SL applies to the same -5.9% (measured from the fill, not mid: mid here is flat).
    assert.strictEqual(decide(pos, j.price, true, null, now + 52000).reason, 'sl');
  }
  // batch2: NCS uses the same 60s grace / 15% hard stop.
  assert.strictEqual(stratById('ncs_fresh_momentum_v1').exit.graceSec, 60);
});

test('after a restart (no sell quote yet) SL/trail/TP wait for a real quote; hard stop / emergency may fire on the model', () => {
  const { judgeExit, awaitQuoteGate } = require('../src/sellAgent');
  assert.strictEqual(config.exitQuotes.firstQuoteWaitMs, 30000);
  const now = Date.now();
  // GATO-like: momentum-entry position opened 10 min ago (past grace), model says -6.15% net -> decide() fires 'sl'.
  const ex = stratById('momentum-entry').exit;
  const pos = { strategyId: 'momentum-entry', strategyType: 'simple', entryTime: new Date(now - 600000).toISOString(), entryPrice: 1, entryFillPrice: 1.01,
    entryTxCostSol: fm.txCostSol(1), sizeSol: 0.2, remainingFrac: 1, highest: 1.05, exit: ex };
  const model = { source: 'model', netPct: -6.15, price: 1 * (1 - 0.0615) };
  const d = decide(pos, model.price, true, null, now);
  assert.strictEqual(d.reason, 'sl');
  // Waiting for the first quote: held.
  let g = awaitQuoteGate(pos, d, model, { waiting: true, hardStopPct: 15 });
  assert.strictEqual(g.d, null); assert.strictEqual(g.held, 'sl'); assert.strictEqual(g.modelExit, false);
  // Trail and TP are held too.
  for (const r of ['trail', 'tp', 'time-trail', 'breakeven']) assert.strictEqual(awaitQuoteGate(pos, { action: 'close', reason: r }, model, { waiting: true, hardStopPct: 15 }).d, null);
  // Emergency (rug / liquidity / no sells) and hard stop may still fire on the model.
  for (const r of ['emergency-liq', 'emergency-rug', 'emergency-nosells', 'hard-stop']) {
    g = awaitQuoteGate(pos, { action: 'close', reason: r }, model, { waiting: true, hardStopPct: 15 });
    assert.strictEqual(g.d.reason, r); assert.strictEqual(g.modelExit, true);
  }
  // Model at <= -15% net while waiting -> converted to a hard stop.
  const deep = { source: 'model', netPct: -16, price: 0.84 };
  g = awaitQuoteGate(pos, decide(pos, deep.price, true, null, now), deep, { waiting: true, hardStopPct: 15 });
  assert.strictEqual(g.d.reason, 'hard-stop'); assert.strictEqual(g.held, 'sl'); assert.strictEqual(g.modelExit, true);
  // NCS (stop 12%) uses max(hard stop, own stop): -13% held, -16% -> hard stop.
  const ncsPos = Object.assign({}, pos, { strategyId: 'ncs_fresh_momentum_v1', exit: stratById('ncs_fresh_momentum_v1').exit });
  assert.strictEqual(awaitQuoteGate(ncsPos, { action: 'close', reason: 'sl' }, { source: 'model', netPct: -13, price: 0.87 }, { waiting: true, hardStopPct: 15 }).d, null);
  assert.strictEqual(awaitQuoteGate(ncsPos, { action: 'close', reason: 'sl' }, deep, { waiting: true, hardStopPct: 15 }).d.reason, 'hard-stop');
  // A real sell quote (source jupiter) or an expired wait: normal decision passes through unchanged.
  const jq = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.01 * 0.93 }, midPrice: 1.0, liquidityUsd: 100000, solUsd: 72 });
  assert.strictEqual(jq.source, 'jupiter');
  const dj = decide(pos, jq.price, true, null, now);
  assert.strictEqual(dj.reason, 'sl');
  assert.strictEqual(awaitQuoteGate(pos, dj, jq, { waiting: true, hardStopPct: 15 }).d, dj);
  assert.strictEqual(awaitQuoteGate(pos, d, model, { waiting: false, hardStopPct: 15 }).d, d);
  // index.js wires the gate into processExits for paper and live positions alike (one exit path).
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(/awaitQuoteGate\(pos, d, judge/.test(src) && /exit-quote-wait-expired/.test(src) && /exit-held-awaiting-quote/.test(src));
});

test('slot allocator: cap 12 when cash covers it, AF max 4, NCS max 2, 5 slots reserved for momentum, bump the weakest AF past grace', () => {
  const { maxOpenFor, reservedFor, pickBumpVictim } = require('../src/slots');
  const af = stratById('aggressive-flow'), mom = stratById('momentum-entry'), ncsS = stratById('ncs_fresh_momentum_v1');
  // Allocator lives outside every configHash: momentum-entry must stay fc3fd9a29a5c.
  assert.strictEqual(config.strategyHashes['momentum-entry'], 'c1ab00a8e531'); // PR5 loser-cut
  assert.strictEqual(config.opsFor('aggressive-flow').maxOpen, 4); assert.strictEqual(config.opsFor(ncsS.id).maxOpen, 2);
  const now = Date.now();
  const P = (id, ageSec = 600, netPct = 0, extra = {}) => ({ strategyId: id, sizeSol: id === 'aggressive-flow' ? 0.1 : 0.2, remainingFrac: 1, entryTime: new Date(now - ageSec * 1000).toISOString(), lastJudge: { netPct }, ...extra });
  // Cap: 12 when cash covers (12 - open) x 0.2 + 0.5 buffer, else the base 10.
  const nine = Array.from({ length: 9 }, () => P('aggressive-flow'));
  assert.strictEqual(maxOpenFor({ balance: 2.17, openPositions: nine }, config), 12);
  assert.strictEqual(maxOpenFor({ balance: 1.0, openPositions: nine }, config), 10);
  // Reserve: with 0 momentum open, 5 slots are held back -> AF/NCS may only use 12 - 5 = 7 slots in total.
  assert.strictEqual(reservedFor({ openPositions: [] }, config, 'aggressive-flow'), 5);
  assert.strictEqual(reservedFor({ openPositions: [] }, config, 'momentum-entry'), 0);
  const mixed = [P('aggressive-flow'), P('aggressive-flow'), P('aggressive-flow'), P(ncsS.id), P(ncsS.id), P('x'), P('x')];
  let st = slotStatus({ balance: 3, openPositions: mixed.slice(0, 6) }, af, config); // 3 AF + 2 NCS + 1 other, 6+1+5 <= 12
  assert.strictEqual(st, null);
  st = slotStatus({ balance: 3, openPositions: mixed }, af, config); // 7 open: 7+1+5 > 12 -> reserved
  assert.strictEqual(st.scope, 'reserved');
  assert.strictEqual(slotStatus({ balance: 3, openPositions: mixed }, mom, config), null); // momentum uses the reserve
  // Caps: 4 AF open blocks AF; 2 NCS blocks NCS. Over-cap positions are not closed, they just block.
  const fiveAF = Array.from({ length: 5 }, () => P('aggressive-flow'));
  assert.strictEqual(slotStatus({ balance: 3, openPositions: fiveAF }, af, config).scope, 'strategy');
  assert.strictEqual(slotStatus({ balance: 3, openPositions: [P(ncsS.id), P(ncsS.id)] }, ncsS, config, 'A').scope, 'strategy');
  // Bump: weakest AF past its 60s grace; never one inside grace, never a live or non-AF position.
  const book = [P('aggressive-flow', 600, -1), P('aggressive-flow', 30, -9), P('aggressive-flow', 300, -3.5), P('aggressive-flow', 900, -8, { live: {} }), P('momentum-entry', 900, -12), P(ncsS.id, 900, -11)];
  const v = pickBumpVictim({ openPositions: book }, config, 'momentum-entry', now);
  assert.strictEqual(v, book[2]);
  assert.strictEqual(pickBumpVictim({ openPositions: book }, config, 'aggressive-flow', now), null); // only momentum bumps
  assert.strictEqual(pickBumpVictim({ openPositions: [P('aggressive-flow', 59, -20)] }, config, 'momentum-entry', now), null);
  // Weakness falls back to mid vs entry fill when there is no judged quote yet.
  const noJ = [{ strategyId: 'aggressive-flow', entryTime: new Date(now - 600000).toISOString(), entryFillPrice: 1, lastPrice: 0.9 }, P('aggressive-flow', 600, -2)];
  assert.strictEqual(pickBumpVictim({ openPositions: noJ }, config, 'momentum-entry', now), noJ[0]);
  // Full 12/12 book: momentum is blocked globally, but after removing the victim it has a slot.
  const full = Array.from({ length: 12 }, (_, i) => P(i < 6 ? 'aggressive-flow' : 'x', 600, -i));
  assert.strictEqual(slotStatus({ balance: 3, openPositions: full }, mom, config).scope, 'global');
  const victim = pickBumpVictim({ openPositions: full }, config, 'momentum-entry', now);
  assert.strictEqual(victim, full[5]);
  assert.strictEqual(slotStatus({ balance: 3, openPositions: full.filter(p => p !== victim) }, mom, config), null);
  // index.js books a bump at a fresh sell quote with exit reason 'bumped' and doesn't count it as a loss streak.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(/reason: 'bumped'/.test(src) && /judge.source !== 'jupiter'/.test(src) && /finalReason !== 'bumped'/.test(src));
});

test('allocator: momentum-entry claims a mint both strategies passed; a capped AF never takes it', () => {
  const { orderCandidates, ownSlotBlocked } = require('../src/slots');
  const af = stratById('aggressive-flow'), mom = stratById('momentum-entry');
  const sigs = [{ strategyId: 'aggressive-flow', strategy: af, mint: 'X' }, { strategyId: 'momentum-entry', strategy: mom, mint: 'X' }];
  assert.strictEqual(orderCandidates(sigs, config)[0].strategyId, 'momentum-entry');
  const fourAF = Array.from({ length: 4 }, () => ({ strategyId: 'aggressive-flow', sizeSol: 0.1 }));
  assert.ok(ownSlotBlocked(slotStatus({ balance: 3, openPositions: fourAF }, af, config)));
  assert.ok(!ownSlotBlocked(slotStatus({ balance: 3, openPositions: fourAF }, mom, config)));
  assert.ok(!ownSlotBlocked({ reason: 'slot-full skip', scope: 'global' }));
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(/for \(const sig of orderCandidates\(split.real, config\)\)/.test(src) && /ownSlotBlocked\(slotStatus/.test(src));
});

test('batch1: AF TP 4 / trail 2.5->1.25 / stall exit; NCS lock after +8% and TP1 15; momentum hash unchanged', () => {
  assert.strictEqual(config.strategyHashes['momentum-entry'], 'c1ab00a8e531'); // PR5 loser-cut
  const now = Date.now();
  const af = stratById('aggressive-flow');
  const P = (minsAgo, extra = {}) => ({ strategyId: 'aggressive-flow', strategyType: 'simple', entryTime: new Date(now - minsAgo * 60000).toISOString(), entryPrice: 1, entryFillPrice: 1, sizeSol: 0.1, remainingFrac: 1, highest: 1, exit: af.exit, ...extra });
  assert.strictEqual(decide(P(5), 1.04, true, null, now).reason, 'tp');
  assert.strictEqual(decide(P(5), 1.039, true, null, now), null);
  // trail arms at +2.5 net peak, exits 1.25% below it
  assert.strictEqual(decide(P(5, { judgedHigh: 1.026 }), 1.026 * (1 - 0.0125), true, null, now).reason, 'trail');
  assert.strictEqual(decide(P(5, { judgedHigh: 1.024 }), 1.0, true, null, now), null);
  // stall: after 6 min, never above +1% and down 2.5% -> stall; peak +1.5% -> no stall; before 6 min -> no stall
  assert.strictEqual(decide(P(7, { judgedHigh: 1.005 }), 0.975, true, null, now).reason, 'stall');
  assert.strictEqual(decide(P(7, { judgedHigh: 1.015 }), 0.975, true, null, now), null);
  assert.strictEqual(decide(P(5, { judgedHigh: 1.005 }), 0.975, true, null, now), null);
  assert.strictEqual(decide(P(7, { judgedHigh: 1.005 }), 0.95, true, null, now).reason, 'sl');
  // inside grace only the hard stop
  assert.strictEqual(decide(P(0.5, { judgedHigh: 1.0 }), 0.96, true, null, now), null);
  // momentum: no AF-style stall keys; PR5 early-failure exit cuts -3% at 10 min (never +2%) as 'stall'.
  const mom = stratById('momentum-entry');
  assert.strictEqual(mom.exit.stallAfterMin, undefined);
  assert.strictEqual(decide({ strategyId: 'momentum-entry', strategyType: 'simple', entryTime: new Date(now - 600000).toISOString(), entryPrice: 1, entryFillPrice: 1, sizeSol: 0.2, remainingFrac: 1, highest: 1, judgedHigh: 1, exit: mom.exit }, 0.97, true, null, now).reason, 'stall');
  // NCS lock: peak +8% net, back to +1% -> lock; peak +7% -> nothing; TP1 at +15%
  const ncsS = stratById('ncs_fresh_momentum_v1');
  const N = extra => ({ strategyId: ncsS.id, strategyType: 'ncs', entryTime: new Date(now - 120000).toISOString(), entryPrice: 1, entryFillPrice: 1, sizeSol: 0.08, remainingFrac: 1, highest: 1, exit: ncsS.exit, ...extra });
  assert.strictEqual(decide(N({ judgedHigh: 1.08 }), 1.005, true, null, now).reason, 'lock');
  assert.strictEqual(decide(N({ judgedHigh: 1.07 }), 1.01, true, null, now), null);
  const tp1 = decide(N({ judgedHigh: 1.16 }), 1.16, true, null, now);
  assert.strictEqual(tp1.reason, 'tp1'); assert.strictEqual(tp1.sellFrac, 0.5);
  assert.strictEqual(ncsS.exit.trailAfterTp1Pct, 10);
});

test('batch2: AF 0.05 SOL, v/l >= 0.15 (14:05), m5 buys > sells (fail closed), h1 > 0; NCS grace + fill stop, tier B half; allocator', () => {
  const { pickBumpVictim } = require('../src/slots');
  assert.strictEqual(config.strategyHashes['momentum-entry'], 'c1ab00a8e531'); // PR5 loser-cut
  const af = stratById('aggressive-flow'), mom = stratById('momentum-entry'), ncsS = stratById('ncs_fresh_momentum_v1');
  assert.strictEqual(af.sizeSol, 0.02); // PR5
  const P = () => Object.assign(basePair(), { liquidityUsd: 200000, volumeH1: 120000, txnsM5: { buys: 30, sells: 20 }, priceChange: { m5: 0, h1: 1, h6: 0, h24: 0 } });
  assert.deepStrictEqual(evaluate(P(), af).fails, []);
  let p = P(); p.volumeH1 = 28000; assert.ok(evaluate(p, af).fails.includes('volumeToLiquidity>=0.15')); // 0.14 < 0.15
  p = P(); p.volumeH1 = 30000; assert.deepStrictEqual(evaluate(p, af).fails, []); // 0.15 passes
  p = P(); p.txnsM5 = { buys: 20, sells: 20 }; assert.ok(evaluate(p, af).fails.includes('buysGtSellsM5>=1'));
  p = P(); p.txnsM5 = undefined; assert.ok(evaluate(p, af).fails.includes('buysGtSellsM5>=1'));       // missing -> fail closed
  p = P(); p.txnsM5 = { buys: '30', sells: null }; assert.ok(evaluate(p, af).fails.includes('buysGtSellsM5>=1'));
  // 16:04: AF h1>0 rule removed -> a flat or negative h1 no longer blocks.
  p = P(); p.priceChange.h1 = 0; assert.deepStrictEqual(evaluate(p, af).fails, []);
  p = P(); p.priceChange.h1 = -3; assert.deepStrictEqual(evaluate(p, af).fails, []);
  assert.ok(!af.entry.some(r => r.field === 'h1'));
  assert.strictEqual(af.exit.stallAfterMin, 6); // stall exit kept
  // NCS: Raja-like -14% (vs the paper fill) 9s after entry is held in grace; -16% -> hard stop; emergency still fires.
  const now = Date.now();
  const N = (secAgo, extra = {}) => ({ strategyId: ncsS.id, strategyType: 'ncs', exit: ncsS.exit, entryTime: new Date(now - secAgo * 1000).toISOString(), entryPrice: 1, entryFillPrice: 1, sizeSol: 0.033, remainingFrac: 1, highest: 1, entryLiquidityUsd: 20000, ...extra });
  assert.strictEqual(ncsS.exit.graceSec, 60); assert.strictEqual(ncsS.exit.hardStopPct, 15); assert.strictEqual(ncsS.exit.stopFrom, 'fill');
  assert.strictEqual(decide(N(9), 0.86, true, null, now), null);
  assert.strictEqual(decide(N(9), 0.84, true, null, now).reason, 'hard-stop');
  assert.strictEqual(decide(N(9), 1, true, { liquidityUsd: 13000, txnsM5: { buys: 5, sells: 5 } }, now).reason, 'emergency-liq');
  assert.strictEqual(decide(N(61), 0.87, true, null, now).reason, 'sl');
  // Stop is measured from the paper fill: judged net PnL vs entryFillPrice (not mid).
  const { judgeExit } = require('../src/sellAgent');
  const pos = N(61, { entryFillPrice: 1.05, entryTxCostSol: 0 });
  const j = judgeExit(pos, { quote: { ok: true, quotedPriceUsd: 1.05 * 0.87 }, midPrice: 1.0, liquidityUsd: 20000, solUsd: 72 });
  assert.strictEqual(decide(pos, j.price, true, null, now).reason, 'sl'); // mid flat, fill-based -13% -> sl
  // Tier B half size.
  assert.strictEqual(ncsS.universe.tiers.B.sizeMult, 0.5); assert.strictEqual(ncsS.universe.tiers.A.sizeMult, 1.0);
  // Allocator: with 0 momentum open, AF fills to 4 and NCS to 2 (own caps, not the reserve); total <= 12.
  const O = (id, n, ageSec = 600) => Array.from({ length: n }, () => ({ strategyId: id, sizeSol: 0.05, remainingFrac: 1, entryTime: new Date(now - ageSec * 1000).toISOString(), lastJudge: { netPct: -1 } }));
  assert.strictEqual(slotStatus({ balance: 2.3, openPositions: O('aggressive-flow', 3) }, af, config), null);
  assert.strictEqual(slotStatus({ balance: 2.3, openPositions: O('aggressive-flow', 3).concat(O(ncsS.id, 1)) }, ncsS, config, 'A'), null);
  const st = slotStatus({ balance: 2.3, openPositions: O('aggressive-flow', 4).concat(O(ncsS.id, 2)) }, af, config);
  assert.strictEqual(st.scope, 'strategy'); assert.strictEqual(st.open, 4); assert.strictEqual(st.max, 4); // per-strategy counts (6/12 total open)
  // Momentum (the 13:39 case): 8 momentum + 3 others = 11/12 -> momentum may enter (was skipped at its own 8/8).
  assert.strictEqual(slotStatus({ balance: 2.3, openPositions: O('momentum-entry', 8).concat(O('aggressive-flow', 3)) }, mom, config), null);
  // 12/12 (8 momentum + 4 AF): momentum is globally full but can bump the weakest AF.
  const full = O('momentum-entry', 8).concat(O('aggressive-flow', 4));
  assert.strictEqual(slotStatus({ balance: 2.3, openPositions: full }, mom, config).scope, 'global');
  const v = pickBumpVictim({ openPositions: full }, config, 'momentum-entry', now);
  assert.ok(v && v.strategyId === 'aggressive-flow');
  assert.strictEqual(slotStatus({ balance: 2.3, openPositions: full.filter(x => x !== v) }, mom, config), null);
  // Global cap still holds for everyone.
  assert.strictEqual(slotStatus({ balance: 3, openPositions: O('momentum-entry', 12) }, mom, config).scope, 'global');
});


test('PR4.1 momentum entry loosened (h1 >= 1.5, m5 >= 0.3), exits unchanged', () => {
  const mom = stratById('momentum-entry');
  assert.deepStrictEqual(mom.entry.map(r => `${r.field}${r.op}${r.value}`), ['h1>=1.5', 'm5>=0.3', 'buysGtSellsM5>=1']); // PR5 adds m5 buys > sells
  const P = (h1, m5) => Object.assign(basePair(), { liquidityUsd: 200000, volumeH1: 120000, priceChange: { m5, h1, h6: 0, h24: 0 } });
  assert.deepStrictEqual(evaluate(P(1.6, 0.35), mom).fails.filter(f => /h1|m5/.test(f)), []);
  assert.ok(evaluate(P(1.4, 0.35), mom).fails.includes('h1>=1.5'));
  assert.ok(evaluate(P(1.6, 0.25), mom).fails.includes('m5>=0.3'));
  assert.strictEqual(mom.exit.maxHoldMinutes, 12); assert.strictEqual(mom.exit.graceSec, 30); assert.strictEqual(mom.sizeSol, 0.2);
});

test('PR4 momentum (98074ad): max hold 25 min, 30s grace with a 10% hard stop', () => {
  const ex = stratById('momentum-entry').exit;
  assert.strictEqual(ex.maxHoldMinutes, 12); assert.strictEqual(ex.graceSec, 30); assert.strictEqual(ex.hardStopPct, 10); // PR5: 25 -> 12
  assert.strictEqual(ex.stopLossPct, 6); assert.strictEqual(ex.takeProfitPct, 10);
  const t0 = Date.now();
  const pos = { strategyId: 'momentum-entry', strategyType: 'simple', entryTime: new Date(t0).toISOString(), entryPrice: 1, entryFillPrice: 1, sizeSol: 0.2, remainingFrac: 1, highest: 1, exit: ex };
  assert.strictEqual(decide(pos, 0.93, true, null, t0 + 20000), null);            // -7% at 20s: inside grace
  assert.strictEqual(decide(pos, 0.89, true, null, t0 + 20000).reason, 'hard-stop'); // -11% at 20s: hard stop
  assert.strictEqual(decide(pos, 0.93, true, null, t0 + 35000).reason, 'sl');      // -7% at 35s: normal SL (Huss case)
  assert.strictEqual(decide(pos, 0.98, true, null, t0 + 5 * 60000), null);
  // Unchanged: AF and NCS keep 60s / 15%.
  assert.strictEqual(stratById('aggressive-flow').exit.graceSec, 60); assert.strictEqual(stratById('ncs_fresh_momentum_v1').exit.hardStopPct, 15);
});

test('PR4.1 mint guard: 2h stop cooldown (all strategies), max 2 LOSING trades per mint per London day, outside the hashes', () => {
  const mg = require('../src/mintGuard');
  const cfg = config.mintGuard;
  assert.strictEqual(cfg.stopCooldownMin, 120); assert.strictEqual(cfg.maxLossesPerDay, 2); assert.strictEqual(cfg.maxEntriesPerDay, undefined);
  for (const r of ['sl', 'hard-stop', 'stall', 'emergency-rug']) assert.ok(mg.isStopReason(r, cfg), r);
  for (const r of ['tp', 'trail', 'time', 'bumped', 'lock', 'breakeven']) assert.ok(!mg.isStopReason(r, cfg), r);
  const st = { openPositions: [] };
  const t = Date.parse('2026-11-20T14:00:00Z');
  assert.strictEqual(mg.check(st, 'M1', cfg, t), null);
  assert.strictEqual(mg.recordExit(st, { mint: 'M1', reason: 'tp', strategyId: 'momentum-entry' }, cfg, t), false);
  assert.strictEqual(mg.check(st, 'M1', cfg, t), null);
  mg.recordExit(st, { mint: 'M1', reason: 'stall', symbol: 'SHIT', strategyId: 'aggressive-flow' }, cfg, t);
  assert.strictEqual(mg.check(st, 'M1', cfg, t + 119 * 60000).reason, 'cooldown');      // blocks every strategy
  assert.strictEqual(mg.check(st, 'M1', cfg, t + 121 * 60000), null);
  // Entries alone never cap any more (the 15:00-16:00 zero-entry cause).
  for (let i = 0; i < 5; i++) mg.recordEntry(st, 'M2', t + i);
  assert.strictEqual(mg.check(st, 'M2', cfg, t + 120000), null);
  // Two losing trades (net after costs) across strategies -> capped for the London day; non-stop losses count too.
  mg.recordExit(st, { mint: 'M2', reason: 'time', strategyId: 'momentum-entry', pnlSol: -0.004 }, cfg, t + 1000);
  assert.strictEqual(mg.check(st, 'M2', cfg, t + 2000), null);
  mg.recordExit(st, { mint: 'M2', reason: 'lock', strategyId: 'ncs_fresh_momentum_v1', pnlSol: -0.001 }, cfg, t + 3000);
  assert.strictEqual(mg.check(st, 'M2', cfg, t + 120000).reason, 'mint-daily-cap');
  assert.strictEqual(mg.check(st, 'M2', cfg, Date.parse('2026-11-21T00:00:01Z')), null); // new London day
  // A winner as the last closed trade lifts the cap (cooldown still applies separately).
  mg.recordExit(st, { mint: 'M2', reason: 'tp', strategyId: 'momentum-entry', pnlSol: 0.01 }, cfg, t + 4000);
  assert.strictEqual(mg.check(st, 'M2', cfg, t + 120000), null);
  mg.recordExit(st, { mint: 'M2', reason: 'time', strategyId: 'momentum-entry', pnlSol: -0.002 }, cfg, t + 5000);
  assert.strictEqual(mg.check(st, 'M2', cfg, t + 120000).reason, 'mint-daily-cap'); // 3 losses, last a loser
  // Winning trade on a fresh mint never caps; a winning stop-type exit (e.g. sl after slippage +) still cools down.
  mg.recordExit(st, { mint: 'M3', reason: 'tp', pnlSol: 0.02 }, cfg, t); mg.recordExit(st, { mint: 'M3', reason: 'trail', pnlSol: 0.01 }, cfg, t + 1);
  assert.strictEqual(mg.check(st, 'M3', cfg, t + 2), null);
  assert.strictEqual(mg.londonDay(Date.parse('2026-07-01T23:30:00Z')), '2026-07-02');
  assert.strictEqual(mg.londonDay(Date.parse('2026-11-20T23:30:00Z')), '2026-11-20');
  const s = mg.summary(st, cfg, t + 120000);
  assert.strictEqual(s.inCooldown.length, 1); assert.strictEqual(s.dailyCapped.length, 1); assert.strictEqual(s.dailyCapped[0].losses, 3);
  // Not part of any strategy hash.
  assert.ok(!JSON.stringify(config.strategies).includes('maxLossesPerDay'));
});

test('PR4.1 mint guard seeding from trades.jsonl (losing trades today, last result, cooldowns) is idempotent', () => {
  const mg = require('../src/mintGuard');
  const cfg = config.mintGuard;
  const now = Date.parse('2026-11-20T15:10:00Z');
  const trades = [
    { id: 'b', mint: 'SHIT1', symbol: 'SHIT', strategyId: 'momentum-entry', entryTime: '2026-11-20T14:00:00Z', closedAt: '2026-11-20T14:05:00Z', exitReason: 'hard-stop', pnlSol: -0.02 },
    { id: 'a', mint: 'SHIT1', symbol: 'SHIT', strategyId: 'momentum-entry', entryTime: '2026-11-20T13:00:00Z', closedAt: '2026-11-20T13:20:00Z', exitReason: 'sl', pnlSol: -0.012 },
    { id: 'c', mint: 'OLD1', strategyId: 'aggressive-flow', entryTime: '2026-11-19T10:00:00Z', closedAt: '2026-11-19T10:05:00Z', exitReason: 'sl', pnlSol: -0.01 },
    { id: 'c2', mint: 'OLD1', strategyId: 'aggressive-flow', entryTime: '2026-11-19T11:00:00Z', closedAt: '2026-11-19T11:05:00Z', exitReason: 'time', pnlSol: -0.01 },
    { id: 'd', mint: 'TP1', strategyId: 'aggressive-flow', entryTime: '2026-11-20T15:00:00Z', closedAt: '2026-11-20T15:05:00Z', exitReason: 'tp', pnlSol: 0.004 },
    { id: 'l1', mint: 'LOSS2', strategyId: 'momentum-entry', entryTime: '2026-11-20T10:00:00Z', closedAt: '2026-11-20T10:10:00Z', exitReason: 'time', pnlSol: -0.003 },
    { id: 'l2', mint: 'LOSS2', strategyId: 'aggressive-flow', entryTime: '2026-11-20T11:00:00Z', closedAt: '2026-11-20T11:10:00Z', exitReason: 'lock', pnlSol: -0.001 },
    { id: 'w1', mint: 'WIN2', strategyId: 'momentum-entry', entryTime: '2026-11-20T09:00:00Z', closedAt: '2026-11-20T09:10:00Z', exitReason: 'time', pnlSol: -0.003 },
    { id: 'w2', mint: 'WIN2', strategyId: 'momentum-entry', entryTime: '2026-11-20T09:20:00Z', closedAt: '2026-11-20T09:30:00Z', exitReason: 'time', pnlSol: -0.003 },
    { id: 'w3', mint: 'WIN2', strategyId: 'momentum-entry', entryTime: '2026-11-20T09:40:00Z', closedAt: '2026-11-20T09:50:00Z', exitReason: 'tp', pnlSol: 0.02 }
  ];
  const st = { openPositions: [{ id: 'e', mint: 'TP1', entryTime: '2026-11-20T15:06:00Z' }] };
  for (let i = 0; i < 2; i++) {
    const s = mg.seed(st, { trades, openPositions: st.openPositions }, cfg, now);
    assert.deepStrictEqual(s.inCooldown.map(x => x.mint), ['SHIT1']);
    assert.strictEqual(st.mintGuard.entries['2026-11-20'].SHIT1, 2);
    assert.strictEqual(st.mintGuard.entries['2026-11-20'].TP1, 2);
    assert.strictEqual(st.mintGuard.entries['2026-11-20'].OLD1, undefined);
    assert.strictEqual(st.mintGuard.losses['2026-11-20'].SHIT1, 2); // re-seeding does not double count
    assert.strictEqual(st.mintGuard.losses['2026-11-20'].LOSS2, 2);
  }
  assert.strictEqual(mg.check(st, 'SHIT1', cfg, now).reason, 'cooldown');
  assert.strictEqual(mg.check(st, 'SHIT1', cfg, now + 3 * 3600000).reason, 'mint-daily-cap'); // after the cooldown: 2 losses today
  assert.strictEqual(mg.check(st, 'TP1', cfg, now), null);   // 2 entries, last a winner -> free
  assert.strictEqual(mg.check(st, 'LOSS2', cfg, now).reason, 'mint-daily-cap');
  assert.strictEqual(mg.check(st, 'WIN2', cfg, now), null);  // 2 losses then a TP -> may re-enter
  assert.strictEqual(mg.check(st, 'OLD1', cfg, now), null);  // yesterday's losses don't count
});

test('PR4 broken-quote denylist: gap > 50%, no reverse route, NaN/zero output; seeded from trades/events/shadow; permanent', () => {
  const mg = require('../src/mintGuard');
  const cfg = config.mintGuard;
  assert.strictEqual(mg.brokenFromEntrySanity({ gapPct: 3, reasons: ['gap 3%>2%'] }, cfg), null);
  assert.ok(mg.brokenFromEntrySanity({ gapPct: 61, reasons: [] }, cfg));
  assert.ok(mg.brokenFromEntrySanity({ gapPct: null, reasons: ['reverse-no-route'] }, cfg));
  assert.ok(mg.brokenFromEntrySanity({ gapPct: null, reasons: ['gap-uncomputable'] }, cfg));
  assert.ok(mg.brokenFromEntrySanity({ gapPct: null, reasons: [], quotedPriceUsd: 0 }, cfg));
  assert.ok(mg.brokenFromEntrySanity({ gapPct: null, reasons: [], quotedPriceUsd: NaN }, cfg));
  assert.strictEqual(mg.brokenFromEntrySanity({ gapPct: 4, reasons: ['impact 9%>6%'] }, cfg), null);
  assert.ok(mg.brokenFromExitSanity({ gapPct: null, reasons: ['bad-price'] }, cfg));
  assert.strictEqual(mg.brokenFromExitSanity({ gapPct: 20, reasons: ['gap 20%>15%'] }, cfg), null);
  const st = { openPositions: [] };
  const s = mg.seed(st, {
    trades: [{ id: 'r', mint: 'HmBGdetVsQTRHh2wCa4HykUpKA7NJ1B8S16tUpYiWeaZ', symbol: 'RUDY', entryTime: '2026-11-20T11:29:17Z', closedAt: '2026-11-20T11:30:00Z', exitReason: 'sl', entryFillGapPct: 7969422092 },
             { id: 'ok', mint: 'GOOD', symbol: 'G', entryTime: '2026-11-20T11:00:00Z', closedAt: '2026-11-20T11:05:00Z', exitReason: 'tp', entryFillGapPct: 2, exitFillGapPct: -1 }],
    events: [{ type: 'exit-quote-insane', mint: 'EV1', reasons: ['gap 80.00%>15%'], quotedPriceUsd: 1.8, modelPriceUsd: 1 },
             { type: 'exit-quote-failed', source: 'jupiter', noRoute: true, mint: 'EV2' },
             { type: 'exit-quote-failed', source: 'jupiter', noRoute: false, mint: 'EV3' }],
    shadowRows: [{ type: 'shadow-reject', mint: 'SH1', symbol: 'S', detail: 'reverse-no-route', gapPct: 1 },
                 { type: 'shadow-reject', mint: 'SH2', detail: 'impact 9%>6%', gapPct: 2 }]
  }, cfg, Date.parse('2026-11-20T15:10:00Z'));
  const mints = s.brokenQuoteMints.map(b => b.mint).sort();
  assert.deepStrictEqual(mints, ['EV1', 'EV2', 'GjFvarRNRrq5tL6K2qdY7Xv2ZEbVrstqjW1BW4hMpump', 'HmBGdetVsQTRHh2wCa4HykUpKA7NJ1B8S16tUpYiWeaZ', 'SH1'].sort());
  // Denied for every strategy, forever, ahead of cooldown/cap.
  const far = Date.parse('2027-01-01T00:00:00Z');
  assert.strictEqual(mg.check(st, 'GjFvarRNRrq5tL6K2qdY7Xv2ZEbVrstqjW1BW4hMpump', cfg, far).reason, 'broken-quote-denylist');
  assert.strictEqual(mg.check(st, 'GOOD', cfg, far), null);
  assert.strictEqual(mg.addBroken(st, { mint: 'EV1', reason: 'again' }), false); // first reason kept
  assert.ok(!JSON.stringify(config.strategies).includes('seedBrokenMints'));
});

test('PR5 momentum exits: breakeven lock (+3% net peak -> exit at +0.5%), early failure (not +2% by 6 min), max hold 12', () => {
  const ex = stratById('momentum-entry').exit;
  assert.strictEqual(ex.breakevenArmPct, 3); assert.strictEqual(ex.breakevenLockPct, 0.5);
  assert.strictEqual(ex.earlyFailAfterMin, 6); assert.strictEqual(ex.earlyFailMinPeakPct, 2); assert.strictEqual(ex.maxHoldMinutes, 12);
  assert.strictEqual(ex.takeProfitPct, 10); assert.strictEqual(ex.stopLossPct, 6);
  const t0 = Date.parse('2026-11-20T16:00:00Z');
  const P = jh => ({ strategyId: 'momentum-entry', strategyType: 'simple', entryTime: new Date(t0).toISOString(), entryPrice: 1, entryFillPrice: 1, sizeSol: 0.2, remainingFrac: 1, highest: jh, judgedHigh: jh, exit: ex });
  // Breakeven: peak +3.5% net, back to +0.4% at 2 min -> 'breakeven'; at +0.8% -> hold.
  assert.strictEqual(decide(P(1.035), 1.004, true, null, t0 + 120000).reason, 'breakeven');
  assert.strictEqual(decide(P(1.035), 1.008, true, null, t0 + 120000), null);
  // Peak only +2.9%: no breakeven lock.
  assert.strictEqual(decide(P(1.029), 1.0, true, null, t0 + 120000), null);
  // Not within the 30s grace (only the hard stop there).
  assert.strictEqual(decide(P(1.035), 1.0, true, null, t0 + 20000), null);
  // Early failure: peak +1.5% at 6 min -> 'stall' (mint-guard stop reason); peak +2.5% -> hold; 5 min -> hold.
  assert.strictEqual(decide(P(1.015), 1.01, true, null, t0 + 6 * 60000 + 1000).reason, 'stall');
  assert.strictEqual(decide(P(1.015), 1.01, true, null, t0 + 5 * 60000), null);
  assert.strictEqual(decide(P(1.025), 1.02, true, null, t0 + 7 * 60000), null);
  assert.ok(config.mintGuard.stopReasons.includes('stall'));
  // Max hold 12: losing at 12 min after a +2.5% peak -> 'time'; winning -> time trail armed.
  assert.strictEqual(decide(P(1.025), 0.995, true, null, t0 + 12 * 60000 + 1000).reason, 'time');
  assert.strictEqual(decide(P(1.025), 1.02, true, null, t0 + 12 * 60000 + 1000), null);
  // Stale price: only time exits.
  assert.strictEqual(decide(P(1.035), 1.0, false, null, t0 + 120000), null);
});

test('PR5 entry confirmation: 2 consecutive scan up-ticks; NCS delayed re-check (price higher >= 20s later)', () => {
  const ec = require('../src/entryConfirm');
  ec.reset();
  assert.deepStrictEqual(stratById('momentum-entry').entryConfirm, { upTicks: 2 });
  assert.deepStrictEqual(stratById('aggressive-flow').entryConfirm, { upTicks: 2 });
  assert.deepStrictEqual(stratById('ncs_fresh_momentum_v1').entryConfirm, { delaySec: 20 });
  const t = Date.parse('2026-11-20T16:00:00Z');
  ec.record([{ pairAddress: 'P1', priceUsd: 1.0 }, { pairAddress: 'P2', priceUsd: 1.0 }], t);
  assert.ok(!ec.upTickCheck('P1', 2, t).ok); // not enough history
  ec.record([{ pairAddress: 'P1', priceUsd: 1.01 }, { pairAddress: 'P2', priceUsd: 1.01 }], t + 60000);
  ec.record([{ pairAddress: 'P1', priceUsd: 1.02 }, { pairAddress: 'P2', priceUsd: 1.01 }], t + 120000);
  assert.ok(ec.upTickCheck('P1', 2, t + 120000).ok);
  assert.strictEqual(ec.upTickCheck('P2', 2, t + 120000).why, 'not-rising'); // flat tick fails
  ec.record([{ pairAddress: 'P1', priceUsd: 1.015 }], t + 180000);
  assert.ok(!ec.upTickCheck('P1', 2, t + 180000).ok); // down tick resets
  // Same-scan duplicates overwrite instead of counting as a tick.
  ec.record([{ pairAddress: 'P3', priceUsd: 1 }], t); ec.record([{ pairAddress: 'P3', priceUsd: 1.1 }], t + 1000); ec.record([{ pairAddress: 'P3', priceUsd: 1.2 }], t + 2000);
  assert.ok(!ec.upTickCheck('P3', 2, t + 2000).ok);
  // Delayed confirmation.
  assert.strictEqual(ec.delayedCheck('M1', 'P1', 1.0, 20, t).state, 'parked');
  assert.strictEqual(ec.delayedCheck('M1', 'P1', 1.05, 20, t + 10000).state, 'wait');
  const ok = ec.delayedCheck('M1', 'P1', 1.01, 20, t + 21000);
  assert.strictEqual(ok.state, 'ok'); near(ok.chgPct, 1);
  assert.strictEqual(ec.delayedCheck('M2', 'P2', 1.0, 20, t).state, 'parked');
  assert.strictEqual(ec.delayedCheck('M2', 'P2', 1.0, 20, t + 21000).state, 'fail'); // not higher
  assert.strictEqual(ec.delayedCheck('M2', 'P2', 1.0, 20, t + 22000).state, 'parked'); // re-parks on the next pass
  ec.reset();
});

test('PR5 sizes: AF 0.02 SOL; NCS tier A and tier B fixed 0.02 SOL (fixedSol overrides % of equity and tier mult)', () => {
  assert.strictEqual(stratById('aggressive-flow').sizeSol, 0.02);
  const n = stratById('ncs_fresh_momentum_v1');
  assert.strictEqual(n.sizing.fixedSol, 0.02);
  assert.strictEqual(stratById('momentum-entry').sizeSol, 0.2); // unchanged
});

test('PR5.1 shadow momentum-h1ratio: momentum-entry + buySellRatioH1 >= 1.3, shadow only, own hash, same net exits; live hashes frozen', () => {
  const mom = stratById('momentum-entry'), v = stratById('momentum-h1ratio');
  assert.strictEqual(config.strategyHashes['momentum-entry'], 'c1ab00a8e531');
  assert.strictEqual(config.strategyHashes['aggressive-flow'], 'b7f4cc472695');
  assert.strictEqual(config.strategyHashes.ncs_fresh_momentum_v1, 'bf331c3a05d5');
  assert.strictEqual(config.strategyHashes['momentum-h1ratio'], 'cfc41521e67d');
  assert.deepStrictEqual(v.entry, mom.entry.concat([{ field: 'buySellRatioH1', op: '>=', value: 1.3 }]));
  assert.strictEqual(mom.entry.length, 3); // momentum-entry not mutated
  assert.deepStrictEqual(v.exit, mom.exit); assert.strictEqual(v.sizeSol, mom.sizeSol); assert.deepStrictEqual(v.entryConfirm, mom.entryConfirm);
  assert.ok(shadow.isShadow(v) && shadow.isDisabled(v));
  // Signals: same pair -> momentum real, the variant only when h1 ratio >= 1.3, always in the shadow split.
  const P = (buys, sells) => Object.assign(basePair(), { liquidityUsd: 200000, volumeH1: 200000, txns: { buys, sells }, txnsM5: { buys: 30, sells: 20 }, priceChange: { m5: 1, h1: 3, h6: 0, h24: 0 } });
  let split = shadow.splitSignals(generateSignals([P(140, 100)]).signals);
  assert.ok(split.real.some(sg => sg.strategyId === 'momentum-entry'));
  assert.ok(split.shadow.some(sg => sg.strategyId === 'momentum-h1ratio'));
  assert.ok(split.real.every(sg => sg.strategyId !== 'momentum-h1ratio'));
  split = shadow.splitSignals(generateSignals([P(120, 100)]).signals);
  assert.ok(!split.shadow.some(sg => sg.strategyId === 'momentum-h1ratio'));
  // Shadow position: no balance / slots / mint guard; exits judged NET like the live path.
  const st = { balance: 3, openPositions: [] };
  const sig = { strategyId: v.id, strategy: v, mint: 'MH1', pairAddress: 'PH1', symbol: 'H1R' };
  const q = { mint: 'MH1', priceUsd: 1, liquidityUsd: 200000, priceChange: { m5: 1 } };
  const modelFill = fm.fillEntry({ midPrice: 1, sizeSol: 0.2, solUsd: 150, liquidityUsd: 200000 });
  const t0 = Date.now();
  const pos = shadow.open(st, { strat: v, sig, q, modelFill, entryFill: modelFill.price, entryFillSource: 'depth', sizeSol: 0.2, decimals: 6, quote: null }, new Date(t0));
  assert.strictEqual(pos.configHash, 'cfc41521e67d');
  assert.strictEqual(st.balance, 3); assert.strictEqual(st.openPositions.length, 0); assert.strictEqual(st.mintGuard, undefined);
  // Up +4% mid at 2 min (net ~+3.x%) -> breakeven armed; back to mid +0.9% (net < +0.5%) -> breakeven exit.
  assert.strictEqual(shadow.processExits(st, { PH1: { ...q, priceUsd: 1.045 } }, 150, t0 + 120000, () => 0.99).length, 0);
  assert.ok(pos.judgedHigh > 1.03);
  const c = shadow.processExits(st, { PH1: { ...q, priceUsd: 1.009 } }, 150, t0 + 150000, () => 0.99);
  assert.strictEqual(c.length, 1); assert.strictEqual(c[0].exitReason, 'breakeven'); assert.ok(c[0].mfeNetPct > 3);
  // Early fail on a second shadow position: never +2% net by 6 min -> stall.
  st.shadow.cooldowns = {};
  const p2 = shadow.open(st, { strat: v, sig: { ...sig, mint: 'MH2', pairAddress: 'PH2' }, q: { ...q, mint: 'MH2' }, modelFill, entryFill: modelFill.price, entryFillSource: 'depth', sizeSol: 0.2, decimals: 6, quote: null }, new Date(t0));
  assert.strictEqual(shadow.processExits(st, { PH2: { ...q, mint: 'MH2', priceUsd: 1.01 } }, 150, t0 + 300000, () => 0.99).length, 0);
  const c2 = shadow.processExits(st, { PH2: { ...q, mint: 'MH2', priceUsd: 1.01 } }, 150, t0 + 361000, () => 0.99);
  assert.strictEqual(c2.length, 1); assert.strictEqual(c2[0].exitReason, 'stall'); assert.ok(p2.id.startsWith('sh-'));
  assert.strictEqual(st.balance, 3); assert.strictEqual(st.openPositions.length, 0); assert.strictEqual(st.mintGuard, undefined);
  assert.ok(shadow.summary(st)['momentum-h1ratio'].trades === 2);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e.stack || e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
