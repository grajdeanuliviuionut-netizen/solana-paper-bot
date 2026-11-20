// Quote sanity rules. Pure functions so every rule is unit-tested.
//
// Background (RUDY HmBGdetVsQTRHh2wCa4HykUpKA7NJ1B8S16tUpYiWeaZ, 2026-11-20 11:29 London): Jupiter
// quoted 0.2 SOL -> 4016 raw = 0.004016 RUDY (6 decimals) with priceImpact 99.99999%, i.e.
// $3,587.97/token vs a model price of $0.000045. The quote was internally consistent: the pinned
// pumpswap pool had been drained on-chain while DEX Screener still showed the pre-drain price and
// $51k liquidity. Nothing bounded the quote, so the worse-of rule adopted it as the fill.
// These rules hard-reject such entries and stop worse-of from taking an absurd quote on exit.
const config = require('./config');

function gapPct(quoted, model) {
  if (!(quoted > 0) || !(model > 0)) return null;
  return ((quoted - model) / model) * 100;
}

// buy: shadowBuyQuote result; reverse: sellRawQuote result for buy.rawOut (or null if not taken);
// modelPrice: depth-model entry fill (USD/token); decimals: RugCheck decimals; jupDecimals: Jupiter
// token-list decimals (optional cross-check).
// Returns { pass, reasons: [..], gapPct, impactPct, reverseImpactPct }.
function checkEntry({ buy, reverse, modelPrice, decimals, jupDecimals }, cfg = config.quoteSanity) {
  const reasons = [];
  if (!Number.isInteger(decimals)) reasons.push('decimals-missing');
  else if (Number.isInteger(jupDecimals) && jupDecimals !== decimals) reasons.push(`decimals-mismatch rugcheck=${decimals} jupiter=${jupDecimals}`);
  if (!buy || !buy.ok) {
    reasons.push(buy && buy.mismatch ? `quote-mismatch ${buy.error}` : buy && buy.noRoute ? 'no-route' : `no-quote ${(buy && buy.error) || ''}`.trim());
    return { pass: false, reasons, gapPct: null, impactPct: null, reverseImpactPct: null };
  }
  const impact = buy.priceImpactPct;
  if (impact == null || !Number.isFinite(impact)) reasons.push('impact-missing');
  else if (impact > cfg.maxPriceImpactPct) reasons.push(`impact ${impact.toFixed(2)}%>${cfg.maxPriceImpactPct}%`);
  const g = gapPct(buy.quotedPriceUsd, modelPrice);
  if (g == null) reasons.push('gap-uncomputable');
  else if (Math.abs(g) > cfg.maxQuoteGapPct) reasons.push(`gap ${g.toFixed(2)}%>${cfg.maxQuoteGapPct}%`);
  let revImpact = null;
  if (cfg.requireReverseRoute) {
    if (!reverse) reasons.push('reverse-not-checked');
    else if (!reverse.ok) reasons.push(reverse.noRoute ? 'reverse-no-route' : `reverse-failed ${reverse.error || ''}`.trim());
    else {
      revImpact = reverse.priceImpactPct;
      const revMax = cfg.maxReverseImpactPct != null ? cfg.maxReverseImpactPct : cfg.maxPriceImpactPct;
      if (revImpact != null && revImpact > revMax) reasons.push(`reverse-impact ${revImpact.toFixed(2)}%>${revMax}%`);
    }
  }
  return { pass: reasons.length === 0, reasons, gapPct: g, impactPct: impact, reverseImpactPct: revImpact };
}

// Exit: decide whether a (successful) sell quote is usable for worse-of. quotedAdj = quoted price
// after the same delay drift the model applies. Insane -> caller uses the model price and logs it.
function checkExit({ sell, quotedAdj, modelPrice }, cfg = config.quoteSanity) {
  if (!sell || !sell.ok) return { usable: false, insane: false, reasons: [] };
  const reasons = [];
  if (!(quotedAdj > 0) || !Number.isFinite(quotedAdj)) reasons.push('bad-price');
  const impact = sell.priceImpactPct;
  if (impact != null && impact > cfg.maxExitPriceImpactPct) reasons.push(`impact ${impact.toFixed(2)}%>${cfg.maxExitPriceImpactPct}%`);
  const g = gapPct(quotedAdj, modelPrice);
  if (g != null && Math.abs(g) > cfg.maxExitQuoteGapPct) reasons.push(`gap ${g.toFixed(2)}%>${cfg.maxExitQuoteGapPct}%`);
  return { usable: reasons.length === 0, insane: reasons.length > 0, reasons, gapPct: g };
}

module.exports = { checkEntry, checkExit, gapPct, REASON: 'quoteSanity' };
