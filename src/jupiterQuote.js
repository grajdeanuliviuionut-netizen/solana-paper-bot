// Reusable Jupiter quote module. PR2 uses it for shadow quotes; the live path (PR3) uses the
// exact same getQuote() for real swaps. Free endpoints, no API key.
const axios = require('axios');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SWAP_API = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1';
const PRICE_API = process.env.JUPITER_PRICE_URL || 'https://lite-api.jup.ag/price/v3';

let http = axios; // injectable for tests
function setHttp(h) { http = h; }

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
    return {
      ok: true,
      noRoute: false,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      priceImpactPct: parseFloat(q.priceImpactPct || '0') * 100,
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

// Buy `sizeSol` of `mint`. Returns quoted USD price per token.
async function shadowBuyQuote({ mint, decimals, sizeSol, solUsd, slippageBps }) {
  const lamports = Math.round(sizeSol * 1e9);
  const q = await getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps });
  if (!q.ok || decimals == null) return { ...q, quotedPriceUsd: null };
  const tokens = Number(q.outAmount) / 10 ** decimals;
  return { ...q, tokens, quotedPriceUsd: tokens > 0 ? (sizeSol * solUsd) / tokens : null };
}

// Sell `tokens` (UI units) of `mint` for SOL. Returns quoted USD price per token.
async function shadowSellQuote({ mint, decimals, tokens, solUsd, slippageBps }) {
  if (decimals == null || !(tokens > 0)) return { ok: false, noRoute: false, error: 'missing decimals/amount', quotedPriceUsd: null };
  const raw = BigInt(Math.floor(tokens * 10 ** decimals)).toString();
  const q = await getQuote({ inputMint: mint, outputMint: SOL_MINT, amount: raw, slippageBps });
  if (!q.ok) return { ...q, quotedPriceUsd: null };
  const sol = Number(q.outAmount) / 1e9;
  return { ...q, solOut: sol, quotedPriceUsd: (sol * solUsd) / tokens };
}

module.exports = { getQuote, getSolUsd, shadowBuyQuote, shadowSellQuote, setHttp, SOL_MINT, SWAP_API };
