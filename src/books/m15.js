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
const KEEP_MIN = 60;   // t90u: 60 min of own ticks (m15 + the breakout's prior high)

function recordTick(ticks, row, t) {
  if (!row || !row.pairAddress || !(row.priceUsd > 0) || row.stale) return;
  const s = ticks[row.pairAddress] || (ticks[row.pairAddress] = []);
  if (!s.length || t - s[s.length - 1][0] >= 40000) s.push([t, Number(row.priceUsd)]);
  while (s.length && t - s[0][0] > KEEP_MIN * MIN) s.shift();
}
function pruneTicks(ticks, t) {
  for (const k of Object.keys(ticks)) if (!ticks[k].length || t - ticks[k][ticks[k].length - 1][0] > 20 * MIN) delete ticks[k];
}
// t90u v5 breakout ("resistance break"): the prior high = the highest price in [now - lookbackMin, now - excludeMin]
// (the last excludeMin minutes are the breakout itself). Own history needs a point at least minCoverMin old.
// Returns { priorHigh, fromMin, toMin, points, source } or null.
function priorHighFromTicks(series, t, o) {
  if (!Array.isArray(series) || !series.length) return null;
  const oldest = (t - series[0][0]) / MIN;
  if (oldest < o.minCoverMin) return null;
  let hi = null, n = 0;
  for (const [ts, p] of series) { const age = (t - ts) / MIN; if (age > o.lookbackMin || age < o.excludeMin || !(p > 0)) continue; n++; if (hi == null || p > hi) hi = p; }
  return hi == null || n < 3 ? null : { priorHigh: hi, fromMin: +Math.min(oldest, o.lookbackMin).toFixed(1), toMin: o.excludeMin, points: n, source: 'own-history' };
}
// GeckoTerminal 1m candles (newest first or any order): max HIGH of candles in the same window.
function priorHighFromOhlcv(list, t, o) {
  if (!Array.isArray(list) || !list.length) return null;
  const nowSec = t / 1000;
  const rows = list.filter(r => Array.isArray(r) && r.length >= 5 && Number(r[2]) > 0).sort((a, b) => b[0] - a[0]);
  if (!rows.length || nowSec - rows[0][0] > 180) return null;
  const inWin = rows.filter(r => { const age = (nowSec - r[0]) / 60; return age <= o.lookbackMin && age >= o.excludeMin; });
  const oldest = (nowSec - rows[rows.length - 1][0]) / 60;
  if (inWin.length < 10 || oldest < o.minCoverMin) return null;
  return { priorHigh: Math.max(...inWin.map(r => Number(r[2]))), fromMin: +Math.min(oldest, o.lookbackMin).toFixed(1), toMin: o.excludeMin, points: inWin.length, source: 'geckoterminal-ohlcv-1m' };
}
// t93u v6 trend: 50-period SMA of 1-minute closes.
// Own history: the bot's ~45 s pool price ticks resampled to 1 min (close of minute k = the last tick at or
// before its end; a minute with no tick carries the previous close). Needs ticks covering >= period minutes.
function smaFromTicks(series, t, o) {
  const n = o.maPeriod;
  if (!Array.isArray(series) || !series.length || (t - series[0][0]) / MIN < n) return null;
  const closes = [];
  let j = 0, last = null;
  for (let k = n - 1; k >= 0; k--) {
    const end = t - k * MIN;
    while (j < series.length && series[j][0] <= end) { if (series[j][1] > 0) last = series[j][1]; j++; }
    if (last == null) return null;
    closes.push(last);
  }
  const ma = closes.reduce((a, b) => a + b, 0) / n;
  return { ma, period: n, candles: n, source: 'own-history-1m', newestAgeSec: +((t - series[series.length - 1][0]) / 1000).toFixed(1) };
}
// GeckoTerminal 1m OHLCV: SMA of the closes of the newest `period` candles (needs >= period candles, newest <= maxCandleAgeSec old).
function smaFromOhlcv(list, t, o) {
  if (!Array.isArray(list)) return null;
  const rows = list.filter(r => Array.isArray(r) && r.length >= 5 && Number(r[4]) > 0).sort((a, b) => b[0] - a[0]);
  const n = o.maPeriod;
  if (rows.length < n) return null;
  const age = t / 1000 - rows[0][0];
  if (age > (o.maxCandleAgeSec || 180)) return null;
  const use = rows.slice(0, n);
  const ma = use.reduce((a, r) => a + Number(r[4]), 0) / n;
  return { ma, period: n, candles: n, source: 'geckoterminal-ohlcv-1m', newestAgeSec: +age.toFixed(1), spanMin: +((use[0][0] - use[n - 1][0]) / 60 + 1).toFixed(0) };
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
  const cache = new Map(), lists = new Map();
  const stats = { ownHistory: 0, gtCalls: 0, gtOk: 0, gtNoData: 0, gtErrors: 0, cacheHits: 0, method: 'own 45 s price history (12.5-17.5 min point) else GeckoTerminal 1m OHLCV; none -> reject' };
  async function gt(pairAddress, t = Date.now()) {
    const c = cache.get(pairAddress);
    if (c && t - c.at < 60000) { stats.cacheHits++; return c.r; }
    let r = null;
    try {
      stats.gtCalls++;
      const res = await limiter.get('gecko', GT + pairAddress + '/ohlcv/minute?aggregate=1&limit=60&currency=usd', { headers: { accept: 'application/json' } });
      const list = res && res.data && res.data.data && res.data.data.attributes && res.data.data.attributes.ohlcv_list;
      lists.set(pairAddress, { at: t, list: Array.isArray(list) ? list : null });
      if (lists.size > 500) lists.delete(lists.keys().next().value);
      r = m15FromOhlcv(list, t);
      if (r) stats.gtOk++; else stats.gtNoData++;
    } catch (e) { stats.gtErrors++; stats.lastError = String(e.message || e).slice(0, 80); r = null; }
    cache.set(pairAddress, { at: t, r });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return r;
  }
  // t90u: prior high from the same cached GT candles (one call serves m15 and the breakout).
  async function priorHighGt(pairAddress, t, o) {
    let l = lists.get(pairAddress);
    if (!l || t - l.at >= 60000) { await gt(pairAddress, t); l = lists.get(pairAddress); }
    return l && l.list ? priorHighFromOhlcv(l.list, t, o) : null;
  }
  // t93u: 50-period SMA from the same cached GT candles.
  async function smaGt(pairAddress, t, o) {
    let l = lists.get(pairAddress);
    if (!l || t - l.at >= 60000) { await gt(pairAddress, t); l = lists.get(pairAddress); }
    if (!l || t - l.at >= 60000) return { error: stats.lastError || 'GeckoTerminal unavailable' };   // fetch failed / rate limited: not a verdict
    return l.list ? smaFromOhlcv(l.list, t, o) : null;
  }
  return { gt, priorHighGt, smaGt, stats };
}

module.exports = { smaFromTicks, smaFromOhlcv, recordTick, pruneTicks, m15FromTicks, m15FromOhlcv, priorHighFromTicks, priorHighFromOhlcv, makeM15, KEEP_MIN };
