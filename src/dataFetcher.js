// PR10: coin scanning runs on DexScreener only (GeckoTerminal was answering ~60% of scan calls with 429).
// Every request goes through the ONE shared DexScreener limiter (poolPrice.mainLimiter: 1 in flight,
// >= 1 s apart, so <= 60 requests/min across all DexScreener calls; documented free limits are
// 60/min for token-profiles / token-boosts / community-takeovers and 300/min for tokens/v1 and pairs).
//
// Discovery (each list cached DISCOVERY_TTL_MS, so ~7 calls per 2 min):
//   token-profiles/latest/v1, token-boosts/latest/v1, token-boosts/top/v1, community-takeovers/latest/v1,
//   latest/dex/search?q=pumpswap|raydium|meteora (Solana SOL-quoted pools, liquidity >= $10k)
// Discovered Solana mints stay on a watch list for WATCH_MS (newest first, max MAX_WATCH).
// Rows (every pass): tokens/v1/solana/{<=30 mints} batches -> one row per mint: its highest-liquidity
// pool quoted in SOL, liquidity >= $10k (same filter as the old GeckoTerminal scan).
// Row shape is unchanged for the strategies: pairAddress, mint, symbol, priceUsd, liquidityUsd, volumeH1,
// priceChange {m5,h1,h6,h24}, txns {buys,sells} (h1), ageDays (from pairCreatedAt). Extra: mcapUsd,
// pairCreatedAt, dexId, source. A batch that fails reuses that mint's last row (<= 5 min) marked stale
// (stale rows never price a fill or a mark).
const poolPrice = require('./poolPrice');

const DS = 'https://api.dexscreener.com';
const DISCOVERY = [
  DS + '/token-profiles/latest/v1',
  DS + '/token-boosts/latest/v1',
  DS + '/token-boosts/top/v1',
  DS + '/community-takeovers/latest/v1',
  // search (300/min): active Solana pools by DEX, closest match to the old GeckoTerminal trending pages
  DS + '/latest/dex/search?q=pumpswap',
  DS + '/latest/dex/search?q=raydium',
  DS + '/latest/dex/search?q=meteora'
];
const TOKENS = DS + '/tokens/v1/solana/';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DISCOVERY_TTL_MS = 2 * 60 * 1000;
const WATCH_MS = 30 * 60 * 1000;
const MAX_WATCH = 150;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const MIN_LIQ_USD = 10000;

const limiter = () => poolPrice.mainLimiter;
const discoveryCache = new Map(); // url -> { at, mints }
const watch = new Map();          // mint -> lastSeenAt
const lastGood = new Map();       // mint -> { at, row }
const scanStats = { passes: 0, lastCandidates: 0, lastMintsQueried: 0, discoveryCalls: 0, tokenBatches: 0, batchFailures: 0, staleRows: 0, lastScanAt: null };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isSolQuote(q) {
  return !!q && (q.address === SOL_MINT || /^w?SOL$/i.test(String(q.symbol || '')));
}

// One DexScreener pair -> one scan row (null when not a usable SOL pool).
function mapDsPair(r, now) {
  if (!r || (r.chainId && r.chainId !== 'solana') || !r.pairAddress) return null;
  const base = r.baseToken || {};
  if (!base.address || base.address === SOL_MINT || !isSolQuote(r.quoteToken)) return null;
  const liquidityUsd = num(r.liquidity && r.liquidity.usd);
  if (liquidityUsd < MIN_LIQ_USD) return null;
  const pc = r.priceChange || {};
  const tx = (r.txns && r.txns.h1) || {};
  const tx5 = (r.txns && r.txns.m5) || {};
  const vol = r.volume || {};
  const created = num(r.pairCreatedAt);
  const t = now == null ? Date.now() : now;
  return {
    pairAddress: r.pairAddress,
    mint: base.address,
    symbol: String(base.symbol || 'UNK').trim() || 'UNK',
    priceUsd: num(r.priceUsd),
    liquidityUsd: liquidityUsd,
    volumeH1: num(r.volume && r.volume.h1),
    priceChange: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
    txns: { buys: num(tx.buys), sells: num(tx.sells) },
    ageDays: created ? Math.max(0, (t - created) / 86400000) : 1,
    mcapUsd: num(r.marketCap) || num(r.fdv),
    pairCreatedAt: created || null,
    dexId: r.dexId || null,
    // PR11 (books): 5-min txns, m5/h6/h24 volume, SOL price, token name, fetch time.
    txnsM5: { buys: num(tx5.buys), sells: num(tx5.sells) },
    volumeM5: num(vol.m5), volumeH6: num(vol.h6), volumeH24: num(vol.h24),
    priceNative: num(r.priceNative),
    name: String(base.name || ''),
    fetchedAt: Date.now(),
    source: 'dexscreener'
  };
}

