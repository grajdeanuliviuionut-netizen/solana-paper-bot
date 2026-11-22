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
// through the limiter's 'rpc' bucket (400 ms apart, 30 s pause after a 429). Read-only: no transaction is built.
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

function makeTop10(limiter, opts = {}) {
  const url = process.env.BOOKS_RPC_URL || PUBLIC_RPC;
  const cache = new Map();
  const stats = { checks: 0, cacheHits: 0, rpcCalls: 0, ok: 0, errors: 0, byReason: {}, lastError: null, source: process.env.BOOKS_RPC_URL ? 'BOOKS_RPC_URL' : 'public mainnet-beta', method: 'getTokenSupply + getTokenLargestAccounts + getMultipleAccounts(owner); pool/AMM-authority/burn owners excluded; cached 10 min' };
  const ttl = r => (r.ok ? (opts.ttlMs || 600000) : 120000);
  async function rpc(method, params) {
    stats.rpcCalls++;
    const res = await limiter.post('rpc', url, { jsonrpc: '2.0', id: 1, method, params });
    const body = res && res.data;
    if (!body || body.error || body.result === undefined) throw new Error((body && body.error && body.error.message) || method + ': no result');
    return body.result;
  }
  async function check(mint, pairAddress, now = Date.now()) {
    stats.checks++;
    const key = mint + ':' + (pairAddress || '');
    const c = cache.get(key);
    if (c && now - c.checkedAtMs < ttl(c)) { stats.cacheHits++; return c; }
    let r;
    try {
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
    } catch (e) {
      stats.errors++;
      r = { ok: false, reason: 'top10: rpc error', error: String(e.message || e).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 100) };
      stats.lastError = r.error;
    }
    r.checkedAtMs = now; r.checkedAt = new Date(now).toISOString(); r.source = 'solana-rpc';
    cache.set(key, r);
    if (r.ok) stats.ok++; else stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return r;
  }
  return { check, stats, _cache: cache };
}

module.exports = { makeTop10, evaluate, AMM_AUTHORITIES, BURN };
