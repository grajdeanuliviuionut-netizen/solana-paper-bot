// t117u + t121u (Liviu 24 Nov): Social Sentiment (social-spike) paper book. Scanner spike maths (DexScreener primary,
// X confirmation only with a token, never exposed), top-3 ranking, $100k liquidity floor, the ~$500 Jupiter sell gate
// (< 1.5%), BUY signal, exits (-10% stop, half at +25%, 10% trail, +50% TP, 240 min), auto size cut, runner-hunter v6.03
// untouched. LIVE config. No network.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbot-social-'));
process.env.STATE_FILE = path.join(TMP, 'state.json');
process.env.TRADES_FILE = path.join(TMP, 'trades.jsonl');
delete process.env.LIVE_TRADING; delete process.env.WALLET_PRIVATE_KEY; delete process.env.RESET_STATE;
delete process.env.SOCIAL_X_BEARER_TOKEN; delete process.env.SOCIAL_SPIKE_ENABLED;
const S = require('../src/books/social');

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const MIN = 60000, HOUR = 3600000;
const NOW = Date.parse('2026-11-24T17:00:00Z');

// ---------- pure ----------
test('spike maths: last 60 min vs the mean hour of the 5 h before (X counts, DexScreener txns and USD volume)', () => {
  const b = [];
  for (let m = 360; m >= 1; m--) b.push({ start: new Date(NOW - m * MIN).toISOString(), end: new Date(NOW - (m - 1) * MIN).toISOString(), tweet_count: m <= 60 ? 3 : 1 });
  const s = S.spikeFromCounts(b, NOW, { baselineHours: 5 });
  assert.strictEqual(s.last1h, 180); assert.strictEqual(s.baselinePerHour, 60); assert.strictEqual(s.spikePct, 200);
  const t = S.spikeFromTxns({ h1: { buys: 300, sells: 300 }, h6: { buys: 1300, sells: 1300 } });
  assert.strictEqual(t.last1h, 600); assert.strictEqual(t.baselinePerHour, 400); assert.strictEqual(t.spikePct, 50);
  const v = S.spikeFromVolume({ h1: 30000, h6: 80000 });
  assert.strictEqual(v.baselinePerHour, 10000); assert.strictEqual(v.spikePct, 200);
});
test('top 3: spike >= +50%, txns floor, liquidity >= $100k, best spike first', () => {
  const c = (mint, spikePct, liq, last1h) => ({ mint, spikePct, liquidityUsd: liq, last1h: last1h == null ? 500 : last1h, minLast1h: 300 });
  const r = S.rankTop([c('A', 49.9, 900000), c('B', 80, 99999), c('C', 120, 100000), c('D', 300, 700000, 100), c('E', 60, 150000), c('F', 70, 1e6), c('G', 400, 2e5)], { minSpikePct: 50, minLiquidityUsd: 100000, topN: 3 });
  assert.deepStrictEqual(r.map(x => x.mint), ['G', 'C', 'F']);
  assert.strictEqual(S.xQuery('BONK'), '$BONK -is:retweet'); assert.strictEqual(S.xQuery('$wif!'), '$wif -is:retweet'); assert.strictEqual(S.xQuery('1'), null);
});

// ---------- runtime ----------
const pair = (mint, sym, liq, h1, h6, vol) => ({ chainId: 'solana', pairAddress: 'P_' + mint, baseToken: { address: mint, symbol: sym, name: sym }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  priceUsd: '0.01', priceNative: '0.00005', liquidity: { usd: liq }, volume: vol || { h1: 1000, m5: 100, h6: 5000, h24: 9000 }, priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
  txns: { m5: { buys: 10, sells: 5 }, h1: { buys: h1, sells: 0 }, h6: { buys: h6, sells: 0 } }, pairCreatedAt: NOW - 30 * HOUR, dexId: 'raydium' });
