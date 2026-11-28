// t86u (Liviu 22 Nov 12:12): "rising on the 15-minute chart" for runner-hunter v3. DexScreener gives m5/h1
// but no m15, so m15 = % change of the pool price over the last 15 minutes, from:
//   1) the bot's own price history: every scan (~45 s) stores the DexScreener priceUsd per pool (pools with
//      liquidity >= $50k, last KEEP_MIN min, kept in state.books.ticks). m15 = now vs the stored price closest to
//      15 min ago, accepted only if that point is 12.5-17.5 min old.
//   2) fallback when (1) has no point that old: GeckoTerminal 1-minute OHLCV for the pool (public API, limiter
//      bucket 'gecko', token-bucket <= 25 req/min, no retries at this layer, cached OHLC_CACHE_MS per pool).
//      m15 = latest close (<= 3 min old) vs the close of the candle closest to 15 min earlier (within 3 min).
// No data from either -> null (the entry rejects: fail closed).
//
// t93u / trend-gt-backoff: 50-period SMA of 1-minute closes prefers the same own ticks (resampled, covering
// >= period minutes, gaps no wider than 3 min). A successful GT OHLCV fetch is merged into those ticks so
// later scans can use own history. stats.ownHistory counts scans where the own SMA was used (it was never
// incremented before, so /api/manager trendStats.gtSma.ownHistory stayed 0 even when entries were own-history-1m).
const MIN = 60000;
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/';
const KEEP_MIN = 60;   // t90u: 60 min of own ticks (m15 + the breakout's prior high + SMA50 + 5-candle lookback)
const OHLC_CACHE_MS = 3 * MIN;       // was 60 s; 3 min cache with incremental refresh of the 60-candle window
const GT_MAX_PER_MIN = 25;           // token bucket under GeckoTerminal's free ~30 req/min
const MAX_TICK_GAP_MS = 3 * MIN;     // do not carry a stale close across a longer hole in own ticks

