// Hard rug gate. Fails CLOSED: any missing data or API error = reject.
// Data: RugCheck public report API (free) + Jupiter verified token search for clone checks.
const axios = require('axios');
const config = require('./config');

const RUGCHECK = process.env.RUGCHECK_API_URL || 'https://api.rugcheck.xyz/v1';
const JUP_TOKENS = process.env.JUPITER_TOKENS_URL || 'https://lite-api.jup.ag/tokens/v2';

let http = axios;
function setHttp(h) { http = h; }

const reportCache = new Map(); // mint -> { at, report, error }
const cloneCache = new Map();  // normSymbol -> { at, verified: [{mint, symbol, name}] }

async function fetchReport(mint) {
  const c = reportCache.get(mint);
  if (c && Date.now() - c.at < config.rugGate.cacheMs) return c;
  let entry;
  try {
    const res = await http.get(`${RUGCHECK}/tokens/${mint}/report`, { timeout: 8000 });
    entry = { at: Date.now(), report: res.data, error: null };
  } catch (e) {
    entry = { at: Date.now(), report: null, error: (e.response && `HTTP ${e.response.status}`) || e.message };
    // Cache failures briefly so we don't hammer the API.
    entry.at = Date.now() - config.rugGate.cacheMs + 60000;
  }
  reportCache.set(mint, entry);
  return entry;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Clone check (Jupiter token search): one retry after a short backoff before failing closed
// (16:15 RA: transient Jupiter errors were rejecting otherwise-clean candidates). Module setting,
// outside every strategy hash; env CLONE_CHECK_RETRY_MS (default 750, 0 = no wait).
const CLONE_RETRY_MS = Number.isFinite(Number(process.env.CLONE_CHECK_RETRY_MS)) && process.env.CLONE_CHECK_RETRY_MS !== '' && process.env.CLONE_CHECK_RETRY_MS != null ? Number(process.env.CLONE_CHECK_RETRY_MS) : 750;
const cloneStats = { retries: 0, recovered: 0, failedClosed: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function verifiedTokensFor(symbol, { retryMs = CLONE_RETRY_MS } = {}) {
  const key = norm(symbol);
  // Non-latin/empty symbols cannot collide with a verified latin ticker; nothing to compare.
  if (!key) return { ok: true, verified: [] };
  const c = cloneCache.get(key);
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await http.get(`${JUP_TOKENS}/search`, { timeout: 6000, params: { query: symbol } });
      const verified = (Array.isArray(res.data) ? res.data : [])
        .filter(t => t.isVerified)
        .map(t => ({ mint: t.id, symbol: t.symbol, name: t.name }));
      const entry = { ok: true, at: Date.now(), verified, attempts: attempt };
      cloneCache.set(key, entry);
      if (attempt > 1) cloneStats.recovered++;
      return entry;
    } catch (e) {
      lastErr = (e.response && `HTTP ${e.response.status}`) || e.message;
      if (attempt === 1) {
        cloneStats.retries++;
        console.log(`[rugGate] clone check failed for ${symbol} (${lastErr}); retrying once in ${retryMs}ms`);
        if (retryMs > 0) await sleep(retryMs);
      }
    }
  }
  cloneStats.failedClosed++;
  return { ok: false, verified: [], error: lastErr, attempts: 2 };
}

// Pure: clone decision given candidate + verified list.
function cloneCheck({ mint, symbol, name }, verified, majors = config.majorTokens) {
  const s = norm(symbol), n = norm(name);
  const major = majors[s];
  if (major && major !== mint) return { clone: true, of: `${symbol} (major ${major})` };
  for (const v of verified) {
    if (v.mint === mint) return { clone: false, verifiedSelf: true };
  }
  for (const v of verified) {
    if (v.mint !== mint && ((s && norm(v.symbol) === s) || (n && n.length > 3 && norm(v.name) === n))) {
      return { clone: true, of: `${v.symbol} (verified ${v.mint})` };
    }
  }
  return { clone: false };
}

function holdersExPool(report) {
  const poolOwners = new Set();
  for (const m of report.markets || []) {
    if (m.pubkey) poolOwners.add(m.pubkey);
    if (m.liquidityAAccount && m.liquidityAAccount.owner) poolOwners.add(m.liquidityAAccount.owner);
    if (m.liquidityBAccount && m.liquidityBAccount.owner) poolOwners.add(m.liquidityBAccount.owner);
  }
  for (const [addr, info] of Object.entries(report.knownAccounts || {})) {
    if (info && ['AMM', 'LOCKER', 'CLOB'].includes(info.type)) poolOwners.add(addr);
  }
  return (report.topHolders || []).filter(h => !poolOwners.has(h.owner) && !poolOwners.has(h.address));
}

