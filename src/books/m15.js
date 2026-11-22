// t86u (Liviu 22 Nov 12:12): "rising on the 15-minute chart" for runner-hunter v3. DexScreener gives m5/h1
// but no m15, so m15 = % change of the pool price over the last 15 minutes, from:
//   1) the bot's own price history: every scan (~45 s) stores the DexScreener priceUsd per pool (pools with
//      liquidity >= $50k, last 20 min, kept in state.books.ticks). m15 = now vs the stored price closest to
//      15 min ago, accepted only if that point is 12.5-17.5 min old.
//   2) fallback when (1) has no point that old: GeckoTerminal 1-minute OHLCV for the pool (public API, limiter
//      bucket 'gecko': 1 call / 2.5 s, no retries, 10 min pause after a 429, cached 60 s per pool). m15 =
//      latest close (<= 3 min old) vs the close of the candle closest to 15 min earlier (within 3 min).
// No data from either -> null (the entry rejects: fail closed).
const MIN = 60000;
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/';

function recordTick(ticks, row, t) {
  if (!row || !row.pairAddress || !(row.priceUsd > 0) || row.stale) return;
  const s = ticks[row.pairAddress] || (ticks[row.pairAddress] = []);
  if (!s.length || t - s[s.length - 1][0] >= 40000) s.push([t, Number(row.priceUsd)]);
  while (s.length && t - s[0][0] > 20 * MIN) s.shift();
}
function pruneTicks(ticks, t) {
  for (const k of Object.keys(ticks)) if (!ticks[k].length || t - ticks[k][ticks[k].length - 1][0] > 20 * MIN) delete ticks[k];
}
// Own-history m15 (pure). Returns { pct, fromAgeMin } or null.
function m15FromTicks(series, priceNow, t) {
  if (!Array.isArray(series) || !(priceNow > 0)) return null;
  let best = null;
  for (const [ts, p] of series) {
    const age = (t - ts) / MIN;
    if (age < 12.5 || age > 17.5 || !(p > 0)) continue;
    if (!best || Math.abs(age - 15) < Math.abs(best.age - 15)) best = { age, p };
  }
  return best ? { pct: (priceNow / best.p - 1) * 100, fromAgeMin: +best.age.toFixed(2), source: 'own-history' } : null;
}
// GeckoTerminal ohlcv_list [[tsSec, o, h, l, c, v], ...] newest first (pure).
function m15FromOhlcv(list, t) {
  if (!Array.isArray(list) || list.length < 2) return null;
  const nowSec = t / 1000;
  const rows = list.filter(r => Array.isArray(r) && r.length >= 5 && Number(r[4]) > 0).sort((a, b) => b[0] - a[0]);
  if (!rows.length || nowSec - rows[0][0] > 180) return null;
  const target = rows[0][0] - 15 * 60;
  let best = null;
  for (const r of rows.slice(1)) if (!best || Math.abs(r[0] - target) < Math.abs(best[0] - target)) best = r;
  if (!best || Math.abs(best[0] - target) > 180) return null;
  return { pct: (Number(rows[0][4]) / Number(best[4]) - 1) * 100, fromAgeMin: +((rows[0][0] - best[0]) / 60).toFixed(2), source: 'geckoterminal-ohlcv-1m' };
}
function makeM15(limiter) {
  const cache = new Map();
  const stats = { ownHistory: 0, gtCalls: 0, gtOk: 0, gtNoData: 0, gtErrors: 0, cacheHits: 0, method: 'own 45 s price history (12.5-17.5 min point) else GeckoTerminal 1m OHLCV; none -> reject' };
  async function gt(pairAddress, t = Date.now()) {
    const c = cache.get(pairAddress);
    if (c && t - c.at < 60000) { stats.cacheHits++; return c.r; }
    let r = null;
    try {
      stats.gtCalls++;
      const res = await limiter.get('gecko', GT + pairAddress + '/ohlcv/minute?aggregate=1&limit=20&currency=usd', { headers: { accept: 'application/json' } });
      const list = res && res.data && res.data.data && res.data.data.attributes && res.data.data.attributes.ohlcv_list;
      r = m15FromOhlcv(list, t);
      if (r) stats.gtOk++; else stats.gtNoData++;
    } catch (e) { stats.gtErrors++; stats.lastError = String(e.message || e).slice(0, 80); r = null; }
    cache.set(pairAddress, { at: t, r });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return r;
  }
  return { gt, stats };
}

module.exports = { recordTick, pruneTicks, m15FromTicks, m15FromOhlcv, makeM15 };
