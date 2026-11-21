// Graduation sniper v2 (Liviu t76u): LP lock/burn + holder concentration check from the free public
// RugCheck report (GET https://api.rugcheck.xyz/v1/tokens/<mint>/report). Read-only, no key.
// Budget: own limiter bucket 'rugcheck' (1 request / 3 s, no retries, 10 min pause after a 429), cached per
// mint (pass 5 min, reject 5 min, error 2 min). FAIL CLOSED: anything that cannot be determined rejects.
const API = process.env.RUGCHECK_URL || 'https://api.rugcheck.xyz/v1/tokens/';
const BURN = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
const POOLISH = new Set(['AMM', 'LOCKER', 'BURN', 'PROGRAM']);   // knownAccounts types that are not holders

// Pure evaluation of a RugCheck report. rules: { lpLockedMinPct, maxTop10Pct, maxSingleHolderPct, maxCreatorPct }.
// Returns { pass, category: 'lp'|'holders'|null, reason, lpLockedPct, top10Pct, maxHolderPct, creatorPct, ... }.
function evaluateReport(d, pairAddress, rules) {
  const out = { pass: false, category: 'lp', reason: null, lpLockedPct: null, top10Pct: null, maxHolderPct: null, maxHolderOwner: null, creator: null, creatorPct: null, holdersCounted: 0, rugged: null };
  if (!d || typeof d !== 'object') return Object.assign(out, { reason: 'lp: no RugCheck report' });
  out.rugged = d.rugged === true;
  const markets = Array.isArray(d.markets) ? d.markets : [];
  const m = markets.find(x => x && x.pubkey === pairAddress);
  if (!m || !m.lp || !Number.isFinite(Number(m.lp.lpLockedPct))) return Object.assign(out, { reason: 'lp: pool LP status unknown (pool not in report)' });
  out.lpLockedPct = +Number(m.lp.lpLockedPct).toFixed(2);
  if (out.lpLockedPct < rules.lpLockedMinPct) return Object.assign(out, { reason: 'lp: not locked/burned (< ' + rules.lpLockedMinPct + '%)' });
  if (out.rugged) return Object.assign(out, { reason: 'lp: RugCheck marks token rugged' });
  out.category = 'holders';
  const holders = Array.isArray(d.topHolders) ? d.topHolders : null;
  if (!holders || !holders.length) return Object.assign(out, { reason: 'holders: top holders unknown' });
  const known = d.knownAccounts && typeof d.knownAccounts === 'object' ? d.knownAccounts : {};
  const poolOwners = new Set(markets.map(x => x && x.pubkey).filter(Boolean));
  const counted = holders.filter(h => h && Number.isFinite(Number(h.pct)) && !poolOwners.has(h.owner) && !poolOwners.has(h.address) && !BURN.has(h.owner) &&
    !POOLISH.has(((known[h.owner] || known[h.address] || {}).type) || ''));
  if (holders.some(h => !h || !Number.isFinite(Number(h.pct)))) return Object.assign(out, { reason: 'holders: holder pct unknown' });
  counted.sort((a, b) => b.pct - a.pct);
  out.holdersCounted = counted.length;
  out.top10Pct = +counted.slice(0, 10).reduce((a, h) => a + Number(h.pct), 0).toFixed(2);
  out.maxHolderPct = counted.length ? +Number(counted[0].pct).toFixed(2) : 0;
  out.maxHolderOwner = counted.length ? counted[0].owner : null;
  out.creator = d.creator || null;
  if (out.creator) {
    const supply = Number(d.token && d.token.supply);
    const viaHolders = counted.filter(h => h.owner === out.creator).reduce((a, h) => a + Number(h.pct), 0);
    const viaBalance = supply > 0 && Number.isFinite(Number(d.creatorBalance)) ? (Number(d.creatorBalance) / supply) * 100 : null;
    const pctC = viaBalance != null ? Math.max(viaHolders, viaBalance) : (counted.some(h => h.owner === out.creator) ? viaHolders : null);
    if (pctC == null) return Object.assign(out, { reason: 'holders: creator balance unknown' });
    out.creatorPct = +pctC.toFixed(2);
  }
  if (out.top10Pct > rules.maxTop10Pct) return Object.assign(out, { reason: 'holders: top 10 hold > ' + rules.maxTop10Pct + '%' });
  if (out.maxHolderPct > rules.maxSingleHolderPct) return Object.assign(out, { reason: 'holders: single holder > ' + rules.maxSingleHolderPct + '%' });
  if (out.creator && out.creatorPct > rules.maxCreatorPct) return Object.assign(out, { reason: 'holders: creator holds > ' + rules.maxCreatorPct + '%' });
  return Object.assign(out, { pass: true, category: null, reason: 'lp ' + out.lpLockedPct + '% locked/burned, top10 ' + out.top10Pct + '%, max holder ' + out.maxHolderPct + '%' });
}

function makeHolderCheck(limiter, opts = {}) {
  const cache = new Map();
  const stats = { checks: 0, requests: 0, cacheHits: 0, passed: 0, rejected: 0, errors: 0, http429: 0, byReason: {} };
  const ttl = r => (r.error ? 120000 : 300000);
  async function check(mint, pairAddress, rules, now = Date.now()) {
    stats.checks++;
    const key = mint + '|' + pairAddress;
    const c = cache.get(key);
    let r;
    if (c && now - c.checkedAtMs < ttl(c)) { stats.cacheHits++; r = c; }
    else {
      let d = null, error = null;
      try {
        stats.requests++;
        const res = await limiter.get('rugcheck', API + encodeURIComponent(mint) + '/report', { timeout: 10000 });
        d = res && res.data;
      } catch (e) {
        error = String((e && (e.status ? 'HTTP ' + e.status : e.message)) || 'error').slice(0, 80);
        if (e && e.rateLimited) stats.http429++;
        stats.errors++;
      }
      r = error ? { pass: false, category: 'lp', reason: 'lp: RugCheck unavailable (' + error + ')', error } : evaluateReport(d, pairAddress, rules);
      r.checkedAtMs = now; r.checkedAt = new Date(now).toISOString(); r.source = 'rugcheck.xyz report';
      cache.set(key, r);
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
    }
    if (r.pass) stats.passed++; else { stats.rejected++; const k = String(r.reason).replace(/\(.*\)$/, '').trim(); stats.byReason[k] = (stats.byReason[k] || 0) + 1; }
    return r;
  }
  return { check, stats, _cache: cache };
}

module.exports = { makeHolderCheck, evaluateReport, BURN };
