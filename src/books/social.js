// t117u (Liviu 24 Nov): Social Scanner for the "social-spike" PAPER book. Paper only: it reads public data, never
// a wallet, key or LIVE_TRADING; Jupiter stays quote-only in the engine.
//
// Every refreshMs (5 min) it builds the attention set (GeckoTerminal solana trending_pools + DexScreener token
// boosts latest/top), reads one DexScreener tokens batch for those mints (liquidity, pair, price, txns) and scores a
// "social volume" spike per mint:
//   spikePct = (volume in the last 60 min / baseline - 1) x 100, baseline = mean hourly volume of the 5 hours before
//   (window -6 h .. -1 h). A spike needs spikePct >= minSpikePct (50) and an absolute floor in the last hour.
// Volume source, per refresh:
//   * 'x-api' (REAL X mentions) when env SOCIAL_X_BEARER_TOKEN is set: GET api.x.com/2/tweets/counts/recent with
//     query "$SYMBOL -is:retweet", granularity minute, last 6 h (pay-per-use: $0.005 per request). At most
//     xLookupsPerRefresh mints per refresh, each cached xCacheMin, hard cap SOCIAL_X_MAX_REQ_PER_DAY (default 288
//     -> <= ~$1.44/day). The token is read from env only, never logged or returned.
//   * 'proxy' (NOT X data) otherwise, or for a mint whose X lookup failed: on-chain activity from DexScreener txns
//     (h1 vs (h6 - h1) / 5) restricted to the attention set above. Labelled as a substitute on every row.
// Top 3 by spikePct (liquidity > $50k) become the book's candidates; the engine applies every other gate.
const axios = require('axios');
const dataFetcher = require('../dataFetcher');

const GT_TRENDING = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h';
const DS = 'https://api.dexscreener.com';
const BOOSTS = [DS + '/token-boosts/latest/v1', DS + '/token-boosts/top/v1'];
const TOKENS = DS + '/tokens/v1/solana/';
const X_COUNTS = 'https://api.x.com/2/tweets/counts/recent';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN = 60000, HOUR = 3600000;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const PROXY_LABEL = 'proxy: DexScreener txns h1 vs prior 5 h, attention set = GeckoTerminal trending + DexScreener boosts (substitute, NOT X mentions)';

// ---------- pure ----------
// buckets: [{ start, end, tweet_count }] (X counts). Last 60 min vs mean hourly of the 5 h before.
function spikeFromCounts(buckets, now, o) {
  o = o || {};
  const base = o.baselineHours || 5;
  let last = 0, prior = 0;
  for (const b of buckets || []) {
    const s = Date.parse(b.start), e = Date.parse(b.end), c = num(b.tweet_count);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    const mid = (s + e) / 2;
    if (mid > now - HOUR && mid <= now) last += c;
    else if (mid > now - (base + 1) * HOUR && mid <= now - HOUR) prior += c;
  }
  const baseline = prior / base;
  return spike(last, baseline, o);
}
// DexScreener raw pair txns { h1: {buys, sells}, h6: {...} }: h1 vs the mean hour of the 5 before.
function spikeFromTxns(txns, o) {
  const t = txns || {};
  const h1 = num(t.h1 && t.h1.buys) + num(t.h1 && t.h1.sells);
  const h6 = num(t.h6 && t.h6.buys) + num(t.h6 && t.h6.sells);
  return spike(h1, Math.max(0, h6 - h1) / 5, o);
}
function spike(last, baseline, o) {
  o = o || {};
  const floor = o.baselineFloor || 1;
  const b = Math.max(baseline, floor);
  return { last1h: last, baselinePerHour: +baseline.toFixed(2), spikePct: +(((last / b) - 1) * 100).toFixed(1) };
}
// cands: [{ mint, liquidityUsd, spikePct, last1h, minLast1h }] -> top N passing (spike, floor, liquidity), best first.
function rankTop(cands, cfg) {
  return (cands || []).filter(c => c && c.spikePct >= cfg.minSpikePct && c.last1h >= (c.minLast1h || 0) && num(c.liquidityUsd) > cfg.minLiquidityUsd)
    .sort((a, b) => b.spikePct - a.spikePct || b.last1h - a.last1h).slice(0, cfg.topN);
}
function xQuery(symbol) {
  const s = String(symbol || '').replace(/[^A-Za-z0-9_]/g, '');
  if (s.length < 2 || s.length > 15 || /^\d+$/.test(s)) return null;
  return '$' + s + ' -is:retweet';
}

