const axios = require('axios');
const config = require('./config');

// Everything is keyed by token mint (baseToken.address) + pairAddress. Never by symbol:
// many pump.fun clones reuse tickers like "WIF".

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const SEARCH_TERMS = ['wif', 'popcat', 'mew', 'myro'];
const HTTP = { timeout: 8000, headers: { Accept: 'application/json' } };

async function getJson(url) {
  try {
    const res = await axios.get(url, HTTP);
    return res.data;
  } catch (e) {
    return null;
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function normalizePair(p) {
  return {
    mint: p.baseToken?.address || null,
    pairAddress: p.pairAddress,
    dexId: p.dexId || null,
    symbol: p.baseToken?.symbol || 'UNK',
    priceUsd: parseFloat(p.priceUsd) || 0,
    liquidityUsd: p.liquidity?.usd || 0,
    mcapUsd: p.marketCap || p.fdv || 0,
    volumeH1: p.volume?.h1 || 0,
    priceChange: {
      m5: p.priceChange?.m5 || 0,
      h1: p.priceChange?.h1 || 0,
      h6: p.priceChange?.h6 || 0,
      h24: p.priceChange?.h24 || 0
    },
    txns: p.txns?.h1 || { buys: 0, sells: 0 },
    txnsM5: p.txns?.m5 || { buys: 0, sells: 0 },
    ageDays: p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 86400000) : 1
  };
}

function isTradable(p) {
  return p && p.chainId === 'solana' && p.baseToken?.address && p.pairAddress &&
    !config.excludedMints[p.baseToken.address] &&
    (p.liquidity?.usd || 0) >= config.minLiquidityUsd &&
    (parseFloat(p.priceUsd) || 0) > 0;
}

// Candidate mints from free discovery feeds (DEX Screener boosts/profiles, GeckoTerminal trending/new).
async function discoverMints() {
  const mints = new Set();
  const dsFeeds = ['token-boosts/latest/v1', 'token-boosts/top/v1', 'token-profiles/latest/v1'];
  const gtFeeds = ['trending_pools?page=1', 'trending_pools?page=2', 'new_pools?page=1', 'new_pools?page=2'];
  const results = await Promise.all([
    ...dsFeeds.map(f => getJson(`${DS}/${f}`)),
    ...gtFeeds.map(f => getJson(`${GT}/${f}`))
  ]);
  results.slice(0, dsFeeds.length).forEach(list => {
    (Array.isArray(list) ? list : []).forEach(t => {
      if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress);
    });
  });
  results.slice(dsFeeds.length).forEach(body => {
    (body?.data || []).forEach(pool => {
      const id = pool.relationships?.base_token?.data?.id || '';
      if (id.startsWith('solana_')) mints.add(id.slice(7));
    });
  });
  return [...mints].filter(m => !config.excludedMints[m]);
}

async function pairsForMints(mints) {
  const batches = await Promise.all(
    chunk(mints, 30).map(c => getJson(`${DS}/tokens/v1/solana/${c.join(',')}`))
  );
  return batches.flatMap(b => (Array.isArray(b) ? b : []));
}

async function searchPairs() {
  const batches = await Promise.all(
    SEARCH_TERMS.map(t => getJson(`${DS}/latest/dex/search?q=${encodeURIComponent(t)}`))
  );
  return batches.flatMap(b => b?.pairs || []);
}

// One pair per mint: the deepest-liquidity Solana pool where the token is the base.
async function getCandidatePairs() {
  try {
    const mints = await discoverMints();
    const [fromMints, fromSearch] = await Promise.all([pairsForMints(mints), searchPairs()]);
    const bestByMint = new Map();
    for (const p of [...fromMints, ...fromSearch]) {
      if (!isTradable(p)) continue;
      const cur = bestByMint.get(p.baseToken.address);
      if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) bestByMint.set(p.baseToken.address, p);
    }
    const pairs = [...bestByMint.values()]
      .sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))
      .slice(0, config.maxPairsPerScan)
      .map(normalizePair);
    return { pairs, discoveredMints: mints.length };
  } catch (e) {
    console.error('Fetch error:', e.message);
    return { pairs: [], discoveredMints: 0 };
  }
}

// Fresh quotes for pinned pairs (used for exits). Returns { pairAddress: normalizedPair }.
async function getPairsByAddress(pairAddresses) {
  const out = {};
  const uniq = [...new Set(pairAddresses.filter(Boolean))];
  const batches = await Promise.all(
    chunk(uniq, 30).map(c => getJson(`${DS}/latest/dex/pairs/solana/${c.join(',')}`))
  );
  batches.forEach(b => {
    const list = b?.pairs || (b?.pair ? [b.pair] : []);
    list.forEach(p => {
      if (p && p.pairAddress && (parseFloat(p.priceUsd) || 0) > 0) out[p.pairAddress] = normalizePair(p);
    });
  });
  return out;
}

module.exports = { getCandidatePairs, getPairsByAddress };
