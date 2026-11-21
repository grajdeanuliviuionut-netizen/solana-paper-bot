// PR13 (Liviu t68u): GeckoTerminal new_pools feed for the Graduation sniper ONLY.
// Exactly one GET .../networks/solana/new_pools per FEED_INTERVAL_MS (150 s), NO retries, never more
// than one in flight; after any 429 the feed pauses for PAUSE_AFTER_429_MS (10 min). The coin scan stays
// DexScreener only. Pools kept: pump.fun-origin pools that have MOVED to a trading pool (dex pumpswap,
// or a ...pump mint on any non-bonding-curve dex; GeckoTerminal's "pump-fun" bonding-curve pools are
// excluded) created < 15 min ago. Their mints are enriched with the DexScreener tokens batch (existing
// DexScreener limiter, tag 'newpools') for txns.m5 / liquidity / price, and those rows go to the
// graduation sniper's candidates (all other gates unchanged).
const axios = require('axios');
const poolPrice = require('./poolPrice');
const dataFetcher = require('./dataFetcher');

const URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const HOST = 'api.geckoterminal.com/new_pools';
const FEED_INTERVAL_MS = 150000;
const PAUSE_AFTER_429_MS = 10 * 60000;
const MAX_AGE_MS = 15 * 60000;
const TOKENS = 'https://api.dexscreener.com/tokens/v1/solana/';

let deps = { http: axios, now: () => Date.now() };
const watch = new Map(); // mint -> { pool, dex, createdAt }
const seenPools = new Set();
const stats = {
  calls: 0, ok: 0, rateLimited: 0, failures: 0, retries: 0, inFlight: 0, maxInFlight: 0,
  lastCallAt: null, lastStatus: null, last429At: null, pausedUntil: null, intervalSec: FEED_INTERVAL_MS / 1000,
  poolsSeen: 0, lastPoolsReturned: 0, pumpfunUnder15m: 0, pumpfunUnder15mWatching: 0, enrichRequests: 0, enrichFailures: 0, rowsEnriched: 0, candidatesPassed: 0
};
let lastAttempt = 0;
let pausedUntilMs = 0;
let inFlight = false;

function mintOf(p) {
  const id = p && p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
  return id ? String(id).replace(/^solana_/, '') : null;
}
function dexOf(p) { return String((p && p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id) || ''); }
// Graduated pump.fun coin on a trading pool (not the bonding curve itself).
function isGraduatedPump(mint, dex) {
  if (dex === 'pump-fun' || dex === 'pumpfun') return false;
  return dex === 'pumpswap' || /pump$/i.test(String(mint || ''));
}

// Parse one new_pools response into watch entries. Returns count kept.
function ingest(list, now) {
  let kept = 0;
  for (const p of list || []) {
    const a = (p && p.attributes) || {};
    const addr = a.address || (p && p.id);
    if (addr && !seenPools.has(addr)) { seenPools.add(addr); stats.poolsSeen += 1; }
    const created = Date.parse(a.pool_created_at || '');
    const mint = mintOf(p), dex = dexOf(p);
    if (!mint || !Number.isFinite(created) || now - created > MAX_AGE_MS || now - created < -60000) continue;
    if (!isGraduatedPump(mint, dex)) continue;
    if (!watch.has(mint)) stats.pumpfunUnder15m += 1;
    watch.set(mint, { pool: addr, dex, createdAt: created });
    kept++;
  }
  if (seenPools.size > 5000) seenPools.clear();
  return kept;
}

// At most one call per FEED_INTERVAL_MS, none while one is in flight or during the 429 pause.
async function maybeFetch() {
  const now = deps.now();
  if (inFlight || now < pausedUntilMs || (lastAttempt && now - lastAttempt < FEED_INTERVAL_MS)) return false;
  inFlight = true; lastAttempt = now;
  stats.calls += 1; stats.inFlight = 1; stats.maxInFlight = Math.max(stats.maxInFlight, 1);
  stats.lastCallAt = new Date(now).toISOString();
  try {
    const res = await deps.http.get(URL, { timeout: 10000, headers: { accept: 'application/json' } });
    stats.ok += 1; stats.lastStatus = res.status || 200;
    const list = (res.data && res.data.data) || [];
    stats.lastPoolsReturned = list.length;
    ingest(list, deps.now());
  } catch (e) {
    const status = e.response && e.response.status;
    stats.lastStatus = status || String(e.message || 'error').slice(0, 60);
    if (status === 429) {
      stats.rateLimited += 1; stats.last429At = new Date(deps.now()).toISOString();
      pausedUntilMs = deps.now() + PAUSE_AFTER_429_MS;
      stats.pausedUntil = new Date(pausedUntilMs).toISOString();
    } else stats.failures += 1;
  } finally { inFlight = false; stats.inFlight = 0; }
  return true;
}

// DexScreener rows (fresh) for the watched mints that are still < 15 min old and not in this scan.
async function candidateRows(scanPairs) {
  const now = deps.now();
  for (const [m, w] of watch) if (now - w.createdAt > MAX_AGE_MS) watch.delete(m);
  stats.pumpfunUnder15mWatching = watch.size;
  const inScan = new Set((scanPairs || []).map(r => r && r.mint).filter(Boolean));
  const mints = Array.from(watch.keys()).filter(m => !inScan.has(m)).slice(0, 30);
  const rows = (scanPairs || []).filter(r => r && watch.has(r.mint) && !r.stale);
  if (!mints.length) return rows;
  stats.enrichRequests += 1;
  try {
    const res = await poolPrice.mainLimiter.get(TOKENS + mints.join(','), { timeout: 10000 }, 'newpools');
    const data = Array.isArray(res.data) ? res.data : (res.data && res.data.pairs) || [];
    const best = dataFetcher.bestRowsByMint(data, new Set(mints), deps.now());
    for (const r of Object.values(best)) { rows.push(r); stats.rowsEnriched += 1; }
  } catch (e) { stats.enrichFailures += 1; }
  return rows;
}

function hostStats() { return { requests: stats.calls, rateLimited: stats.rateLimited, failures: stats.failures, skipped: 0 }; }
function snapshot() { return Object.assign({ source: URL, pauseAfter429Min: PAUSE_AFTER_429_MS / 60000, watching: Array.from(watch.entries()).map(([mint, w]) => ({ mint, pool: w.pool, dex: w.dex, ageMin: +((deps.now() - w.createdAt) / 60000).toFixed(1) })) }, stats); }
function _setDeps(d) { deps = Object.assign({}, deps, d); }
function _reset() { watch.clear(); seenPools.clear(); lastAttempt = 0; pausedUntilMs = 0; inFlight = false; for (const k of Object.keys(stats)) if (typeof stats[k] === 'number' && k !== 'intervalSec') stats[k] = 0; else if (k !== 'intervalSec') stats[k] = null; }

module.exports = { maybeFetch, candidateRows, ingest, isGraduatedPump, snapshot, hostStats, stats, HOST, FEED_INTERVAL_MS, PAUSE_AFTER_429_MS, _setDeps, _reset, _watch: watch };