// ---------- runtime ----------
function makeSocial(opts) {
  opts = opts || {};
  const cfg = Object.assign({ refreshMs: 5 * MIN, maxAgeMin: 12, minSpikePct: 50, minLiquidityUsd: 50000, topN: 3, baselineHours: 5,
    minMentions1h: 20, minTxns1h: 300, xLookupsPerRefresh: 5, xCacheMin: 15, maxAttention: 60 }, opts.cfg || {});
  const env = opts.env || process.env;
  const http = opts.http || axios;
  const nowFn = opts.now || Date.now;
  const dsGet = opts.dsGet || ((url, tag) => require('../poolPrice').mainLimiter.get(url, { timeout: 10000 }, tag));
  const gtGet = opts.gtGet || (url => (opts.limiter ? opts.limiter.get('gecko', url, { headers: { accept: 'application/json' } }) : http.get(url, { timeout: 10000, headers: { accept: 'application/json' } })));
  const xToken = () => String(env.SOCIAL_X_BEARER_TOKEN || '').trim();
  const xDailyCap = () => Math.max(0, parseInt(env.SOCIAL_X_MAX_REQ_PER_DAY || '288', 10) || 0);
  const stats = { refreshes: 0, lastRefreshAt: null, lastError: null, attention: 0, scored: 0, spikes: 0, gtCalls: 0, gtFailures: 0, dsCalls: 0, dsFailures: 0,
    xCalls: 0, xFailures: 0, xLastStatus: null, xDay: null, xToday: 0, rowFetches: 0 };
  const xCache = new Map();   // mint -> { at, r }
  let top = [], all = [], lastRefresh = 0, inFlight = null;

  function mode() { return xToken() ? 'x-api' : 'proxy'; }

  async function xCounts(symbol, t) {
    const q = xQuery(symbol);
    if (!q) return { error: 'symbol not searchable' };
    const day = new Date(t).toISOString().slice(0, 10);
    if (stats.xDay !== day) { stats.xDay = day; stats.xToday = 0; }
    if (stats.xToday >= xDailyCap()) return { error: 'daily X request cap reached' };
    const start = new Date(t - (cfg.baselineHours + 1) * HOUR + 30000).toISOString();
    let buckets = [], token = null, pages = 0;
    do {
      stats.xCalls++; stats.xToday++; pages++;
      try {
        const params = { query: q, granularity: 'minute', start_time: start };
        if (token) params.next_token = token;
        const res = await http.get(X_COUNTS, { params, timeout: 10000, headers: { authorization: 'Bearer ' + xToken() } });
        stats.xLastStatus = res.status || 200;
        buckets = buckets.concat((res.data && res.data.data) || []);
        token = res.data && res.data.meta && res.data.meta.next_token;
      } catch (e) {
        stats.xFailures++; stats.xLastStatus = (e.response && e.response.status) || String(e.message || 'error').slice(0, 40);
        return { error: 'X counts ' + stats.xLastStatus };
      }
    } while (token && pages < 3 && stats.xToday < xDailyCap());
    return Object.assign(spikeFromCounts(buckets, t, cfg), { query: q, pages });
  }

  async function attentionSet() {
    const seen = new Map();   // mint -> { gtRank, boost }
    try {
      stats.gtCalls++;
      const res = await gtGet(GT_TRENDING);
      ((res.data && res.data.data) || []).forEach((p, i) => {
        const id = p && p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
        const m = id ? String(id).replace(/^solana_/, '') : null;
        if (m && m !== SOL_MINT) seen.set(m, Object.assign(seen.get(m) || {}, { gtRank: i + 1 }));
      });
    } catch (e) { stats.gtFailures++; }
    for (const url of BOOSTS) {
      try {
        stats.dsCalls++;
        const res = await dsGet(url, 'social');
        for (const x of (Array.isArray(res.data) ? res.data : [])) {
          if (!x || x.chainId !== 'solana' || !x.tokenAddress || x.tokenAddress === SOL_MINT) continue;
          const o = seen.get(x.tokenAddress) || {};
          o.boost = Math.max(num(o.boost), num(x.totalAmount || x.amount));
          seen.set(x.tokenAddress, o);
        }
      } catch (e) { stats.dsFailures++; }
    }
    return Array.from(seen.entries()).slice(0, cfg.maxAttention);
  }

  async function dsRaw(mints) {
    const out = [];
    for (let i = 0; i < mints.length; i += 30) {
      try {
        stats.dsCalls++;
        const res = await dsGet(TOKENS + mints.slice(i, i + 30).join(','), 'social');
        for (const r of (Array.isArray(res.data) ? res.data : (res.data && res.data.pairs) || [])) out.push(r);
      } catch (e) { stats.dsFailures++; }
    }
    return out;
  }
  // Highest-liquidity SOL pool per mint, keeping the raw pair (txns h1/h6) next to the mapped scan row.
  function bestByMint(raw, t) {
    const best = {};
    for (const r of raw) {
      const row = dataFetcher.mapDsPair(r, t);
      if (!row || !(row.priceUsd > 0)) continue;
      if (!best[row.mint] || row.liquidityUsd > best[row.mint].row.liquidityUsd) best[row.mint] = { row, raw: r };
    }
    return best;
  }

  async function refreshInner() {
    const t = nowFn();
    stats.refreshes++; stats.lastRefreshAt = new Date(t).toISOString(); stats.lastError = null;
    const att = await attentionSet();
    stats.attention = att.length;
    const meta = new Map(att);
    const best = bestByMint((await dsRaw(att.map(a => a[0]))).filter(r => r && r.baseToken && meta.has(r.baseToken.address)), t);
    const scored = [];
    for (const [mint, b] of Object.entries(best)) {
      const s = spikeFromTxns(b.raw.txns, cfg);
      scored.push(Object.assign({ mint, symbol: b.row.symbol, pairAddress: b.row.pairAddress, liquidityUsd: b.row.liquidityUsd, source: 'proxy', sourceLabel: PROXY_LABEL, minLast1h: cfg.minTxns1h, unit: 'txns/h' }, s, meta.get(mint) || {}));
    }
    if (mode() === 'x-api') {
      // Real X mentions for the most active liquid candidates (proxy order), cached per mint.
      const pick = scored.filter(c => c.liquidityUsd > cfg.minLiquidityUsd).sort((a, b) => b.spikePct - a.spikePct || b.last1h - a.last1h);
      let lookups = 0;
      for (const c of pick) {
        let ce = xCache.get(c.mint);
        if (!ce || t - ce.at > cfg.xCacheMin * MIN) {
          if (lookups >= cfg.xLookupsPerRefresh) continue;
          lookups++;
          ce = { at: t, r: await xCounts(c.symbol, t) };
          xCache.set(c.mint, ce);
        }
        if (ce.r && !ce.r.error) Object.assign(c, { source: 'x-api', sourceLabel: 'X API recent counts (' + ce.r.query + ')', last1h: ce.r.last1h, baselinePerHour: ce.r.baselinePerHour, spikePct: ce.r.spikePct, minLast1h: cfg.minMentions1h, unit: 'posts/h', proxySpikePct: c.spikePct });
        else c.xError = ce.r && ce.r.error;
      }
      for (const [m, ce] of xCache) if (t - ce.at > 6 * HOUR) xCache.delete(m);
      // In X mode only real X spikes trade; mints without X data stay visible but cannot enter.
      for (const c of scored) if (c.source !== 'x-api') c.minLast1h = Infinity;
    }
    stats.scored = scored.length;
    all = scored.sort((a, b) => b.spikePct - a.spikePct).slice(0, 15).map(c => Object.assign(c, { at: t }));
    top = rankTop(scored, cfg).map((c, i) => Object.assign(c, { rank: i + 1, at: t }));
    stats.spikes = top.length;
    lastRefresh = t;
  }
  function refresh(force) {
    const t = nowFn();
    if (inFlight) return inFlight;
    if (!force && lastRefresh && t - lastRefresh < cfg.refreshMs) return Promise.resolve(false);
    inFlight = refreshInner().catch(e => { stats.lastError = String(e.message || e).slice(0, 120); }).then(() => { inFlight = null; return true; });
    return inFlight;
  }
  // Current spike info for a mint (null when not in the fresh top N).
  function spikeFor(mint) {
    const t = nowFn();
    const c = top.find(x => x.mint === mint);
    return c && t - c.at <= cfg.maxAgeMin * MIN ? c : null;
  }
  // Fresh DexScreener rows (fetchedAt now) for top-N mints missing from this scan, so the <= 30 s row rule holds.
  async function rows(scanPairs) {
    const t = nowFn();
    const live = top.filter(c => t - c.at <= cfg.maxAgeMin * MIN);
    const inScan = new Set((scanPairs || []).filter(r => r && !r.stale).map(r => r.mint));
    const need = live.map(c => c.mint).filter(m => !inScan.has(m));
    if (!need.length) return [];
    stats.rowFetches++;
    const best = bestByMint(await dsRaw(need), t);
    const want = new Set(need);
    return Object.values(best).filter(b => want.has(b.row.mint)).map(b => b.row);
  }
  function snapshot() {
    return { mode: mode(), realXData: mode() === 'x-api', xTokenConfigured: !!xToken(), envVar: 'SOCIAL_X_BEARER_TOKEN', xDailyCap: xDailyCap(),
      spikeDefinition: 'last 60 min vs mean hourly of the prior ' + cfg.baselineHours + ' h; enter on >= +' + cfg.minSpikePct + '% and liquidity > $' + cfg.minLiquidityUsd + ', top ' + cfg.topN,
      proxyLabel: PROXY_LABEL, refreshSec: cfg.refreshMs / 1000, stats: Object.assign({}, stats), top, watch: all };
  }
  return { refresh, spikeFor, rows, snapshot, mode, _cfg: cfg };
}

module.exports = { makeSocial, spikeFromCounts, spikeFromTxns, rankTop, xQuery, PROXY_LABEL };