function recordTick(ticks, row, t) {
  if (!row || !row.pairAddress || !(row.priceUsd > 0) || row.stale) return;
  const s = ticks[row.pairAddress] || (ticks[row.pairAddress] = []);
  if (!s.length || t - s[s.length - 1][0] >= 40000) s.push([t, Number(row.priceUsd)]);
  while (s.length && t - s[0][0] > KEEP_MIN * MIN) s.shift();
}
function pruneTicks(ticks, t) {
  // Drop a series only once its newest tick is older than KEEP_MIN (was 20 min, which wiped a 50-min SMA
  // series if a coin dropped off the scan for 20 min, forcing a fresh GeckoTerminal fetch on return).
  for (const k of Object.keys(ticks)) {
    const s = ticks[k];
    if (!s || !s.length) { delete ticks[k]; continue; }
    while (s.length && t - s[0][0] > KEEP_MIN * MIN) s.shift();
    if (!s.length || t - s[s.length - 1][0] > KEEP_MIN * MIN) delete ticks[k];
  }
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
// A gap longer than maxTickGapMs (default 3 min) between a minute's end and the last tick is not filled by
// carrying a stale close — return null so GeckoTerminal can supply real candles.
// t98u: maPrev = the same SMA ending risingLookback (5) candles earlier, so "rising" = ma > maPrev. Needs
// period + lookback minutes (own) / candles (GT); without them maPrev is null and a rising check fails closed.
function smaFromTicks(series, t, o) {
  const n = o.maPeriod, lb = o.risingLookbackCandles || 0;
  if (!Array.isArray(series) || !series.length || (t - series[0][0]) / MIN < n) return null;
  const maxGap = o.maxTickGapMs != null ? o.maxTickGapMs : MAX_TICK_GAP_MS;
  const closes = [];
  const enough = (t - series[0][0]) / MIN >= n + lb;
  let j = 0, last = null, lastTs = null;
  for (let k = n - 1 + (enough ? lb : 0); k >= 0; k--) {
    const end = t - k * MIN;
    while (j < series.length && series[j][0] <= end) { if (series[j][1] > 0) { last = series[j][1]; lastTs = series[j][0]; } j++; }
    if (last == null || lastTs == null || end - lastTs > maxGap) return null;
    closes.push(last);
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const ma = mean(closes.slice(-n));
  const maPrev = enough && lb ? mean(closes.slice(0, n)) : null;
  return { ma, maPrev, maSlopePct: maPrev ? +((ma / maPrev - 1) * 100).toFixed(4) : null, risingLookbackCandles: lb, period: n, candles: n, source: 'own-history-1m', newestAgeSec: +((t - series[series.length - 1][0]) / 1000).toFixed(1) };
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
  const lb = o.risingLookbackCandles || 0;
  const prev = lb && rows.length >= n + lb ? rows.slice(lb, lb + n) : null;
  const maPrev = prev ? prev.reduce((a, r) => a + Number(r[4]), 0) / n : null;
  return { ma, maPrev, maSlopePct: maPrev ? +((ma / maPrev - 1) * 100).toFixed(4) : null, risingLookbackCandles: lb, period: n, candles: n, source: 'geckoterminal-ohlcv-1m', newestAgeSec: +age.toFixed(1), spanMin: +((use[0][0] - use[n - 1][0]) / 60 + 1).toFixed(0) };
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
// Convert GT 1m OHLCV [[tsSec, o, h, l, c, v], ...] into [tsMs, close] ticks at each candle's close (end of minute).
function ticksFromOhlcv(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(r => Array.isArray(r) && r.length >= 5 && Number(r[4]) > 0 && Number(r[0]) > 0)
    .map(r => [Number(r[0]) * 1000 + MIN, Number(r[4])])
    .sort((a, b) => a[0] - b[0]);
}
// Merge a GT (or other) 1m OHLCV window into the bot's own tick series. Existing own ticks at the same
// minute win (they are the live DexScreener print); GT fills holes and bootstraps a new series.
function mergeOhlcvTicks(ticks, pairAddress, list, t) {
  if (!ticks || !pairAddress) return 0;
  const incoming = ticksFromOhlcv(list);
  if (!incoming.length) return 0;
  const s = ticks[pairAddress] || (ticks[pairAddress] = []);
  const have = new Set(s.map(p => Math.floor(p[0] / MIN)));
  let added = 0;
  for (const p of incoming) {
    const bucket = Math.floor(p[0] / MIN);
    if (have.has(bucket)) continue;
    s.push(p); have.add(bucket); added++;
  }
  s.sort((a, b) => a[0] - b[0]);
  while (s.length && t - s[0][0] > KEEP_MIN * MIN) s.shift();
  return added;
}
function coverageStats(ticks, t, period) {
  let pools = 0, withPeriod = 0, newestAgeSec = null;
  for (const s of Object.values(ticks || {})) {
    if (!s || !s.length) continue;
    pools++;
    if ((t - s[0][0]) / MIN >= period) withPeriod++;
    const age = (t - s[s.length - 1][0]) / 1000;
    if (newestAgeSec == null || age < newestAgeSec) newestAgeSec = +age.toFixed(1);
  }
  return { pools, withPeriod, newestAgeSec };
}
function isTransientGt(e) {
  if (!e) return false;
  if (e.rateLimited || e.cooldown || e.deferred) return true;
  const m = String(e.message || e);
  return /429|cooldown|token bucket|timeout|ECONNRESET|socket|unavailable/i.test(m);
}
function makeM15(limiter) {
  const cache = new Map(), lists = new Map(), inflight = new Map();
  const stats = {
    ownHistory: 0, gtCalls: 0, gtOk: 0, gtNoData: 0, gtErrors: 0, cacheHits: 0, gtDeferred: 0, inFlightHits: 0, seeded: 0,
    method: 'own ~45 s pool price history resampled to 1 min when it covers >=50 min (gaps > 3 min fail closed), else GeckoTerminal 1m OHLCV (>=50 candles, newest <=3 min old, cached 3 min); none -> reject',
    lastError: null
  };
  const bucket = { tokens: GT_MAX_PER_MIN, last: 0, cap: GT_MAX_PER_MIN, perMs: MIN };
  function takeToken(t) {
    const elapsed = Math.max(0, t - (bucket.last || t));
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + elapsed * bucket.cap / bucket.perMs);
    bucket.last = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  async function fetchOhlcv(pairAddress, t) {
    const hit = lists.get(pairAddress);
    if (hit && t - hit.at < OHLC_CACHE_MS) { stats.cacheHits++; return hit; }
    if (inflight.has(pairAddress)) { stats.inFlightHits++; return inflight.get(pairAddress); }
    const pending = (async () => {
      if (!takeToken(t)) {
        stats.gtDeferred++;
        const e = new Error('gecko token bucket');
        e.deferred = true; e.rateLimited = true;
        stats.lastError = e.message;
        throw e;
      }
      stats.gtCalls++;
      try {
        const res = await limiter.get('gecko', GT + pairAddress + '/ohlcv/minute?aggregate=1&limit=60&currency=usd', { headers: { accept: 'application/json' } });
        const list = res && res.data && res.data.data && res.data.data.attributes && res.data.data.attributes.ohlcv_list;
        const entry = { at: t, list: Array.isArray(list) ? list : null };
        lists.set(pairAddress, entry);
        if (lists.size > 500) lists.delete(lists.keys().next().value);
        if (entry.list && entry.list.length) stats.gtOk++; else stats.gtNoData++;
        return entry;
      } catch (e) {
        stats.gtErrors++;
        stats.lastError = String(e.message || e).slice(0, 80);
        if (isTransientGt(e)) { e.deferred = true; }
        throw e;
      }
    })();
    inflight.set(pairAddress, pending);
    try { return await pending; } finally { if (inflight.get(pairAddress) === pending) inflight.delete(pairAddress); }
  }
  async function gt(pairAddress, t = Date.now()) {
    const c = cache.get(pairAddress);
    if (c && t - c.at < OHLC_CACHE_MS) { stats.cacheHits++; return c.r; }
    let r = null;
    try {
      const entry = await fetchOhlcv(pairAddress, t);
      r = entry && entry.list ? m15FromOhlcv(entry.list, t) : null;
    } catch (e) { r = null; }
    cache.set(pairAddress, { at: t, r });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return r;
  }
  // t90u: prior high from the same cached GT candles (one call serves m15 and the breakout).
  async function priorHighGt(pairAddress, t, o) {
    try {
      const l = await fetchOhlcv(pairAddress, t);
      return l && l.list ? priorHighFromOhlcv(l.list, t, o) : null;
    } catch (e) { return null; }
  }
  // t93u: 50-period SMA from the same cached GT candles. Transient 429 / cooldown / bucket / timeout
  // returns { error, deferred: true } so the engine can retry next scan without a final reject.
  async function smaGt(pairAddress, t, o) {
    try {
      const l = await fetchOhlcv(pairAddress, t);
      if (!l) return { error: stats.lastError || 'GeckoTerminal unavailable', deferred: true };
      return l.list ? smaFromOhlcv(l.list, t, o) : null;
    } catch (e) {
      return { error: String(e.message || e).slice(0, 80), deferred: true };
    }
  }
  function lastOhlcv(pairAddress) {
    const l = lists.get(pairAddress);
    return l && l.list ? l.list : null;
  }
  return { gt, priorHighGt, smaGt, lastOhlcv, stats, _bucket: bucket };
}

module.exports = {
  smaFromTicks, smaFromOhlcv, recordTick, pruneTicks, m15FromTicks, m15FromOhlcv,
  priorHighFromTicks, priorHighFromOhlcv, makeM15, KEEP_MIN, OHLC_CACHE_MS, GT_MAX_PER_MIN, MAX_TICK_GAP_MS,
  ticksFromOhlcv, mergeOhlcvTicks, coverageStats
};
