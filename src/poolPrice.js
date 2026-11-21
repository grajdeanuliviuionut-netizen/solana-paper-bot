// Stored-pool pricing (PR7/PR8). A position's entry fill, every mark, exit check and close fill come
// ONLY from the pool stored on it (pairAddress), through one function: storedPoolPrices(). Source:
// this pass's scan row for that pool if it is fresh (not from a cached 429 page), else GeckoTerminal
// /pools/multi by address. Never another pool of the token or a ticker match.
//
// Main-pool guard (PR8): before a buy, the chosen pool's price is compared with the token's main pool
// (highest liquidity, base token = the mint). Fail closed: unverified -> skip; > 5% off -> skip.
// The main pool comes from its own slow, cached path (DexScreener /tokens/v1, batched, own limiter:
// 1 request in flight, own 429 cooldown; never the scan's queue): pool identity cached 30 min, its
// price 60 s; the scan's own fresh rows are used when they contain the token's main pool.
const httpBackoff = require('./httpBackoff');

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const DS = 'https://api.dexscreener.com/tokens/v1/solana/';
const HEADERS = { accept: 'application/json;version=20230302' };
const PRICE_TTL_MS = 60 * 1000;
const IDENTITY_TTL_MS = 30 * 60 * 1000;

const mainLimiter = httpBackoff.create({ maxConcurrent: 1, minGapMs: 1000, retries: 0, baseDelayMs: 5000, hostCooldownMs: 60000 });
const mainCache = new Map(); // mint -> { pool: { pairAddress, priceUsd, liquidityUsd }, at, identityAt }
const mainStats = { lookups: 0, mintsRequested: 0, failures: 0 };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function poolRow(row) {
  const a = (row && row.attributes) || {};
  const base = row && row.relationships && row.relationships.base_token && row.relationships.base_token.data;
  const mint = base && typeof base.id === 'string' && base.id.startsWith('solana_') ? base.id.slice(7) : null;
  if (!a.address) return null;
  return { pairAddress: a.address, priceUsd: num(a.base_token_price_usd), liquidityUsd: num(a.reserve_in_usd), mint };
}

// The ONE stored-pool price source (entry fill, re-mark, marks, exits). Returns { [pairAddress]: row }
// with rows { pairAddress, priceUsd, liquidityUsd, source: 'scan' | 'pool-fetch' }.
async function storedPoolPrices(addresses, scanPairs) {
  const out = {};
  const want = Array.from(new Set((addresses || []).filter(Boolean)));
  const fresh = {};
  for (const p of scanPairs || []) if (p && p.pairAddress && !p.stale && p.priceUsd > 0) fresh[p.pairAddress] = p;
  const missing = [];
  for (const a of want) {
    if (fresh[a]) out[a] = { pairAddress: a, priceUsd: fresh[a].priceUsd, liquidityUsd: num(fresh[a].liquidityUsd), source: 'scan' };
    else missing.push(a);
  }
  for (let i = 0; i < missing.length; i += 30) {
    const chunk = missing.slice(i, i + 30);
    try {
      const res = await httpBackoff.get(GT + '/pools/multi/' + chunk.join(','), { timeout: 12000, headers: HEADERS });
      for (const row of (res.data && res.data.data) || []) {
        const p = poolRow(row);
        if (p && chunk.includes(p.pairAddress) && p.priceUsd > 0) out[p.pairAddress] = { pairAddress: p.pairAddress, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd, source: 'pool-fetch' };
      }
    } catch (e) {
      console.warn('Stored-pool price fetch failed (' + (e.rateLimited ? '429' : e.message) + '); will retry next tick');
    }
  }
  return out;
}

// Slow path: refresh the main pool for mints whose cached price is older than 60 s. One batched
// DexScreener request (<= 30 mints) per call, own limiter; a 429 only cools this path down.
async function prefetchMain(mints, now) {
  const t = now == null ? Date.now() : now;
  const need = Array.from(new Set((mints || []).filter(Boolean))).filter(m => {
    const c = mainCache.get(m);
    return !c || t - c.at >= PRICE_TTL_MS;
  }).slice(0, 30);
  if (!need.length) return 0;
  mainStats.lookups += 1;
  mainStats.mintsRequested += need.length;
  try {
    const res = await mainLimiter.get(DS + need.join(','), { timeout: 10000 });
    const rows = Array.isArray(res.data) ? res.data : (res.data && res.data.pairs) || [];
    const best = {};
    for (const r of rows) {
      const mint = r && r.baseToken && r.baseToken.address;
      if (!mint || !need.includes(mint) || r.chainId && r.chainId !== 'solana') continue;
      const p = { pairAddress: r.pairAddress, priceUsd: num(r.priceUsd), liquidityUsd: num(r.liquidity && r.liquidity.usd) };
      if (!(p.priceUsd > 0) || !p.pairAddress) continue;
      if (!best[mint] || p.liquidityUsd > best[mint].liquidityUsd) best[mint] = p;
    }
    for (const [mint, pool] of Object.entries(best)) mainCache.set(mint, { pool, at: t, identityAt: t });
    return Object.keys(best).length;
  } catch (e) {
    mainStats.failures += 1;
    return 0;
  }
}

// Main pool for a mint: { pool, verified, source }. Verified when the slow path's price is <= 60 s old,
// or the scan's own fresh rows contain the cached main pool (identity <= 30 min) or a pool of the mint
// with more liquidity than it. Never fetches (prefetchMain does that, once per pass).
function mainPoolFor(mint, scanPairs, now) {
  const t = now == null ? Date.now() : now;
  const c = mainCache.get(mint);
  const scan = (scanPairs || []).filter(p => p && p.mint === mint && !p.stale && p.priceUsd > 0)
    .map(p => ({ pairAddress: p.pairAddress, priceUsd: p.priceUsd, liquidityUsd: num(p.liquidityUsd) }));
  if (c && t - c.identityAt < IDENTITY_TTL_MS) {
    const inScan = scan.find(p => p.pairAddress === c.pool.pairAddress);
    if (inScan) return { pool: inScan, verified: true, source: 'scan' };
    const bigger = scan.find(p => p.liquidityUsd > c.pool.liquidityUsd);
    if (bigger) return { pool: bigger, verified: true, source: 'scan' };
    if (t - c.at < PRICE_TTL_MS) return { pool: c.pool, verified: true, source: 'dexscreener' };
  }
  return { pool: null, verified: false, source: null };
}

function divergencePct(price, mainPrice) {
  if (!(price > 0) || !(mainPrice > 0)) return null;
  return (Math.abs(price - mainPrice) / mainPrice) * 100;
}

function _clearCache() { mainCache.clear(); for (const k of Object.keys(mainStats)) mainStats[k] = 0; mainLimiter._reset(); }

module.exports = { storedPoolPrices, prefetchMain, mainPoolFor, divergencePct, poolRow, mainLimiter, mainStats, _clearCache, PRICE_TTL_MS, IDENTITY_TTL_MS };
