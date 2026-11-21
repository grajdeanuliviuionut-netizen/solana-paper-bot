// Books API budget (Jupiter quotes + read-only RPC), adapted from the rebuild's limiter. One queue per host bucket, one request in flight,
// a minimum gap between request starts, exponential backoff with jitter on 429/5xx (Retry-After
// honoured) and a bucket cooldown after repeated 429s. Every request in the terminal goes through here.
const axios = require('axios');

class Limiter {
  constructor(cfg, http = axios) {
    this.cfg = cfg;
    this.http = http;
    this.buckets = {};
    for (const [name, b] of Object.entries(cfg.buckets)) {
      this.buckets[name] = { name, ...b, chain: Promise.resolve(), lastStart: 0, cooldownUntil: 0,
        stats: { requests: 0, ok: 0, errors: 0, http429: 0, retries: 0, cooldownSkips: 0, inFlight: 0, last429At: null, lastError: null } };
    }
    this.sleep = ms => new Promise(r => setTimeout(r, ms));
  }
  setHttp(h) { this.http = h; }
  stats() {
    const out = {};
    for (const [n, b] of Object.entries(this.buckets)) out[n] = { ...b.stats, cooldownUntil: b.cooldownUntil > Date.now() ? new Date(b.cooldownUntil).toISOString() : null };
    return out;
  }
  total429() { return Object.values(this.buckets).reduce((a, b) => a + b.stats.http429, 0); }
  backoffMs(attempt, retryAfter) {
    if (retryAfter > 0) return Math.min(this.cfg.maxBackoffMs, retryAfter * 1000);
    const exp = Math.min(this.cfg.maxBackoffMs, this.cfg.baseBackoffMs * 2 ** attempt);
    return Math.round(exp / 2 + Math.random() * exp / 2); // equal jitter
  }
  // Returns axios-like response; throws an Error with .status/.rateLimited/.cooldown on failure.
  post(bucketName, url, body, opts = {}) { return this.get(bucketName, url, opts, body); }
  get(bucketName, url, opts = {}, body) {
    const b = this.buckets[bucketName];
    if (!b) throw new Error('unknown limiter bucket ' + bucketName);
    const run = async () => {
      if (Date.now() < b.cooldownUntil) {
        b.stats.cooldownSkips++;
        const e = new Error(bucketName + ' in 429 cooldown'); e.cooldown = true; e.rateLimited = true; throw e;
      }
      let attempt = 0;
      for (;;) {
        const wait = b.lastStart + b.minGapMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        b.lastStart = Date.now();
        b.stats.requests++; b.stats.inFlight++;
        try {
          const res = body !== undefined ? await this.http.post(url, body, { timeout: 8000, ...opts }) : await this.http.get(url, { timeout: 8000, ...opts });
          b.stats.inFlight--; b.stats.ok++;
          return res;
        } catch (e) {
          b.stats.inFlight--;
          const status = e.response && e.response.status;
          const retryable = status === 429 || (status >= 500 && status < 600) || (!status && /timeout|ECONNRESET|socket/i.test(e.message || ''));
          if (status === 429) { b.stats.http429++; b.stats.last429At = new Date().toISOString(); }
          if (retryable && attempt < b.maxRetries) {
            b.stats.retries++;
            const ra = Number(e.response && e.response.headers && e.response.headers['retry-after']) || 0;
            await this.sleep(this.backoffMs(attempt, ra));
            attempt++;
            continue;
          }
          if (status === 429) b.cooldownUntil = Date.now() + b.cooldownMs;
          b.stats.errors++;
          b.stats.lastError = (status ? 'HTTP ' + status : e.message || 'error').slice(0, 120);
          const err = new Error(b.stats.lastError);
          err.status = status; err.rateLimited = status === 429; err.response = e.response;
          throw err;
        }
      }
    };
    const p = b.chain.then(run, run);
    b.chain = p.catch(() => {});
    return p;
  }
}

module.exports = { Limiter };
