const axios = require('axios');

async function getCandidatePairs() {
  try {
    const endpoints = [
      'https://api.dexscreener.com/latest/dex/search?q=solana',
      'https://api.dexscreener.com/latest/dex/search?q=raydium',
      'https://api.dexscreener.com/latest/dex/search?q=pump'
    ];

    const all = [];
    const seen = new Set();

    for (const url of endpoints) {
      try {
        const res = await axios.get(url, { timeout: 10000 });
        const pairs = res.data?.pairs || [];
        for (const p of pairs) {
          if (p && p.chainId === 'solana' && p.pairAddress && !seen.has(p.pairAddress) && (p.liquidity?.usd || 0) >= 8000) {
            seen.add(p.pairAddress);
            all.push(p);
          }
        }
      } catch (e) {}
    }

    const pairs = all.slice(0, 50).map(p => ({
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
