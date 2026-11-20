const axios = require('axios');
const config = require('./config');

// Everything is keyed by token mint (baseToken.address) + pairAddress. Never by symbol:
// many pump.fun clones reuse tickers like "WIF".

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
// Broad DEX Screener searches widen the universe (clones are caught by the rug gate's clone check).
const SEARCH_TERMS = (process.env.SEARCH_TERMS ||
  'wif,popcat,mew,myro,pump,pumpswap,raydium,meteora,moon,cat,dog,ai,pepe,trump,meme,sol')
  .split(',').map(s => s.trim()).filter(Boolean);
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
    volumeM5: p.volume?.m5 || 0,
    quoteMint: p.quoteToken?.address || null,
    pairAgeMin: p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 60000) : null,
    name: p.baseToken?.name || null,
    labels: Array.isArray(p.labels) ? p.labels : [],
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
    (p.liquidity?.usd || 0) >= config.scanMinLiquidityUsd &&
    [config.solMint, config.usdcMint].includes(p.quoteToken?.address) &&
    (parseFloat(p.priceUsd) || 0) > 0;
}

// Candidate mints from free discovery feeds (DEX Screener boosts/profiles, GeckoTerminal
// trending/new/top-volume pools). GeckoTerminal pages rotate across ticks to stay well inside its
// free rate limit (~30 req/min), and discovered mints are remembered for MINT_TTL_MS so the scan
// universe accumulates to 150+ pairs.
const MINT_TTL_MS = parseInt(process.env.MINT_TTL_MS || String(45 * 60 * 1000), 10);
const knownMints = new Map(); // mint -> lastSeen
const GT_PAGES = [];
for (let pg = 1; pg <= 5; pg++) GT_PAGES.push(`trending_pools?page=${pg}&duration=1h`);
for (let pg = 1; pg <= 5; pg++) GT_PAGES.push(`new_pools?page=${pg}`);
for (let pg = 1; pg <= 5; pg++) GT_PAGES.push(`pools?page=${pg}&sort=h24_volume_usd_desc`);
for (let pg = 1; pg <= 3; pg++) GT_PAGES.push(`trending_pools?page=${pg}&duration=5m`);
let gtCursor = 0;
const GT_PER_TICK = parseInt(process.env.GT_PAGES_PER_TICK || '4', 10);

async function discoverMints() {
  const now = Date.now();
  const dsFeeds = ['token-boosts/latest/v1', 'token-boosts/top/v1', 'token-profiles/latest/v1'];
  // Always include page 1 of new + trending; rotate the rest.
  const gtFeeds = new Set(['new_pools?page=1', 'trending_pools?page=1&duration=1h']);
  while (gtFeeds.size < GT_PER_TICK) {
    gtFeeds.add(GT_PAGES[gtCursor % GT_PAGES.length]);
    gtCursor++;
  }
  const gtList = [...gtFeeds];
  const results = await Promise.all([
    ...dsFeeds.map(f => getJson(`${DS}/${f}`)),
    ...gtList.map(f => getJson(`${GT}/${f}`))
  ]);
  results.slice(0, dsFeeds.length).forEach(list => {
    (Array.isArray(list) ? list : []).forEach(t => {
      if (t.chainId === 'solana' && t.tokenAddress) knownMints.set(t.tokenAddress, now);
    });
  });
  results.slice(dsFeeds.length).forEach(body => {
    (body?.data || []).forEach(pool => {
      const id = pool.relationships?.base_token?.data?.id || '';
      if (id.startsWith('solana_')) knownMints.set(id.slice(7), now);
    });
  });
  for (const [m, t] of knownMints) if (now - t > MINT_TTL_MS) knownMints.delete(m);
  return [...knownMints.keys()].filter(m => !config.excludedMints[m]).slice(0, 900);
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

// One pair per mint: the deepest-liquidity Solana pool where the token is the base and the
// quote is SOL or USDC.
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

module.exports = { getCandidatePairs, getPairsByAddress, normalizePair };
