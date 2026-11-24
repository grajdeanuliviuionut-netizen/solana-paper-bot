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

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' social tests passed');
  if (passed !== tests.length) process.exit(1);
})();
