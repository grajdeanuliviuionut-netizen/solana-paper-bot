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

(async () => {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n    ', String(e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(passed + '/' + tests.length + ' social tests passed');
  if (passed !== tests.length) process.exit(1);
})();
