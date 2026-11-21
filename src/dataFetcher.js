const axios = require('axios');

const SOURCES = [
  'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',
  'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1'
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapPool(row) {
  const a = row.attributes || {};
  const name = a.name || '';
  if (!/\/\s*SOL\b/i.test(name)) return null;
  const pc = a.price_change_percentage || {};
  const tx = (a.transactions && a.transactions.h1) || {};
  const created = a.pool_created_at ? new Date(a.pool_created_at).getTime() : 0;
  const liquidityUsd = num(a.reserve_in_usd);
  if (liquidityUsd < 10000 || !a.address) return null;
  return {
    pairAddress: a.address,
    symbol: name.split('/')[0].trim() || 'UNK',
    priceUsd: num(a.base_token_price_usd),
    liquidityUsd,
    volumeH1: num(a.volume_usd && a.volume_usd.h1),
    priceChange: {
      m5: num(pc.m5),
      h1: num(pc.h1),
      h6: num(pc.h6),
      h24: num(pc.h24)
    },
    txns: { buys: num(tx.buys), sells: num(tx.sells) },
    ageDays: created ? Math.max(0, (Date.now() - created) / 86400000) : 1
  };
}

async function getCandidatePairs() {
  const seen = new Set();
  const all = [];
  for (const url of SOURCES) {
    try {
      const res = await axios.get(url, {
        timeout: 12000,
        headers: { accept: 'application/json;version=20230302' }
      });
      for (const row of res.data?.data || []) {
        const pair = mapPool(row);
        if (!pair || seen.has(pair.pairAddress)) continue;
        seen.add(pair.pairAddress);
        all.push(pair);
      }
    } catch (e) {
      console.error('Fetch error:', e.message);
    }
  }
  return all.slice(0, 60);
}

module.exports = { getCandidatePairs };
