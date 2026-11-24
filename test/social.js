// t117u (Liviu 24 Nov): social-spike paper book. Social Scanner spike maths, top-3 ranking, proxy vs real-X modes
// (token never exposed), live config (stop -10%, TP +50%, liquidity > $50k, cap 2, 5% sizing, runner-hunter v6.03
// untouched) and the engine path (entry gates, -10% stop, +50% take profit). LIVE config. No network.
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
test('spike maths: last 60 min vs the mean hour of the 5 h before (X counts and DexScreener txns)', () => {
  const b = [];
  for (let m = 360; m >= 1; m--) b.push({ start: new Date(NOW - m * MIN).toISOString(), end: new Date(NOW - (m - 1) * MIN).toISOString(), tweet_count: m <= 60 ? 3 : 1 });
  const s = S.spikeFromCounts(b, NOW, { baselineHours: 5 });
  assert.strictEqual(s.last1h, 180); assert.strictEqual(s.baselinePerHour, 60); assert.strictEqual(s.spikePct, 200);
  const t = S.spikeFromTxns({ h1: { buys: 300, sells: 300 }, h6: { buys: 1300, sells: 1300 } });
  assert.strictEqual(t.last1h, 600); assert.strictEqual(t.baselinePerHour, 400); assert.strictEqual(t.spikePct, 50);
  assert.strictEqual(S.spikeFromTxns({ h1: { buys: 5, sells: 0 }, h6: { buys: 5, sells: 0 } }).spikePct, 400, 'baseline floor 1/h (absolute floor handles tiny counts)');
});
test('top 3: spike >= +50%, absolute floor, liquidity > $50k, best spike first', () => {
  const c = (mint, spikePct, liq, last1h) => ({ mint, spikePct, liquidityUsd: liq, last1h: last1h == null ? 500 : last1h, minLast1h: 300 });
  const r = S.rankTop([c('A', 49.9, 90000), c('B', 80, 50000), c('C', 120, 60000), c('D', 300, 70000, 100), c('E', 60, 51000), c('F', 70, 1e6), c('G', 400, 2e5)], { minSpikePct: 50, minLiquidityUsd: 50000, topN: 3 });
  assert.deepStrictEqual(r.map(x => x.mint), ['G', 'C', 'F']);
  assert.strictEqual(S.xQuery('BONK'), '$BONK -is:retweet'); assert.strictEqual(S.xQuery('$wif!'), '$wif -is:retweet'); assert.strictEqual(S.xQuery('1'), null);
});

// ---------- runtime ----------
const pair = (mint, sym, liq, h1, h6) => ({ chainId: 'solana', pairAddress: 'P_' + mint, baseToken: { address: mint, symbol: sym, name: sym }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  priceUsd: '0.01', priceNative: '0.00005', liquidity: { usd: liq }, volume: { h1: 1000, m5: 100, h6: 5000, h24: 9000 }, priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
  txns: { m5: { buys: 10, sells: 5 }, h1: { buys: h1, sells: 0 }, h6: { buys: h6, sells: 0 } }, pairCreatedAt: NOW - 30 * HOUR, dexId: 'raydium' });