function mk(env, xHandler) {
  const calls = { ds: [], gt: 0, x: [] };
  let t = NOW;
  const so = S.makeSocial({ env, now: () => t,
    gtGet: async () => { calls.gt++; return { data: { data: ['HOTmint', 'THINmint', 'VOLmint'].map(m => ({ relationships: { base_token: { data: { id: 'solana_' + m } } } })) } }; },
    dsGet: async url => { calls.ds.push(url);
      if (/token-boosts/.test(url)) return { data: [{ chainId: 'solana', tokenAddress: 'BOOSTmint', totalAmount: 500 }, { chainId: 'ethereum', tokenAddress: '0xabc' }] };
      return { data: [pair('HOTmint', 'HOT', 120000, 900, 1900), pair('THINmint', 'THIN', 90000, 900, 1900), pair('BOOSTmint', 'BST', 180000, 400, 2000),
        pair('VOLmint', 'VOL', 300000, 500, 2500, { h1: 50000, m5: 100, h6: 100000, h24: 200000 })] }; },
    http: { get: async (url, o) => { calls.x.push({ url, o }); return xHandler(url, o); } } });
  return { so, calls, adv: ms => { t += ms; } };
}
test('DexScreener mode (no X token): boosts + GT trending, max(txns, volume) spike, $100k floor, labelled NOT X data', async () => {
  const m = mk({});
  await m.so.refresh();
  const v = m.so.snapshot();
  assert.strictEqual(v.mode, 'dexscreener'); assert.strictEqual(v.realXData, false); assert.strictEqual(v.xTokenConfigured, false); assert.strictEqual(v.envVar, 'SOCIAL_X_BEARER_TOKEN');
  assert.ok(/NOT X mentions/.test(v.sourceLabel));
  // HOT: txns 900 vs 200/h -> +350%; VOL: txns +25% but USD volume 50k vs 10k/h -> +400%; THIN: $90k pool; BST: +25%/-
  assert.deepStrictEqual(v.top.map(c => [c.symbol, c.spikePct, c.source]), [['VOL', 400, 'dexscreener'], ['HOT', 350, 'dexscreener']]);
  assert.strictEqual(v.top[0].txnSpikePct, 25); assert.strictEqual(v.top[0].volumeSpikePct, 400);
  assert.ok(m.so.spikeFor('HOTmint')); assert.strictEqual(m.so.spikeFor('THINmint'), null); assert.strictEqual(m.so.spikeFor('BOOSTmint'), null);
  assert.strictEqual(m.calls.x.length, 0, 'no X call without a token');
  assert.strictEqual(m.calls.gt, 1); await m.so.refresh(); assert.strictEqual(m.calls.gt, 1, 'refresh at most every 5 min');
  const rows = await m.so.rows([{ mint: 'VOLmint' }]); assert.deepStrictEqual(rows.map(r => r.mint), ['HOTmint']); assert.ok(rows[0].fetchedAt > 0);
  m.so.recordSignal({ action: 'BUY', symbol: 'HOT' }); assert.strictEqual(m.so.snapshot().signals[0].action, 'BUY');
  m.adv(13 * MIN); assert.strictEqual(m.so.spikeFor('HOTmint'), null, 'a spike older than 12 min is not used');
});
test('with SOCIAL_X_BEARER_TOKEN: a DexScreener spike also needs an X counts spike; token never in the snapshot; cap respected', async () => {
  const TOKEN = 'test-token-not-real-123';
  const counts = (lastPerMin, priorPerMin) => { const b = []; for (let m = 360; m >= 1; m--) b.push({ start: new Date(NOW - m * MIN).toISOString(), end: new Date(NOW - (m - 1) * MIN).toISOString(), tweet_count: m <= 60 ? lastPerMin : priorPerMin }); return { status: 200, data: { data: b, meta: {} } }; };
  const m = mk({ SOCIAL_X_BEARER_TOKEN: TOKEN }, (url, o) => {
    assert.strictEqual(url, 'https://api.x.com/2/tweets/counts/recent'); assert.strictEqual(o.headers.authorization, 'Bearer ' + TOKEN);
    if (o.params.query === '$HOT -is:retweet') return counts(1, 1);       // flat on X -> not confirmed
    if (o.params.query === '$VOL -is:retweet') return counts(2, 1);       // 120 vs 60/h -> +100%
    const e = new Error('402'); e.response = { status: 402 }; throw e;
  });
  await m.so.refresh();
  const v = m.so.snapshot();
  assert.strictEqual(v.mode, 'dexscreener+x'); assert.strictEqual(v.realXData, true);
  assert.ok(!JSON.stringify(v).includes(TOKEN), 'token never exposed');
  assert.deepStrictEqual(v.top.map(c => [c.symbol, c.source, c.spikePct, c.xSpikePct]), [['VOL', 'dexscreener+x', 400, 100]]);
  assert.strictEqual(m.so.spikeFor('HOTmint'), null, 'DexScreener spike without X confirmation cannot enter');
  assert.strictEqual(m.calls.x.length, 2, 'only liquid DexScreener spikes are looked up');
  m.adv(5 * MIN); await m.so.refresh(); assert.strictEqual(m.calls.x.length, 2, 'X results cached 15 min');
  const capped = mk({ SOCIAL_X_BEARER_TOKEN: TOKEN, SOCIAL_X_MAX_REQ_PER_DAY: '0' }, () => { throw new Error('must not call'); });
  await capped.so.refresh(); assert.strictEqual(capped.calls.x.length, 0, 'daily cap respected'); assert.deepStrictEqual(capped.so.snapshot().top, []);
});

