// Mint + freeze authority check (read-only Solana RPC getAccountInfo, jsonParsed) for the 4 books.
// Fails closed: RPC error, missing account or unparsed data = reject. Cached per mint:
// pass 24 h (revoked authorities can never be re-set), reject 30 min, RPC error 2 min.
// Endpoint: BOOKS_RPC_URL if set, else the public mainnet-beta RPC. The app's RPC_URL / wallet env is
// never read here, and the URL is never logged. Read-only: getAccountInfo only.
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Token-2022 extensions that let an issuer move, freeze, tax or block holders' tokens.
const BAD_EXTENSIONS = new Set(['permanentDelegate', 'transferHook', 'nonTransferable', 'pausableConfig', 'defaultAccountState', 'confidentialTransferMint']);

function evaluateMintAccount(value) {
  if (!value) return { pass: false, reason: 'missing-data: mint account not found' };
  const parsed = value.data && value.data.parsed;
  if (!parsed || parsed.type !== 'mint' || !parsed.info) return { pass: false, reason: 'missing-data: mint not parsed' };
  const info = parsed.info;
  if (!('mintAuthority' in info) || !('freezeAuthority' in info)) return { pass: false, reason: 'missing-data: authorities' };
  const out = { mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority, decimals: info.decimals, program: value.owner === TOKEN_2022 ? 'token-2022' : 'spl-token' };
  if (info.mintAuthority) return Object.assign(out, { pass: false, reason: 'mint-authority-not-revoked' });
  if (info.freezeAuthority) return Object.assign(out, { pass: false, reason: 'freeze-authority-not-revoked' });
  if (!Number.isInteger(info.decimals)) return Object.assign(out, { pass: false, reason: 'missing-data: decimals' });
  for (const ext of info.extensions || []) {
    const name = ext && ext.extension;
    if (BAD_EXTENSIONS.has(name)) return Object.assign(out, { pass: false, reason: 'token-2022 extension ' + name });
    if (name === 'transferFeeConfig') {
      const st = ext.state || {};
      const fee = Math.max(Number(st.newerTransferFee && st.newerTransferFee.transferFeeBasisPoints) || 0, Number(st.olderTransferFee && st.olderTransferFee.transferFeeBasisPoints) || 0);
      if (fee > 0) return Object.assign(out, { pass: false, reason: 'token-2022 transfer fee ' + fee + 'bps' });
    }
  }
  return Object.assign(out, { pass: true, reason: 'mint+freeze revoked' });
}

function makeMintAuth(limiter, opts = {}) {
  const url = process.env.BOOKS_RPC_URL || PUBLIC_RPC;
  const cache = new Map();
  const stats = { checks: 0, rpcCalls: 0, cacheHits: 0, passed: 0, rejected: 0, errors: 0, byReason: {}, source: process.env.BOOKS_RPC_URL ? 'BOOKS_RPC_URL' : 'public mainnet-beta' };
  const ttl = r => (r.error ? 120000 : r.pass ? 24 * 3600000 : 30 * 60000);
  async function check(mint, now = Date.now()) {
    stats.checks++;
    const c = cache.get(mint);
    if (c && now - c.checkedAtMs < ttl(c)) { stats.cacheHits++; return c; }
    let r;
    try {
      stats.rpcCalls++;
      const res = await limiter.post('rpc', url, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }] });
      const body = res && res.data;
      if (!body || body.error || !body.result) throw new Error((body && body.error && body.error.message) || 'no result');
      r = evaluateMintAccount(body.result.value);
    } catch (e) {
      stats.errors++;
      r = { pass: false, reason: 'missing-data: rpc error', error: String(e.message || e).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 100) };
    }
    r.checkedAtMs = now; r.checkedAt = new Date(now).toISOString(); r.source = 'solana-rpc getAccountInfo';
    cache.set(mint, r);
    if (r.pass) stats.passed++; else { stats.rejected++; stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1; }
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return r;
  }
  return { check, stats, _cache: cache };
}

module.exports = { makeMintAuth, evaluateMintAccount, PUBLIC_RPC };
