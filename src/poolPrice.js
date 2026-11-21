// Stored-pool pricing (PR7). A position is priced ONLY from the pool whose pairAddress was stored at
// entry: from this pass's scan if that pool is in it, else from GeckoTerminal /pools/multi for the
// stored addresses. Never from another pool of the same token or a ticker match.
// At entry the chosen pool's price is compared with the token's main pool (highest liquidity, base
// token = the mint); more than config.maxPoolDivergencePct (5) off -> the buy is skipped.
const httpBackoff = require('./httpBackoff');

const API = 'https://api.geckoterminal.com/api/v2/networks/solana';
const HEADERS = { accept: 'application/json;version=20230302' };
const MAIN_POOL_TTL_MS = 10 * 60 * 1000;
const mainPoolCache = new Map(); // mint -> { at, pools: [{ pairAddress, priceUsd, liquidityUsd }] }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Raw GeckoTerminal pool rows -> { pairAddress, priceUsd, liquidityUsd, mint } (base-token price, USD).
function poolRow(row) {
  const a = (row && row.attributes) || {};
  const base = row && row.relationships && row.relationships.base_token && row.relationships.base_token.data;
  const mint = base && typeof base.id === 'string' && base.id.startsWith('solana_') ? base.id.slice(7) : null;
  if (!a.address) return null;
  return { pairAddress: a.address, priceUsd: num(a.base_token_price_usd), liquidityUsd: num(a.reserve_in_usd), mint };
}

// Prices for stored pools that were not in this pass's scan. Returns { [pairAddress]: poolRow }.
async function fetchPools(addresses) {
  const out = {};
  const list = Array.from(new Set((addresses || []).filter(Boolean)));
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    try {
      const res = await httpBackoff.get(API + '/pools/multi/' + chunk.join(','), { timeout: 12000, headers: HEADERS });
      for (const row of (res.data && res.data.data) || []) {
        const p = poolRow(row);
        if (p && chunk.includes(p.pairAddress) && p.priceUsd > 0) out[p.pairAddress] = p;
      }
    } catch (e) {
      console.warn('Stored-pool price fetch failed (' + (e.rateLimited ? '429' : e.message) + '); positions hold until next tick');
    }
  }
  return out;
}

// Main pool for a mint: highest liquidity among pools whose BASE token is the mint (scan pools of the
// mint + GeckoTerminal /tokens/{mint}/pools, cached 10 min). Returns { pool, verified }.
async function mainPoolFor(mint, scanPairs) {
  const known = (scanPairs || []).filter(p => p && p.mint === mint && p.priceUsd > 0)
    .map(p => ({ pairAddress: p.pairAddress, priceUsd: p.priceUsd, liquidityUsd: num(p.liquidityUsd) }));
  let fetched = null;
  const cached = mainPoolCache.get(mint);
  if (cached && Date.now() - cached.at < MAIN_POOL_TTL_MS) fetched = cached.pools;
  else {
    try {
      const res = await httpBackoff.get(API + '/tokens/' + mint + '/pools?page=1', { timeout: 12000, headers: HEADERS });
      fetched = ((res.data && res.data.data) || []).map(poolRow).filter(p => p && p.mint === mint && p.priceUsd > 0);
      mainPoolCache.set(mint, { at: Date.now(), pools: fetched });
    } catch (e) {
      fetched = null;
    }
  }
  const all = known.concat(fetched || []);
  if (!all.length) return { pool: null, verified: false };
  const best = all.reduce((a, b) => (b.liquidityUsd > a.liquidityUsd ? b : a));
  return { pool: best, verified: fetched != null };
}

function divergencePct(price, mainPrice) {
  if (!(price > 0) || !(mainPrice > 0)) return null;
  return (Math.abs(price - mainPrice) / mainPrice) * 100;
}

function _clearCache() { mainPoolCache.clear(); }

module.exports = { fetchPools, mainPoolFor, divergencePct, poolRow, _clearCache };
