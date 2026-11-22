// Jupiter read-only quote service (quote API only; this module never builds, signs or sends a swap).
// Adapted from the rebuild (src/terminal/quotes.js). All calls go through the books limiter ('jupiter' bucket).
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_API = process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote';
const PRICE_API = process.env.JUPITER_PRICE_URL || 'https://lite-api.jup.ag/price/v3';

function toRaw(ui, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('bad decimals ' + decimals);
  if (!(ui > 0) || !Number.isFinite(ui)) throw new Error('bad amount ' + ui);
  const [i, f = ''] = ui.toFixed(decimals).split('.');
  const raw = BigInt(i + f.padEnd(decimals, '0'));
  if (raw <= 0n) throw new Error('amount rounds to 0');
  return raw.toString();
}
function fromRaw(raw, decimals) { return Number(BigInt(raw)) / 10 ** decimals; }

function makeQuotes(limiter) {
  let solUsd = { v: null, at: 0 };
  const stats = { quotes: 0, ok: 0, noRoute: 0, failed: 0 };

  // ExactIn quote. Returns { ok, at, inAmount, outAmount, priceImpactPct, route, noRoute, error }.
  async function quote(inputMint, outputMint, amountRaw, slippageBps = 300) {
    stats.quotes++;
    let at = Date.now();
    try {
      const res = await limiter.get('jupiter', QUOTE_API, { params: { inputMint, outputMint, amount: String(amountRaw), slippageBps, restrictIntermediateTokens: true } });
      at = Date.now(); // quote time = when Jupiter answered (not when it was queued)
      const q = res.data || {};
      if (!/^[0-9]+$/.test(String(q.outAmount || '')) || q.outAmount === '0') { stats.noRoute++; return { ok: false, noRoute: true, at, error: q.error || 'no outAmount' }; }
      if ((q.inputMint && q.inputMint !== inputMint) || (q.outputMint && q.outputMint !== outputMint) || (q.inAmount != null && String(q.inAmount) !== String(amountRaw))) {
        stats.failed++; return { ok: false, noRoute: false, at, error: 'quote-mismatch' };
      }
      const impact = parseFloat(q.priceImpactPct || '0') * 100; // Jupiter gives a fraction
      stats.ok++;
      return { ok: true, at, inAmount: String(q.inAmount || amountRaw), outAmount: String(q.outAmount), priceImpactPct: Number.isFinite(impact) ? +impact.toFixed(4) : null,
        route: (q.routePlan || []).map(r => r.swapInfo && r.swapInfo.label).filter(Boolean).join('>') };
    } catch (e) {
      const body = e.response && e.response.data;
      const msg = String((body && (body.error || body.errorCode)) || e.message || 'error');
      const noRoute = /route|COULD_NOT_FIND|TOKEN_NOT_TRADABLE|NO_ROUTES/i.test(msg) || e.status === 400;
      if (noRoute) stats.noRoute++; else stats.failed++;
      return { ok: false, noRoute, at, error: msg.slice(0, 160), status: e.status, rateLimited: !!e.rateLimited };
    }
  }

  async function buyQuote(mint, solIn) { return quote(SOL_MINT, mint, toRaw(solIn, 9)); }
  async function sellQuote(mint, tokensRaw, slippageBps) { return quote(mint, SOL_MINT, String(tokensRaw), slippageBps || 300); }   // t96u: exit ladder passes 200/300/1000/2500

  async function getSolUsd() {
    if (solUsd.v && Date.now() - solUsd.at < 60000) return solUsd;
    try {
      const res = await limiter.get('jupiter', PRICE_API, { params: { ids: SOL_MINT } });
      const v = res.data && res.data[SOL_MINT] && Number(res.data[SOL_MINT].usdPrice);
      if (v > 0) solUsd = { v, at: Date.now() };
    } catch (e) { /* keep previous */ }
    return solUsd;
  }
  return { quote, buyQuote, sellQuote, getSolUsd, stats };
}

module.exports = { makeQuotes, toRaw, fromRaw, SOL_MINT };
