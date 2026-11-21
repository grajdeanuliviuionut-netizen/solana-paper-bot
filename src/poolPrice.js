// Stored-pool pricing (PR7/PR8). A position's entry fill, every mark, exit check and close fill come
// ONLY from the pool stored on it (pairAddress), through one function: storedPoolPrices(). Source:
// this pass's scan row for that pool if it is fresh (not from a cached 429 page), else DexScreener by
// pair address (PR9, own limiter), else GeckoTerminal /pools/multi (legacy positions only). Never another pool of the token or a ticker match.
//
// Main-pool guard (PR8): before a buy, the chosen pool's price is compared with the token's main pool
// (highest liquidity, base token = the mint). Fail closed: unverified -> skip; > 5% off -> skip.
// The main pool comes from its own slow, cached path (DexScreener /tokens/v1, batched, own limiter:
// 1 request in flight, own 429 cooldown; never the scan's queue): pool identity cached 30 min, its
// price 60 s. PR9: only this independent lookup verifies; scan rows never do.
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
// with rows { pairAddress, priceUsd, liquidityUsd, source: 'scan' | 'dexscreener' | 'pool-fetch' }.
// PR9: pools not in this pass's fresh scan are priced by pair address through DexScreener
// (/latest/dex/pairs, batched, on mainLimiter: own budget, never the scan's 429 cooldown).
// opts.dsOnly: addresses that must be priced from DexScreener only (new entries and positions entered
// from DexScreener), so a position's entry and its marks always come from the same source.
// A pool whose liquidity has collapsed below MIN_MARK_LIQ_USD gives no usable price (drained/rugged).
const DS_PAIRS = 'https://api.dexscreener.com/latest/dex/pairs/solana/';
const MIN_MARK_LIQ_USD = 1000;
const pairStats = { lookups: 0, pairsRequested: 0, failures: 0, lowLiquidity: 0 };

async function dsPairPrices(addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    pairStats.lookups += 1;
    pairStats.pairsRequested += chunk.length;
    try {
      const res = await mainLimiter.get(DS_PAIRS + chunk.join(','), { timeout: 10000 });
      const rows = Array.isArray(res.data) ? res.data : (res.data && res.data.pairs) || [];
      for (const r of rows) {
        if (!r || !chunk.includes(r.pairAddress) || (r.chainId && r.chainId !== 'solana')) continue;
        const p = { pairAddress: r.pairAddress, priceUsd: num(r.priceUsd), liquidityUsd: num(r.liquidity && r.liquidity.usd), source: 'dexscreener' };
        if (!(p.priceUsd > 0)) continue;
        if (p.liquidityUsd < MIN_MARK_LIQ_USD) { pairStats.lowLiquidity += 1; continue; }
        out[p.pairAddress] = p;
      }
    } catch (e) {
      pairStats.failures += 1;
      console.warn('DexScreener pair price fetch failed (' + (e.rateLimited ? '429' : e.message) + '); will retry next tick');
    }
  }
  return out;
}

async function storedPoolPrices(addresses, scanPairs, opts) {
  const out = {};
  const dsOnly = new Set(((opts && opts.dsOnly) || []).filter(Boolean));
  const want = Array.from(new Set((addresses || []).filter(Boolean)));
  const fresh = {};
  for (const p of scanPairs || []) if (p && p.pairAddress && !p.stale && p.priceUsd > 0) fresh[p.pairAddress] = p;
  const offScan = [];
  for (const a of want) {
    if (!dsOnly.has(a) && fresh[a]) out[a] = { pairAddress: a, priceUsd: fresh[a].priceUsd, liquidityUsd: num(fresh[a].liquidityUsd), source: 'scan' };
    else offScan.push(a);
  }
  if (!offScan.length) return out;
  Object.assign(out, await dsPairPrices(offScan));
  // Legacy positions (entered from the scan) may fall back to GeckoTerminal by address when
  // DexScreener has no price; DexScreener-only addresses never mix sources.
  const missing = offScan.filter(a => !out[a] && !dsOnly.has(a));
  for (let i = 0; i < missing.length; i += 30) {
    const chunk = missing.slice(i, i + 30);
    try {
      const res = await httpBackoff.get(GT + '/pools/multi/' + chunk.join(','), { timeout: 12000, headers: HEADERS });
      for (const row of (res.data && res.data.data) || []) {
        const p = poolRow(row);
        if (p && chunk.includes(p.pairAddress) && p.priceUsd > 0 && p.liquidityUsd >= MIN_MARK_LIQ_USD) out[p.pairAddress] = { pairAddress: p.pairAddress, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd, source: 'pool-fetch' };
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

// Main pool for a mint: { pool, verified, source }. PR9: only the independent DexScreener token lookup
// (highest-liquidity pool of the mint, price <= 60 s old) verifies; a scan row never counts (it would be
// the entry row checked against itself). Never fetches (prefetchMain does that, once per pass).
function mainPoolFor(mint, scanPairs, now) {
  const t = now == null ? Date.now() : now;
  const c = mainCache.get(mint);
  if (c && t - c.at < PRICE_TTL_MS) return { pool: c.pool, verified: true, source: 'dexscreener' };
  return { pool: null, verified: false, source: null };
}

function divergencePct(price, mainPrice) {
  if (!(price > 0) || !(mainPrice > 0)) return null;
  return (Math.abs(price - mainPrice) / mainPrice) * 100;
}

function _clearCache() { mainCache.clear(); for (const k of Object.keys(mainStats)) mainStats[k] = 0; for (const k of Object.keys(pairStats)) pairStats[k] = 0; mainLimiter._reset(); }

module.exports = { storedPoolPrices, dsPairPrices, pairStats, MIN_MARK_LIQ_USD, prefetchMain, mainPoolFor, divergencePct, poolRow, mainLimiter, mainStats, _clearCache, PRICE_TTL_MS, IDENTITY_TTL_MS };
