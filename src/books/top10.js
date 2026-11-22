// t86u (Liviu 22 Nov 12:12): top-10 holder concentration for runner-hunter v3, from read-only Solana RPC.
// Method: getTokenSupply(mint) + getTokenLargestAccounts(mint) (the 20 largest token accounts) +
// getMultipleAccounts(jsonParsed) on those accounts to read each account's OWNER. Balances are summed per
// owner, then these owners are excluded as not-holders:
//   - the pool itself (owner == the DexScreener pair address: PumpSwap, Orca, Meteora DLMM, Raydium CLMM vaults)
//   - known AMM vault authorities (Raydium AMM v4, Raydium CPMM, Raydium LaunchLab, Meteora DAMM v2)
//   - burn / incinerator addresses
// top10Pct = the 10 largest remaining owners' balance / supply x 100. Anything else (lockers, other pools of the
// same token, exchanges) is COUNTED, so the number is conservative. Fails closed: any RPC error, missing supply
// or unparsed account -> { ok: false } (the entry is rejected). Cached per mint 10 min (errors 2 min). Calls go
// through its own limiter bucket 'top10rpc' (1.2 s apart, no retries, 60 s pause after a 429, so a 429 here never stalls the mint-authority check on 'rpc'). Read-only: no transaction is built.
// t90u (Liviu 22 Nov 13:56): the public RPC answers getTokenLargestAccounts with 429 "Too many requests for a
// specific RPC call" every time, so the PRIMARY source is now the free RugCheck token report
// (GET https://api.rugcheck.xyz/v1/tokens/<mint>/report, limiter bucket 'rugcheck': 1 request / 3 s, no retries,
// 10 min pause after a 429). Its topHolders (the 20 largest token accounts, with owner and % of supply) are
// summed per owner and these are excluded as not-holders: every market of the token in the report (pool pubkey
// and its liquidityA/liquidityB vault accounts), the DexScreener pair, knownAccounts of type AMM / LOCKER / BURN /
// PROGRAM, the AMM authorities below and burn owners. The report's mint and freeze authority are returned too.
// Report missing / malformed / unavailable -> the RPC method below as fallback; both fail -> { ok: false }.
const RUGCHECK = process.env.RUGCHECK_URL || 'https://api.rugcheck.xyz/v1/tokens/';
const POOLISH = new Set(['AMM', 'LOCKER', 'BURN', 'PROGRAM']);
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const BURN = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111', 'deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead']);
const AMM_AUTHORITIES = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM v4 authority',
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL': 'Raydium CPMM authority',
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh': 'Raydium LaunchLab authority',
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC': 'Meteora DAMM v2 pool authority'
};

// Pure: supplyUi (number), accounts [{ address, uiAmount, owner }], pairAddress -> result.
function evaluate(supplyUi, accounts, pairAddress) {
  if (!(supplyUi > 0)) return { ok: false, reason: 'top10: supply unknown' };
  if (!Array.isArray(accounts) || !accounts.length) return { ok: false, reason: 'top10: largest accounts unknown' };
  if (accounts.some(a => !a || !a.owner || !Number.isFinite(Number(a.uiAmount)))) return { ok: false, reason: 'top10: account owner unknown' };
  const byOwner = new Map(), excluded = [];
  for (const a of accounts) {
    const why = a.owner === pairAddress ? 'pool (owner = pair)' : AMM_AUTHORITIES[a.owner] || (BURN.has(a.owner) || BURN.has(a.address) ? 'burn' : null);
    if (why) { excluded.push({ address: a.address, owner: a.owner, pct: +((Number(a.uiAmount) / supplyUi) * 100).toFixed(3), why }); continue; }
    byOwner.set(a.owner, (byOwner.get(a.owner) || 0) + Number(a.uiAmount));
  }
  const owners = [...byOwner.entries()].sort((x, y) => y[1] - x[1]);
  const top = owners.slice(0, 10);
  const top10Pct = (top.reduce((s, x) => s + x[1], 0) / supplyUi) * 100;
  return { ok: true, top10Pct: +top10Pct.toFixed(3), maxHolderPct: top.length ? +((top[0][1] / supplyUi) * 100).toFixed(3) : 0, maxHolderOwner: top.length ? top[0][0] : null,
    holdersCounted: owners.length, accountsSeen: accounts.length, excluded, excludedPct: +excluded.reduce((s, e) => s + e.pct, 0).toFixed(3) };
}