// Pure: evaluate a RugCheck report. Returns { pass, reasons[], facts }.
function evaluateReport(report, { pairAddress, dexLiquidityUsd, extra } = {}, g = config.rugGate) {
  const reasons = [];
  if (!report || typeof report !== 'object') return { pass: false, reasons: ['no-report'], facts: {} };
  const tok = report.token || {};
  const mintAuth = report.mintAuthority !== undefined ? report.mintAuthority : tok.mintAuthority;
  const freezeAuth = report.freezeAuthority !== undefined ? report.freezeAuthority : tok.freezeAuthority;
  if (g.requireMintRevoked && mintAuth) reasons.push('mint-authority');
  if (g.requireFreezeRevoked && freezeAuth) reasons.push('freeze-authority');
  if (g.rejectRugged && report.rugged) reasons.push('rugged');

  const market = (report.markets || []).find(m => m.pubkey === pairAddress);
  const lpLockedPct = market && market.lp ? Number(market.lp.lpLockedPct) : null;
  if (lpLockedPct == null || Number.isNaN(lpLockedPct)) reasons.push('lp-data-missing');
  else if (lpLockedPct < g.minLpLockedPct) reasons.push(`lp-locked ${lpLockedPct.toFixed(0)}%<${g.minLpLockedPct}`);

  const holders = holdersExPool(report);
  if (!report.topHolders) reasons.push('holder-data-missing');
  const top10 = holders.slice(0, 10).reduce((a, h) => a + (Number(h.pct) || 0), 0);
  const maxSingle = holders.reduce((a, h) => Math.max(a, Number(h.pct) || 0), 0);
  const top10Max = Math.min(g.top10MaxPct, extra && extra.top10MaxPct || Infinity);
  const singleMax = Math.min(g.singleHolderMaxPct, extra && extra.singleHolderMaxPct || Infinity);
  if (top10 >= top10Max) reasons.push(`top10 ${top10.toFixed(1)}%>=${top10Max}`);
  if (maxSingle > singleMax) reasons.push(`holder ${maxSingle.toFixed(1)}%>${singleMax}`);

  if (extra) {
    const risks = report.risks || [];
    if (extra.rejectDangerRisks && risks.some(r => /danger|critical/i.test(r.level || ''))) reasons.push('rugcheck-danger');
    if (extra.graphInsidersMax != null && (report.graphInsidersDetected || 0) > extra.graphInsidersMax) {
      reasons.push(`insiders ${report.graphInsidersDetected}>${extra.graphInsidersMax}`);
    }
    if (extra.maxRugcheckToDexLiqRatioMin && dexLiquidityUsd > 0) {
      const rcLiq = Number(report.totalMarketLiquidity) || 0;
      if (rcLiq < dexLiquidityUsd * extra.maxRugcheckToDexLiqRatioMin) reasons.push('liq-source-disagree');
    }
    if (extra.rejectCreatorRugHistory) {
      const ct = Array.isArray(report.creatorTokens) ? report.creatorTokens : [];
      if (risks.some(r => /creator.*(rug|history)/i.test(r.name || '')) || ct.some(t => t && (t.rugged || /rug/i.test(String(t.status || ''))))) reasons.push('creator-rug-history');
    }
    const ext = report.token_extensions || {};
    for (const k of extra.token2022RejectExtensions || []) {
      // Spec names are prefixes of RugCheck's keys (confidentialTransfer -> confidentialTransferMint, ...).
      for (const [key, v] of Object.entries(ext)) {
        if (key.toLowerCase().startsWith(k.toLowerCase()) && v && !(typeof v === 'object' && Object.keys(v).length === 0)) { reasons.push(`ext-${key}`); break; }
      }
    }
  }
  return {
    pass: reasons.length === 0,
    reasons,
    facts: {
      mintAuthority: mintAuth || null, freezeAuthority: freezeAuth || null, lpLockedPct,
      top10ExPoolPct: +top10.toFixed(2), maxHolderExPoolPct: +maxSingle.toFixed(2),
      rugcheckScore: report.score_normalised ?? report.score ?? null,
      decimals: tok.decimals ?? null, name: report.tokenMeta && report.tokenMeta.name || null
    }
  };
}

// Full async gate for one candidate. Always returns a result object; never throws.
async function checkToken({ mint, symbol, name, pairAddress, dexLiquidityUsd, extra }) {
  if (!config.rugGate.enabled) return { pass: true, reasons: ['gate-disabled'], facts: {} };
  try {
    const { report, error } = await fetchReport(mint);
    if (!report) return { pass: false, reasons: [`rugcheck-error ${error}`], facts: {} };
    const res = evaluateReport(report, { pairAddress, dexLiquidityUsd, extra });
    const tokenName = name || res.facts.name;
    const v = await verifiedTokensFor(symbol);
    if (!v.ok) res.reasons.push('clone-check-unavailable');
    else {
      const c = cloneCheck({ mint, symbol, name: tokenName }, v.verified);
      if (c.clone) res.reasons.push(`clone-of ${c.of}`);
      res.facts.verified = !!c.verifiedSelf;
    }
    res.pass = res.reasons.length === 0;
    return res;
  } catch (e) {
    return { pass: false, reasons: [`gate-exception ${e.message}`], facts: {} };
  }
}

module.exports = { checkToken, evaluateReport, cloneCheck, holdersExPool, fetchReport, setHttp, verifiedTokensFor, cloneStats, clearCaches: () => { reportCache.clear(); cloneCache.clear(); } };