// Highest-liquidity SOL pool per mint from a tokens/v1 response.
function bestRowsByMint(rows, wanted, now) {
  const best = {};
  for (const r of rows || []) {
    const row = mapDsPair(r, now);
    if (!row || (wanted && !wanted.has(row.mint))) continue;
    if (!(row.priceUsd > 0)) continue;
    if (!best[row.mint] || row.liquidityUsd > best[row.mint].liquidityUsd) best[row.mint] = row;
  }
  return best;
}

async function discover(now) {
  for (const url of DISCOVERY) {
    const c = discoveryCache.get(url);
    let mints = null;
    if (!c || now - c.at >= DISCOVERY_TTL_MS) {
      scanStats.discoveryCalls += 1;
      try {
        const res = await limiter().get(url, { timeout: 10000 }, 'scan');
        const list = Array.isArray(res.data) ? res.data : (res.data && Array.isArray(res.data.pairs)) ? res.data.pairs : [];
        mints = list.filter(x => x && x.chainId === 'solana').map(x => {
          if (x.tokenAddress) return x.tokenAddress;      // profiles / boosts / takeovers
          const row = mapDsPair(x, now);                  // search: SOL-quoted, liquidity >= $10k only
          return row ? row.mint : null;
        }).filter(Boolean);
        discoveryCache.set(url, { at: now, mints });
      } catch (e) {
        console.warn('DexScreener discovery failed (' + (e.rateLimited ? '429' : e.message) + '): ' + url.replace(DS, ''));
        if (c) c.at = now - DISCOVERY_TTL_MS + 30000; // retry in ~30 s, keep the old list meanwhile
      }
    }
    for (const m of mints || (c && c.mints) || []) if (m !== SOL_MINT) watch.set(m, now);
  }
  for (const [m, at] of watch) if (now - at > WATCH_MS) watch.delete(m);
}

async function getCandidatePairs() {
  const now = Date.now();
  scanStats.passes += 1;
  await discover(now);
  const mints = Array.from(watch.entries()).sort((a, b) => b[1] - a[1]).slice(0, MAX_WATCH).map(e => e[0]);
  scanStats.lastMintsQueried = mints.length;
  const all = [];
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const wanted = new Set(chunk);
    scanStats.tokenBatches += 1;
    let best = null;
    try {
      const res = await limiter().get(TOKENS + chunk.join(','), { timeout: 10000 }, 'scan');
      const rows = Array.isArray(res.data) ? res.data : (res.data && res.data.pairs) || [];
      best = bestRowsByMint(rows, wanted, now);
      for (const [m, row] of Object.entries(best)) lastGood.set(m, { at: now, row });
    } catch (e) {
      scanStats.batchFailures += 1;
      console.warn('DexScreener token batch failed (' + (e.rateLimited ? '429' : e.message) + '), using cached rows');
    }
    for (const m of chunk) {
      if (best && best[m]) { all.push(best[m]); continue; }
      if (best) continue; // answered, but no usable SOL pool for this mint
      const c = lastGood.get(m);
      if (c && now - c.at < CACHE_MAX_AGE_MS) { all.push(Object.assign({}, c.row, { stale: true })); scanStats.staleRows += 1; }
    }
  }
  for (const [m, c] of lastGood) if (now - c.at > CACHE_MAX_AGE_MS) lastGood.delete(m);
  const seen = new Set();
  const out = all.filter(p => !seen.has(p.pairAddress) && seen.add(p.pairAddress));
  scanStats.lastCandidates = out.length;
  scanStats.lastScanAt = new Date(now).toISOString();
  return out;
}

function _reset() { discoveryCache.clear(); watch.clear(); lastGood.clear(); for (const k of Object.keys(scanStats)) scanStats[k] = k === 'lastScanAt' ? null : 0; }

module.exports = { getCandidatePairs, mapDsPair, bestRowsByMint, scanStats, DISCOVERY, _reset, _lastGood: lastGood, _watch: watch };