function mk(env, xHandler) {
  const calls = { ds: [], gt: 0, x: [] };
  let t = NOW;
  const so = S.makeSocial({ env, now: () => t,
    gtGet: async () => { calls.gt++; return { data: { data: [{ relationships: { base_token: { data: { id: 'solana_HOTmint' } } } }, { relationships: { base_token: { data: { id: 'solana_THINmint' } } } }] } }; },
    dsGet: async url => { calls.ds.push(url);
      if (/token-boosts/.test(url)) return { data: [{ chainId: 'solana', tokenAddress: 'BOOSTmint', totalAmount: 500 }, { chainId: 'ethereum', tokenAddress: '0xabc' }] };
      return { data: [pair('HOTmint', 'HOT', 120000, 900, 1900), pair('THINmint', 'THIN', 40000, 900, 1900), pair('BOOSTmint', 'BST', 80000, 400, 2000)] }; },
    http: { get: async (url, o) => { calls.x.push({ url, o }); return xHandler(url, o); } } });
  return { so, calls, adv: ms => { t += ms; } };
}
test('proxy mode (no X token): attention set = GT trending + DS boosts, txns spike, $50k floor, labelled NOT X data', async () => {
  const m = mk({});
  await m.so.refresh();
  const v = m.so.snapshot();
  assert.strictEqual(v.mode, 'proxy'); assert.strictEqual(v.realXData, false); assert.strictEqual(v.xTokenConfigured, false); assert.strictEqual(v.envVar, 'SOCIAL_X_BEARER_TOKEN');
  assert.ok(/NOT X mentions/.test(v.proxyLabel));
  // HOT: h1 900 vs (1900-900)/5 = 200/h -> +350%; THIN: same spike but $40k pool; BST: 400 vs 320/h -> +25%
  assert.deepStrictEqual(v.top.map(c => [c.symbol, c.spikePct, c.source]), [['HOT', 350, 'proxy']]);
  assert.ok(m.so.spikeFor('HOTmint')); assert.strictEqual(m.so.spikeFor('THINmint'), null); assert.strictEqual(m.so.spikeFor('BOOSTmint'), null);
  assert.strictEqual(m.calls.x.length, 0, 'no X call without a token');
  assert.strictEqual(m.calls.gt, 1); await m.so.refresh(); assert.strictEqual(m.calls.gt, 1, 'refresh at most every 5 min');
  const rows = await m.so.rows([]); assert.deepStrictEqual(rows.map(r => r.mint), ['HOTmint']); assert.ok(rows[0].fetchedAt > 0);
  assert.deepStrictEqual(await m.so.rows([{ mint: 'HOTmint' }]), [], 'already in the scan -> no extra fetch');
  m.adv(13 * MIN); assert.strictEqual(m.so.spikeFor('HOTmint'), null, 'a spike older than 12 min is not used');
});
test('X mode (SOCIAL_X_BEARER_TOKEN set): real X counts drive the spike; token never in the snapshot; failures fall back to no entry', async () => {
  const TOKEN = 'test-token-not-real-123';
  const counts = (lastPerMin, priorPerMin) => { const b = []; for (let m = 360; m >= 1; m--) b.push({ start: new Date(NOW - m * MIN).toISOString(), end: new Date(NOW - (m - 1) * MIN).toISOString(), tweet_count: m <= 60 ? lastPerMin : priorPerMin }); return { status: 200, data: { data: b, meta: {} } }; };
  const m = mk({ SOCIAL_X_BEARER_TOKEN: TOKEN }, (url, o) => {
    assert.strictEqual(url, 'https://api.x.com/2/tweets/counts/recent'); assert.strictEqual(o.headers.authorization, 'Bearer ' + TOKEN);
    assert.strictEqual(o.params.granularity, 'minute');
    if (o.params.query === '$HOT -is:retweet') return counts(1, 1);       // flat on X: 60 vs 60/h -> 0%
    if (o.params.query === '$BST -is:retweet') return counts(2, 1);       // 120 vs 60/h -> +100%
    const e = new Error('402'); e.response = { status: 402 }; throw e;
  });
  await m.so.refresh();
  const v = m.so.snapshot();
  assert.strictEqual(v.mode, 'x-api'); assert.strictEqual(v.realXData, true);
  assert.ok(!JSON.stringify(v).includes(TOKEN), 'token never exposed');
  assert.deepStrictEqual(v.top.map(c => [c.symbol, c.source, c.spikePct, c.unit]), [['BST', 'x-api', 100, 'posts/h']]);
  assert.strictEqual(m.so.spikeFor('HOTmint'), null, 'proxy spike alone cannot enter in X mode');
  assert.strictEqual(m.calls.x.length, 2, 'only liquid candidates are looked up');
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
test('live config: social-spike v1 active next to runner-hunter v6.03 (unchanged); stop -10%, TP +50%, liquidity > $50k, cap 2, 5% sizing, Boss Rules', () => {
  const b = SB();
  assert.ok(b && !b.paused); assert.strictEqual(b.version, 1);
  assert.deepStrictEqual(config.onlyStrategies, ['runner-hunter', 'social-spike']);
  assert.strictEqual(b.exit.stopLossPct, 10); assert.strictEqual(b.exit.takeProfitPct, 50); assert.strictEqual(b.exit.maxHoldMinutes, 240); assert.strictEqual(b.exit.priceBasis, 'entryQuote');
  assert.strictEqual(b.exit.partial, undefined); assert.strictEqual(b.exit.trailPct, undefined);
  assert.strictEqual(b.entry.minLiquidityUsd, 50000); assert.strictEqual(b.entry.social.minSpikePct, 50); assert.strictEqual(b.entry.social.topN, 3);
  assert.strictEqual(config.books.maxOpenPerBook, 2); assert.strictEqual(b.entry.sizing.pctOfEquity, 5);
  const r = RH();
  assert.deepStrictEqual(b.entry.rugCheck, r.entry.rugCheck); assert.deepStrictEqual(b.entry.lossStreakPause, r.entry.lossStreakPause); assert.deepStrictEqual(b.entry.nightSkip, r.entry.nightSkip);
  assert.strictEqual(b.entry.stopCooldownHours, 24); assert.strictEqual(b.entry.maxSlippageBps, 150); assert.strictEqual(b.entry.maxTop10Pct, 15);
  assert.deepStrictEqual(b.exit.costModel, r.exit.costModel);
  assert.strictEqual(r.version, 6.03); assert.strictEqual(r.exit.stopLossPct, 2.5); assert.strictEqual(r.entry.minLiquidityUsd, 100000); assert.deepStrictEqual(r.exit.partial, { atPct: 8, sellPct: 50 });
  assert.strictEqual(config.halt.enabled, true); assert.strictEqual(config.halt.dropPct, 5);
});
test('entry rule: fresh top-3 spike AND liquidity > $50k (DexScreener row)', () => {
  const b = SB();
  const row = o => Object.assign({ mint: 'HOTmint', liquidityUsd: 120000, priceUsd: 0.01 }, o || {});
  const sp = { spikePct: 120, source: 'proxy', at: NOW };
  assert.strictEqual(E.entryFails(b, row(), { now: NOW, socialOf: () => sp }), null);
  assert.ok(/^liquidity/.test(E.entryFails(b, row({ liquidityUsd: 50000 }), { now: NOW, socialOf: () => sp })));
  assert.ok(/^noSocialSpike/.test(E.entryFails(b, row(), { now: NOW, socialOf: () => null })));
  assert.ok(/^noSocialSpike/.test(E.entryFails(b, row(), { now: NOW })));
  assert.ok(/^socialSpike/.test(E.entryFails(b, row(), { now: NOW, socialOf: () => ({ spikePct: 40 }) })));
});

const FEE = { microLamports: 3000, sol: 0.0000056, fallback: false, lamports: 5600 };
function harness(spikes) {
  let t = NOW; const h = { mult: 1.0, trades: [], equity: 4 };
  const quotes = {
    buyQuote: async (mint, sol) => ({ ok: true, at: t, inAmount: String(Math.round(sol * 1e9)), outAmount: String(Math.round(sol / 0.05 * 10000000000)), priceImpactPct: 0.5, route: 'Ray' }),
    sellQuote: async (mint, raw) => ({ ok: true, at: t, inAmount: String(raw), outAmount: String(Math.floor(Number(raw) * 5e-3 * h.mult)), priceImpactPct: 0.4, route: 'Ray' })
  };
  const mintAuth = { check: async () => ({ pass: true, reason: 'mint+freeze revoked', mintAuthority: null, freezeAuthority: null, decimals: 6, program: 'spl-token', checkedAt: 'x', source: 'test' }) };
  const top10 = { check: async () => ({ ok: true, top10Pct: 12, mintAuthority: null, freezeAuthority: null, source: 'rugcheck' }) };
  const m15 = { gt: async () => null, smaGt: async () => null };
  const social = { spikeFor: mint => spikes[mint] || null };
  h.books = E.makeBooks({ config, quotes, mintAuth, reentry, top10, m15, fees: { current: () => FEE }, social, random: () => 0.5, equityNow: () => h.equity, saveTrade: tr => h.trades.push(tr), now: () => t, sleep: async ms => { t += ms; } });
  h.state = { balance: 3, reentryCooldowns: {}, openPositions: [], scoreboard: { epoch: 'runner-v6', since: new Date(NOW - MIN).toISOString() } };
  h.row = o => Object.assign({ pairAddress: 'P_HOT', mint: 'HOTmint', symbol: 'HOT', name: 'Hot', priceUsd: 0.0011, priceNative: 0.000005, liquidityUsd: 80000,
    volumeH1: 1000, volumeM5: 100, volumeH6: 6000, volumeH24: 9000, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { buys: 10, sells: 10 }, txnsM5: { buys: 1, sells: 1 },
    pairCreatedAt: NOW - 30 * HOUR, dexId: 'raydium', fetchedAt: t - 5000, ageDays: 1 }, o || {});
  h.enter = async r => { await h.books.runEntries(h.state, [r || h.row()], async () => ({ ok: true })); return h.state.books.open.find(p => p.book === 'social-spike'); };
  h.pass = async (mult, ms) => { h.mult = mult; t += (ms == null ? 5000 : ms); await h.books.runExits(h.state); };
  return h;
}
test('engine: social-spike opens at 5% of equity with the spike on the trade; -10% move stops, +50% takes profit', async () => {
  const sp = { HOTmint: { mint: 'HOTmint', symbol: 'HOT', spikePct: 180, last1h: 900, baselinePerHour: 320, unit: 'txns/h', source: 'proxy', sourceLabel: S.PROXY_LABEL, rank: 1, at: NOW } };
  let h = harness(sp);
  const p = await h.enter();
  assert.ok(p, JSON.stringify(h.state.books.rejects.recent.slice(0, 3)));
  assert.strictEqual(p.sizeSol, 0.2, '5% of 4 SOL'); assert.strictEqual(p.exit.stopLossPct, 10); assert.strictEqual(p.exit.takeProfitPct, 50);
  assert.strictEqual(p.entrySignal.socialSpikePct, 180); assert.strictEqual(p.entrySignal.socialSource, 'proxy'); assert.strictEqual(p.entrySignal.socialRealX, false);
  assert.ok(!h.state.books.open.some(x => x.book === 'runner-hunter'), 'runner-hunter rules unaffected (no MA data -> no runner entry)');
  await h.pass(0.91); assert.strictEqual(h.trades.length, 0, '-9%: held');
  await h.pass(0.899); assert.strictEqual(h.trades.length, 1); assert.strictEqual(h.trades[0].exitReason, 'sl'); assert.strictEqual(h.trades[0].book, 'social-spike');
  h = harness(sp); await h.enter(); await h.pass(1.49); assert.strictEqual(h.trades.length, 0, '+49%: held');
  await h.pass(1.501); assert.strictEqual(h.trades[0].exitReason, 'tp');
  h = harness(sp); await h.enter(); await h.pass(1.0, 240 * MIN + 1000); assert.strictEqual(h.trades[0].exitReason, 'time');
});
test('engine: no spike / thin pool / halt / 2-open cap block social-spike entries', async () => {
  let h = harness({});
  assert.strictEqual(await h.enter(), undefined, 'no spike -> no entry');
  const sp = mint => ({ mint, spikePct: 90, source: 'proxy', at: NOW });
  h = harness({ HOTmint: sp('HOTmint') });
  assert.strictEqual(await h.enter(h.row({ liquidityUsd: 49000 })), undefined, 'liquidity <= $50k');
  h = harness({ HOTmint: sp('HOTmint') }); h.state.halt = { halted: true, reason: 'test' };
  assert.strictEqual(await h.enter(), undefined, 'halt blocks');
  h = harness({ A: sp('A'), B: sp('B'), C: sp('C') });
  await h.books.runEntries(h.state, ['A', 'B', 'C'].map(m => h.row({ mint: m, pairAddress: 'P' + m, symbol: m })), async () => ({ ok: true }));
  assert.strictEqual(h.state.books.open.filter(p => p.book === 'social-spike').length, 2, 'max 2 open');
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' social tests passed');
  if (passed !== tests.length) process.exit(1);
})();