// ---------- live config + engine ----------
const config = require('../src/config');
const E = require('../src/books/engine');
const reentry = require('../src/reentry');
const SB = () => config.books.list.find(b => b.id === 'social-spike');
const RH = () => config.books.list.find(b => b.id === 'runner-hunter');
test('live config: Social Sentiment v1 active next to runner-hunter v6.03 (unchanged); liquidity >= $100k, $500 sell gate < 1.5%, stop -10%, half at +25% + 10% trail, TP +50%, 240 min, cap 2, 5% sizing, Boss Rules', () => {
  const b = SB();
  assert.ok(b && !b.paused); assert.strictEqual(b.version, 1); assert.strictEqual(b.name, 'Social Sentiment');
  assert.deepStrictEqual(config.onlyStrategies, ['runner-hunter', 'social-spike']);
  assert.strictEqual(b.entry.minLiquidityUsd, 100000); assert.deepStrictEqual(b.entry.sellGate, { usd: 500, maxSlipPct: 1.5 });
  assert.strictEqual(b.entry.social.minSpikePct, 50); assert.strictEqual(b.entry.social.topN, 3);
  assert.strictEqual(b.exit.stopLossPct, 10); assert.strictEqual(b.exit.takeProfitPct, 50); assert.deepStrictEqual(b.exit.partial, { atPct: 25, sellPct: 50 });
  assert.strictEqual(b.exit.trailAfterPartial, true); assert.strictEqual(b.exit.trailPct, 10); assert.strictEqual(b.exit.breakevenAfterPartial, undefined);
  assert.strictEqual(b.exit.maxHoldMinutes, 240); assert.strictEqual(b.exit.priceBasis, 'entryQuote');
  assert.strictEqual(config.books.maxOpenPerBook, 2); assert.strictEqual(b.entry.sizing.pctOfEquity, 5);
  const r = RH();
  assert.deepStrictEqual(b.entry.rugCheck, r.entry.rugCheck); assert.deepStrictEqual(b.entry.lossStreakPause, r.entry.lossStreakPause); assert.deepStrictEqual(b.entry.nightSkip, r.entry.nightSkip);
  assert.strictEqual(b.entry.stopCooldownHours, 24); assert.strictEqual(b.entry.maxSlippageBps, 150); assert.strictEqual(b.entry.maxTop10Pct, 15);
  assert.deepStrictEqual(b.exit.costModel, r.exit.costModel);
  assert.strictEqual(r.version, 6.03); assert.strictEqual(r.exit.stopLossPct, 2.5); assert.strictEqual(r.entry.minLiquidityUsd, 100000); assert.deepStrictEqual(r.exit.partial, { atPct: 8, sellPct: 50 }); assert.strictEqual(r.entry.sellGate, undefined);
});
test('entry rule: fresh top-3 spike AND liquidity >= $100k ($99,999 rejected, $100,000 accepted)', () => {
  const b = SB();
  const row = o => Object.assign({ mint: 'HOTmint', liquidityUsd: 120000, priceUsd: 0.01 }, o || {});
  const sp = { spikePct: 120, source: 'dexscreener', at: NOW };
  assert.strictEqual(E.entryFails(b, row(), { now: NOW, socialOf: () => sp }), null);
  assert.strictEqual(E.entryFails(b, row({ liquidityUsd: 100000 }), { now: NOW, socialOf: () => sp }), null);
  assert.ok(/^liquidity/.test(E.entryFails(b, row({ liquidityUsd: 99999 }), { now: NOW, socialOf: () => sp })));
  assert.ok(/^liquidity/.test(E.entryFails(b, row({ liquidityUsd: 60000 }), { now: NOW, socialOf: () => sp })), 'old $50k-100k pools rejected');
  assert.ok(/^noSocialSpike/.test(E.entryFails(b, row(), { now: NOW, socialOf: () => null })));
  assert.ok(/^socialSpike/.test(E.entryFails(b, row(), { now: NOW, socialOf: () => ({ spikePct: 40 }) })));
});

