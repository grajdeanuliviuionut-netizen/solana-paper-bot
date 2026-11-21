const httpBackoff = require('./httpBackoff');

const SOURCES = [
  'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',
  'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=2',
  'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1',
  'https://api.geckoterminal.com/api/v2/networks/solana/pools?page=1'
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
  const base = row.relationships && row.relationships.base_token && row.relationships.base_token.data;
  const mint = base && typeof base.id === 'string' && base.id.startsWith('solana_') ? base.id.slice(7) : null;
  return {
    pairAddress: a.address,
    mint: mint,
    symbol: name.split('/')[0].trim() || 'UNK',
    priceUsd: num(a.base_token_price_usd),
    liquidityUsd: liquidityUsd,
    volumeH1: num(a.volume_usd && a.volume_usd.h1),
    priceChange: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
    txns: { buys: num(tx.buys), sells: num(tx.sells) },
    ageDays: created ? Math.max(0, (Date.now() - created) / 86400000) : 1
  };
}

// Last good page per source: a rate-limited (429) source reuses its previous page for up to 5 min
// so a throttled pass still sees (and can manage exits on) the usual pools.
const lastGood = new Map();
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

async function getCandidatePairs() {
  const seen = new Set();
  const all = [];
  for (const url of SOURCES) {
    let rows = null;
    try {
      const res = await httpBackoff.get(url, { timeout: 12000, headers: { accept: 'application/json;version=20230302' } });
      rows = res.data?.data || [];
      lastGood.set(url, { at: Date.now(), rows });
    } catch (e) {
      const cached = lastGood.get(url);
      if (cached && Date.now() - cached.at < CACHE_MAX_AGE_MS) rows = cached.rows;
      if (e.rateLimited) console.warn('Fetch rate-limited (429 backoff), ' + (rows ? 'using cached page' : 'skipped') + ': ' + url.replace(/^https:\/\/[^/]+/, ''));
      else console.error('Fetch error:', e.message);
    }
    for (const row of rows || []) {
      const pair = mapPool(row);
      if (!pair || seen.has(pair.pairAddress)) continue;
      seen.add(pair.pairAddress);
      all.push(pair);
    }
  }
  return all.slice(0, 80);
}

module.exports = { getCandidatePairs, mapPool, _lastGood: lastGood };