// Pure: RugCheck report -> same shape as evaluate().
function evaluateRugcheck(d, pairAddress) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.topHolders) || !d.topHolders.length) return { ok: false, reason: 'top10: rugcheck report without topHolders' };
  if (d.topHolders.some(h => !h || !h.owner || !Number.isFinite(Number(h.pct)))) return { ok: false, reason: 'top10: rugcheck holder owner/pct unknown' };
  const known = d.knownAccounts && typeof d.knownAccounts === 'object' ? d.knownAccounts : {};
  const pool = new Set([pairAddress].filter(Boolean));
  for (const m of Array.isArray(d.markets) ? d.markets : []) for (const k of ['pubkey', 'liquidityA', 'liquidityB']) if (m && m[k]) pool.add(m[k]);
  const byOwner = new Map(), excluded = [];
  for (const h of d.topHolders) {
    const kt = ((known[h.owner] || known[h.address] || {}).type) || '';
    const why = pool.has(h.owner) || pool.has(h.address) ? 'pool / pool vault' : AMM_AUTHORITIES[h.owner] || (POOLISH.has(kt) ? 'knownAccount ' + kt : null) || (BURN.has(h.owner) || BURN.has(h.address) ? 'burn' : null);
    if (why) { excluded.push({ address: h.address, owner: h.owner, pct: +Number(h.pct).toFixed(3), why }); continue; }
    byOwner.set(h.owner, (byOwner.get(h.owner) || 0) + Number(h.pct));
  }
  const top = [...byOwner.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
  const tok = d.token || {};
  const auth = k => (d[k] !== undefined ? d[k] : tok[k] !== undefined ? tok[k] : undefined);
  return { ok: true, top10Pct: +top.reduce((a, x) => a + x[1], 0).toFixed(3), maxHolderPct: top.length ? +top[0][1].toFixed(3) : 0, maxHolderOwner: top.length ? top[0][0] : null,
    holdersCounted: byOwner.size, accountsSeen: d.topHolders.length, excluded, excludedPct: +excluded.reduce((a, e) => a + e.pct, 0).toFixed(3),
    mintAuthority: auth('mintAuthority') === undefined ? 'unknown' : auth('mintAuthority'), freezeAuthority: auth('freezeAuthority') === undefined ? 'unknown' : auth('freezeAuthority'),
    totalHolders: d.totalHolders == null ? null : d.totalHolders, rugged: d.rugged === true };
}

function makeTop10(limiter, opts = {}) {
  const url = process.env.BOOKS_RPC_URL || PUBLIC_RPC;
  const cache = new Map();
  const stats = { checks: 0, cacheHits: 0, rpcCalls: 0, ok: 0, errors: 0, byReason: {}, lastError: null, source: process.env.BOOKS_RPC_URL ? 'BOOKS_RPC_URL' : 'public mainnet-beta', method: (opts.rugcheck !== false ? 'primary: RugCheck report topHolders per owner (pool, pool vaults, AMM/locker/burn known accounts excluded); fallback: ' : '') + 'getTokenSupply + getTokenLargestAccounts + getMultipleAccounts(owner); pool/AMM-authority/burn owners excluded; cached 10 min' };
  const ttl = r => (r.ok ? (opts.ttlMs || 600000) : 120000);
  async function rpc(method, params) {
    stats.rpcCalls++;
    const res = await limiter.post(opts.bucket || 'top10rpc', url, { jsonrpc: '2.0', id: 1, method, params });
    const body = res && res.data;
    if (!body || body.error || body.result === undefined) throw new Error((body && body.error && body.error.message) || method + ': no result');
    return body.result;
  }
  async function check(mint, pairAddress, now = Date.now()) {
    stats.checks++;
    const key = mint + ':' + (pairAddress || '');
    const c = cache.get(key);
    if (c && now - c.checkedAtMs < ttl(c)) { stats.cacheHits++; return c; }
    let r = null, rcErr = null;
    if (opts.rugcheck !== false) {
      try {
        stats.rugcheckCalls = (stats.rugcheckCalls || 0) + 1;
        const res = await limiter.get(opts.rugcheckBucket || 'rugcheck', RUGCHECK + encodeURIComponent(mint) + '/report', { timeout: 10000 });
        const e = evaluateRugcheck(res && res.data, pairAddress);
        if (e.ok) { r = e; r.source = 'rugcheck.xyz report'; stats.rugcheckOk = (stats.rugcheckOk || 0) + 1; }
        else rcErr = e.reason;
      } catch (e) { rcErr = 'rugcheck: ' + String((e && (e.status ? 'HTTP ' + e.status : e.message)) || 'error').slice(0, 60); }
      if (rcErr) { stats.rugcheckErrors = (stats.rugcheckErrors || 0) + 1; stats.lastRugcheckError = rcErr; }
    }
    if (!r) try {
      const sup = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]);
      const supplyUi = Number(sup && sup.value && (sup.value.uiAmountString != null ? sup.value.uiAmountString : sup.value.uiAmount));
      const big = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
      const list = (big && big.value) || [];
      const infos = list.length ? await rpc('getMultipleAccounts', [list.map(a => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]) : { value: [] };
      const accts = list.map((a, i) => {
        const v = infos && infos.value && infos.value[i];
        const owner = v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.owner;
        return { address: a.address, uiAmount: Number(a.uiAmountString != null ? a.uiAmountString : a.uiAmount), owner: owner || null };
      });
      r = evaluate(supplyUi, accts, pairAddress);
      r.source = 'solana-rpc' + (rcErr ? ' (fallback: ' + rcErr + ')' : '');
    } catch (e) {
      stats.errors++;
      r = { ok: false, reason: 'top10: rpc error', error: String(e.message || e).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 100), rugcheckError: rcErr };
      r.source = 'none';
      stats.lastError = r.error;
    }
    r.checkedAtMs = now; r.checkedAt = new Date(now).toISOString();
    cache.set(key, r);
    if (r.ok) stats.ok++; else stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return r;
  }
  return { check, stats, _cache: cache };
}

module.exports = { makeTop10, evaluate, evaluateRugcheck, AMM_AUTHORITIES, BURN };
