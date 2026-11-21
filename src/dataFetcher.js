const axios = require('axios');

const SEARCH_TERMS = ['bonk', 'wif', 'popcat', 'mew', 'myro', 'sol', 'jup', 'ray', 'jito'];

async function fetchSearch(term) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`, {
      timeout: 10000
    });
    const pairs = res.data?.pairs;
    if (!Array.isArray(pairs)) return [];
    return pairs.filter(p => p && p.chainId === 'solana' && (p.liquidity?.usd || 0) >= 10000);
  } catch (e) {
    return [];
  }
}

async function getCandidatePairs() {
  try {
    const all = [];
    const seen = new Set();
    for (const term of SEARCH_TERMS) {
      const batch = await fetchSearch(term);
      if (!Array.isArray(batch)) continue;
      for (const p of batch) {
        if (p && p.pairAddress && !seen.has(p.pairAddress)) {
          seen.add(p.pairAddress);
          all.push(p);
        }
      }
      if (all.length >= 60) break;
    }

    const pairs = all.slice(0, 40).map(p => ({
      pairAddress: p.pairAddress,
      symbol: p.baseToken?.symbol || 'UNK',
      priceUsd: parseFloat(p.priceUsd) || 0,
      liquidityUsd: p.liquidity?.usd || 0,
      volumeH1: p.volume?.h1 || 0,
      priceChange: {
        m5: p.priceChange?.m5 || 0,
        h1: p.priceChange?.h1 || 0,
        h6: p.priceChange?.h6 || 0,
        h24: p.priceChange?.h24 || 0
      },
      txns: p.txns?.h1 || { buys: 0, sells: 0 },
      ageDays: p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 86400000) : 1
    }));

    return pairs;
  } catch (e) {
    console.error('Fetch error:', e.message);
    return [];
  }
}

module.exports = { getCandidatePairs };
