const axios = require('axios');

async function getCandidatePairs() {
  try {
    // Dexscreener Solana trending / recent pairs (simplified public endpoint)
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', {
      timeout: 10000
    });
    const pairs = (res.data.pairs || [])
      .filter(p => p.chainId === 'solana' && p.liquidity?.usd >= 10000)
      .slice(0, 40)
      .map(p => ({
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
        ageDays: 1 // approximate; real age would need extra call
      }));
    return pairs;
  } catch (e) {
    console.error('Fetch error:', e.message);
    return [];
  }
}

module.exports = { getCandidatePairs };
