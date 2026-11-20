// Reusable Jupiter quote module. PR2 uses it for shadow quotes; the live path (PR3) uses the
// exact same getQuote() for real swaps. Free endpoints, no API key.
const axios = require('axios');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SWAP_API = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1';
const PRICE_API = process.env.JUPITER_PRICE_URL || 'https://lite-api.jup.ag/price/v3';

let http = axios; // injectable for tests
function setHttp(h) { http = h; }

// Raw (integer, smallest-unit) amount as a decimal string. Never goes through float for the result.
function toRaw(uiAmount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`bad decimals ${decimals}`);
  if (!(uiAmount > 0) || !Number.isFinite(uiAmount)) throw new Error(`bad amount ${uiAmount}`);
  // toFixed keeps exactly `decimals` digits; strip the dot to get the integer string.
  const [i, f = ''] = uiAmount.toFixed(decimals).split('.');
  const raw = BigInt(i + f.padEnd(decimals, '0'));
  if (raw <= 0n) throw new Error('amount rounds to 0');
  return raw.toString();
}
function fromRaw(raw, decimals) {
  return Number(BigInt(raw)) / 10 ** decimals;
}

// Validates that Jupiter answered the question we asked: same input/output mint, ExactIn with the
// same inAmount, and a positive integer outAmount. Anything else is treated as a failed quote.
function validateQuote(q, { inputMint, outputMint, amount }) {
  if (q.inputMint && q.inputMint !== inputMint) return `inputMint mismatch ${q.inputMint}`;
  if (q.outputMint && q.outputMint !== outputMint) return `outputMint mismatch ${q.outputMint}`;
  if (q.swapMode && q.swapMode !== 'ExactIn') return `swapMode ${q.swapMode}`;
  if (q.inAmount != null && String(q.inAmount) !== String(amount)) return `inAmount ${q.inAmount} != ${amount}`;
  if (!/^[0-9]+$/.test(String(q.outAmount || ''))) return `bad outAmount ${q.outAmount}`;
  const plan = q.routePlan || [];
  if (plan.length) {
    const first = plan[0].swapInfo || {}, last = plan[plan.length - 1].swapInfo || {};
    if (first.inputMint && first.inputMint !== inputMint) return 'route input mismatch';
    if (last.outputMint && last.outputMint !== outputMint) return 'route output mismatch';
  }
  return null;
}

async function getQuote({ inputMint, outputMint, amount, slippageBps = 300, timeoutMs = 6000 }) {
  const t0 = Date.now();
  try {
    const res = await http.get(`${SWAP_API}/quote`, {
      timeout: timeoutMs,
      params: { inputMint, outputMint, amount: String(amount), slippageBps, restrictIntermediateTokens: true }
    });
    const q = res.data || {};
    if (!q.outAmount || q.outAmount === '0') {
      return { ok: false, noRoute: true, error: q.error || 'no outAmount', ms: Date.now() - t0 };
    }
    const bad = validateQuote(q, { inputMint, outputMint, amount });
    if (bad) return { ok: false, noRoute: false, mismatch: true, error: `quote-mismatch: ${bad}`, ms: Date.now() - t0 };
    // Jupiter's priceImpactPct is a FRACTION string ("0.0123" = 1.23%); converted to percent here.
    const impact = parseFloat(q.priceImpactPct || '0') * 100;
    return {
      ok: true,
      noRoute: false,
      inputMint: q.inputMint || inputMint,
      outputMint: q.outputMint || outputMint,
      inAmount: String(q.inAmount != null ? q.inAmount : amount),
      outAmount: String(q.outAmount),
      priceImpactPct: Number.isFinite(impact) ? impact : null,
      routeLabels: (q.routePlan || []).map(r => r.swapInfo && r.swapInfo.label).filter(Boolean),
      quoteResponse: q,
      ms: Date.now() - t0
    };
  } catch (e) {
    const body = e.response && e.response.data;
    const msg = (body && (body.error || body.errorCode)) || e.message;
    const noRoute = /route|COULD_NOT_FIND|TOKEN_NOT_TRADABLE/i.test(String(msg));
    return { ok: false, noRoute, error: String(msg).slice(0, 200), status: e.response && e.response.status, ms: Date.now() - t0 };
  }
}

let solUsdCache = { v: null, at: 0 };
async function getSolUsd(fallback = null) {
  if (solUsdCache.v && Date.now() - solUsdCache.at < 60000) return solUsdCache.v;
  try {
    const res = await http.get(PRICE_API, { timeout: 5000, params: { ids: SOL_MINT } });
    const v = res.data && res.data[SOL_MINT] && res.data[SOL_MINT].usdPrice;
    if (v > 0) { solUsdCache = { v, at: Date.now() }; return v; }
  } catch (e) { /* fall through */ }
  return solUsdCache.v || fallback;
}

// Buy `sizeSol` of `mint`. Returns quoted USD price per token (USD in / UI tokens out).
// `decimals` must be the mint's decimals (RugCheck token.decimals, cross-checked with Jupiter's
// token list by the caller).
async function shadowBuyQuote({ mint, decimals, sizeSol, solUsd, slippageBps }) {
  if (!Number.isInteger(decimals)) return { ok: false, noRoute: false, error: 'missing decimals', quotedPriceUsd: null };
  const lamports = toRaw(sizeSol, 9);
  const q = await getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps });
  if (!q.ok) return { ...q, quotedPriceUsd: null };
  const tokens = fromRaw(q.outAmount, decimals);
  const solIn = fromRaw(q.inAmount, 9);
  return { ...q, rawOut: q.outAmount, tokens, quotedPriceUsd: tokens > 0 ? (solIn * solUsd) / tokens : null };
}

// Sell `tokens` (UI units) of `mint` for SOL. Returns quoted USD price per token.
async function shadowSellQuote({ mint, decimals, tokens, solUsd, slippageBps }) {
  if (!Number.isInteger(decimals) || !(tokens > 0)) return { ok: false, noRoute: false, error: 'missing decimals/amount', quotedPriceUsd: null };
  let raw;
  try { raw = toRaw(tokens, decimals); } catch (e) { return { ok: false, noRoute: false, error: e.message, quotedPriceUsd: null }; }
  return sellRawQuote({ mint, raw, decimals, solUsd, slippageBps });
}

// Sell an exact raw amount (e.g. the outAmount of a buy quote) back to SOL: the reverse check.
async function sellRawQuote({ mint, raw, decimals, solUsd, slippageBps }) {
  const q = await getQuote({ inputMint: mint, outputMint: SOL_MINT, amount: String(raw), slippageBps });
  if (!q.ok) return { ...q, quotedPriceUsd: null };
  const sol = fromRaw(q.outAmount, 9);
  const tokens = fromRaw(q.inAmount, decimals);
  return { ...q, solOut: sol, tokens, quotedPriceUsd: tokens > 0 ? (sol * solUsd) / tokens : null };
}

module.exports = { getQuote, getSolUsd, shadowBuyQuote, shadowSellQuote, sellRawQuote, validateQuote, toRaw, fromRaw, setHttp, SOL_MINT, SWAP_API };