const FEE = { microLamports: 3000, sol: 0.0000056, fallback: false, lamports: 5600 };
// Token mid = 0.000005 SOL. Trade size 0.2 SOL (5% of 4); the $500 probe = 2.5 SOL at SOL $200.
function harness(spikes) {
  let t = NOW; const h = { mult: 1.0, trades: [], equity: 4, probeImpact: 0.4, probeMult: 1, solUsd: 200, quoteLog: [], logs: [] };
  const isProbe = sol => sol > 1;
  const quotes = {
    getSolUsd: async () => ({ v: h.solUsd, at: t }),
    buyQuote: async (mint, sol) => { h.quoteLog.push(['buy', sol]); return h.probeBuyFail && isProbe(sol) ? { ok: false, noRoute: true, error: 'no route' } : ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: String(Math.round(sol / 0.05 * 10000000000)), priceImpactPct: 0.5, route: 'Ray' }); },
    sellQuote: async (mint, raw) => { const probe = Number(raw) > 1e11; h.quoteLog.push(['sell', Number(raw)]);
      return { ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * (probe ? h.probeMult : h.mult))), priceImpactPct: probe ? h.probeImpact : 0.4, route: 'Ray' }; }
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const top10 = { check: async () => ({ ok: true, top10Pct: 12, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' }) };
  const m15 = { gt: async () => null, smaGt: async () => null };
  h.signals = [];
  const social = { spikeFor: mint => spikes[mint] || null, recordSignal: s => h.signals.push(s) };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, fees: { current: () => FEE }, social, random: () => 0.5, equityNow: () => h.equity, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; }, log: (ty, sym, r) => h.logs.push([ty, sym, r]) });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() } };
  h.row = o => Object.assign({ pairAddress: 'P_HOT', mint: 'HOTmint', symbol: 'HOT', name: 'Hot', priceUsd: 0.001, priceNative: 0.000005, liquidityUsd: 150000,
    volumeH1: 1000, volumeM5: 100, volumeH6: 6000, volumeH24: 9000, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { buys: 10, sells: 10 }, txnsM5: { buys: 1, sells: 1 },
    pairCreatedAt: NOW - 30 * HOUR, dexId: 'raydium', fetchedAt: t - 5000, ageDays: 1 }, o || {});
  h.enter = async r => { await h.books.runEntries(h.state, [r || h.row()], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'social-spike'); };
  h.pass = async (mult, ms) => { h.mult = mult; t += (ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  h.lastReject = () => (h.state.books.rejects.recent || [])[0] || {};
  return h;
}
const SP = { HOTmint: { mint: 'HOTmint', symbol: 'HOT', spikePct: 180, last1h: 900, baselinePerHour: 320, unit: 'txns/h', source: 'dexscreener', sourceLabel: S.DS_LABEL, rank: 1, at: NOW } };
test('$500 sell gate: $500 -> 2.5 SOL at $200, buy-quote then sell-quote; < 1.5% passes, logged on the signal and the trade, BUY signal emitted', async () => {
  const h = harness(SP);
  const p = await h.enter();
  assert.ok(p, JSON.stringify(h.lastReject()));
  assert.deepStrictEqual(h.quoteLog.slice(0, 2).map(q => q[0]), ['buy', 'sell']); assert.strictEqual(h.quoteLog[0][1], 2.5, '$500 / $200');
  const g = p.sellGate;
  assert.strictEqual(g.pass, true); assert.strictEqual(g.usd, 500); assert.strictEqual(g.solAmount, 2.5); assert.strictEqual(g.solUsdSource, 'jupiter-price');
  assert.strictEqual(g.sellPriceImpactPct, 0.4); assert.ok(Math.abs(g.sellVsMidPct) < 1e-6); assert.strictEqual(g.slipPct, 0.4); assert.strictEqual(g.maxSlipPct, 1.5);
  assert.strictEqual(p.entrySignal.sellGate.slipPct, 0.4); assert.strictEqual(p.signal.action, 'BUY');
  assert.strictEqual(h.signals.length, 1); assert.strictEqual(h.signals[0].action, 'BUY'); assert.strictEqual(h.signals[0].sellGate.slipPct, 0.4);
  assert.ok(h.logs.some(l => l[0] === 'SIGNAL' && /^BUY social-spike v1/.test(l[2])));
  await h.pass(0.89); assert.strictEqual(h.trades[0].sellGate.slipPct, 0.4, 'gate kept on the closed trade');
});
test('$500 sell gate fails closed: impact >= 1.5%, sell 2% under the mid value, no probe route, no SOL price', async () => {
  let h = harness(SP); h.probeImpact = 1.5;
  assert.strictEqual(await h.enter(), undefined); assert.ok(/^sellGate: \$500 sell slippage 1\.50% >= 1\.5%/.test(h.lastReject().reason), h.lastReject().reason);
  h = harness(SP); h.probeMult = 0.98; h.probeImpact = 0.2;
  assert.strictEqual(await h.enter(), undefined); assert.ok(/slippage 2\.00%/.test(h.lastReject().reason), h.lastReject().reason);
  assert.strictEqual(h.signals.length, 0, 'no BUY signal on a failed gate');
  h = harness(SP); h.probeMult = 0.99; h.probeImpact = 0.2;
  assert.ok(await h.enter(), '1.0% under mid passes');
  h = harness(SP); h.probeBuyFail = true;
  assert.strictEqual(await h.enter(), undefined); assert.ok(/probe failed/.test(h.lastReject().reason));
  h = harness(SP); h.solUsd = null;
  const p = await h.enter(); assert.ok(p, 'falls back to DexScreener priceUsd/priceNative'); assert.strictEqual(p.sellGate.solUsdSource, 'dexscreener priceUsd/priceNative'); assert.strictEqual(p.sellGate.solAmount, 2.5);
});
test('exits: -10% stop; half at +25% then the rest trails 10% below its peak; +50% takes the rest; 240 min cap', async () => {
  let h = harness(SP); await h.enter();
  await h.pass(0.91); assert.strictEqual(h.trades.length, 0, '-9%: held');
  await h.pass(0.899); assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.strictEqual(h.trades[0].book, 'social-spike');
  h = harness(SP); await h.enter();
  await h.pass(1.249); assert.strictEqual(h.state.books.open[0].partialDone, false, '+24.9%: no half yet');
  await h.pass(1.251); const p = h.state.books.open[0]; assert.ok(p.partialDone); assert.strictEqual(p.legs[0].sellPctOfOriginal, 50);
  await h.pass(1.40); await h.pass(1.27); assert.strictEqual(h.trades.length, 0, 'peak +40%: trail line +26%');
  await h.pass(1.259); assert.strictEqual(h.trades[0].exitReason, 'trail');
  h = harness(SP); await h.enter(); await h.pass(1.30); await h.pass(1.501); assert.strictEqual(h.trades[0].exitReason, 'tp', '+50% takes the remaining half');
  h = harness(SP); await h.enter(); await h.pass(1.0, 240 * MIN + 1000); assert.strictEqual(h.trades[0].exitReason, 'time');
});
test('sizing: 5% of equity, halved while the 24 h drawdown size cut is active', async () => {
  let h = harness(SP); let p = await h.enter(); assert.strictEqual(p.sizeSol, 0.2);
  h = harness(SP); h.state.sizeCut = { active: true, mult: 0.5 }; p = await h.enter(); assert.strictEqual(p.sizeSol, 0.1); assert.strictEqual(p.sizing.sizeMultiplier, 0.5);
});
test('no spike / pool < $100k / 2-open cap block entries; runner-hunter not opened by social rows', async () => {
  let h = harness({});
  assert.strictEqual(await h.enter(), undefined, 'no spike -> no entry');
  const sp = mint => ({ mint, spikePct: 90, source: 'dexscreener', at: NOW });
  h = harness({ HOTmint: sp('HOTmint') });
  assert.strictEqual(await h.enter(h.row({ liquidityUsd: 99999 })), undefined, 'liquidity < $100k');
  assert.strictEqual(h.quoteLog.length, 0, 'no Jupiter probe for a thin pool');
  h = harness({ A: sp('A'), B: sp('B'), C: sp('C') });
  await h.books.runEntries(h.state, ['A', 'B', 'C'].map(m => h.row({ mint: m, pairAddress: 'P' + m, symbol: m })), async () => ({ ok: true }));
  assert.strictEqual(h.state.books.open.filter(p => p.book === 'social-spike').length, 2, 'max 2 open');
  assert.ok(!h.state.books.open.some(p => p.book === 'runner-hunter'));
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' social tests passed');
  if (passed !== tests.length) process.exit(1);
})();
