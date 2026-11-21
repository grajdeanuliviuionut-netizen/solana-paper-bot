// Rate-limit friendly GET for the pool scan (GeckoTerminal answers HTTP 429 when we go too fast).
// - one request at a time (maxConcurrent 1) with a minimum gap between requests
// - on 429: exponential backoff with full jitter (honours Retry-After), bounded retries
// - after a 429 that survives the retries the host is cooled down so the rest of the pass waits/skips
const axios = require('axios');

// create(): an independent limiter (own queue, gap, 429 cooldown and counters). The default export is
// the scan's limiter; the main-pool lookup (poolPrice.js) has its own so it never waits on the scan.
function create(overrides) {
  const opts = Object.assign({
    maxConcurrent: 1,
    minGapMs: 1500,
    retries: 2,
    baseDelayMs: 2000,
    maxDelayMs: 15000,
    hostCooldownMs: 30000
  }, overrides || {});
  let http = axios;
  let sleep = ms => new Promise(r => setTimeout(r, ms));
  let rand = Math.random;
  let now = () => Date.now();

  let active = 0;
  const waiters = [];
  let lastStart = 0;
  let coolUntil = 0;
  const stats = { requests: 0, rateLimited: 0, retries: 0, skipped: 0, last429At: null };

  async function acquire() {
    if (active < opts.maxConcurrent) { active++; return; }
    await new Promise(resolve => waiters.push(resolve));
    active++;
  }
  function release() {
    active--;
    const next = waiters.shift();
    if (next) next();
  }

  function backoffMs(attempt, retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    if (Number.isFinite(ra) && ra > 0) return Math.min(opts.maxDelayMs, ra * 1000) + Math.floor(rand() * 500);
    const cap = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt));
    return Math.floor(cap / 2 + rand() * (cap / 2)); // jitter in [cap/2, cap)
  }

  function is429(e) { return !!(e && e.response && e.response.status === 429); }

  async function get(url, config) {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        if (coolUntil > now()) {
          stats.skipped++;
          const err = new Error('rate-limit cooldown, skipped');
          err.rateLimited = true;
          throw err;
        }
        const gap = lastStart + opts.minGapMs - now();
        if (gap > 0) await sleep(gap);
        lastStart = now();
        stats.requests++;
        try {
          return await http.get(url, config);
        } catch (e) {
          if (!is429(e)) throw e;
          stats.rateLimited++;
          stats.last429At = new Date(now()).toISOString();
          if (attempt >= opts.retries) {
            coolUntil = now() + opts.hostCooldownMs;
            e.rateLimited = true;
            throw e;
          }
          stats.retries++;
          await sleep(backoffMs(attempt, e.response.headers && e.response.headers['retry-after']));
        }
      }
    } finally {
      release();
    }
  }

  // Test hooks.
  function _setDeps(d) {
    if (d.http) http = d.http;
    if (d.sleep) sleep = d.sleep;
    if (d.rand) rand = d.rand;
    if (d.now) now = d.now;
    if (d.opts) Object.assign(opts, d.opts);
  }
  function _reset() { active = 0; waiters.length = 0; lastStart = 0; coolUntil = 0; for (const k of Object.keys(stats)) stats[k] = k === 'last429At' ? null : 0; }

  return { get, backoffMs, stats, opts, _setDeps, _reset };
}

const scanLimiter = create();
module.exports = Object.assign(scanLimiter, { create });
