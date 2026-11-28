// Route-death exit for the social-spike paper book (branch social-route-death-exit). PAPER ONLY: pure helpers, no
// network, no wallet, no key. Jupiter stays quote-only.
//
// Why: 17 of 31 social-spike trades ended in a total loss (12 'no-route-total-loss', 5 'sl' filled at ~-100% with
// priceImpact ~100%). In every one the pool died BETWEEN two 5 s checks (last good quote -> no route / ~100% impact,
// 0 s of warning), then the engine either waited 10 min for the no-route timer or booked a -100% "stop".
// This module decides "the route/pool is dying" on the FIRST evidence instead, so the position is closed at once
// with its own reason ('route-dying-exit'), never counted as a stop-fill overshoot.
//
// Detection (any one, on a fresh sell quote of the whole remainder):
//   no-route    N consecutive "No routes found" answers (default 2 = ~10 s; 0 of 19 surviving social trades ever had one
//               failed quote, so transient no-routes are not observed on this universe)
//   impact      quote priceImpactPct > maxPriceImpactPct (20)
//   collapse    quote-implied token price fell >= collapseDropPct (50 %) vs the previous check (one 5 s step)
//   liquidity   optional feed: pool liquidity <= minLiquidityUsd ($30k) or down >= liquidityDropPct (50 %) from entry
//
// Paper realism: if no route exists a real bot could NOT sell. Default (creditLastGoodQuote:false) therefore books
// what is executable: the dying quote itself when one exists (impact/collapse/liquidity), a total loss for no-route.
// creditLastGoodQuote:true is an explicitly labelled what-if: it credits the last good quote of the same tokens,
// minus the usual paper slip, ONLY when that quote is <= creditMaxQuoteAgeSec old; otherwise the loss is kept and
// the refusal is logged on the leg.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const DEFAULTS = { enabled: true, noRouteConsecutive: 2, maxPriceImpactPct: 20, collapseDropPct: 50, minLiquidityUsd: 30000, liquidityDropPct: 50,
  creditLastGoodQuote: false, creditMaxQuoteAgeSec: 10, trailLen: 12 };

// exit config of a book (or a position's stored exit) -> merged config, or null when the rule is off / absent.
function cfgFrom(exit) {
  const c = exit && exit.routeDeath;
  if (!c || c.enabled === false) return null;
  return Object.assign({}, DEFAULTS, c);
}

// q: Jupiter sell quote of the whole remainder (or { ok:false, noRoute:true }).
// prev: the previous check { price, at } (price = SOL per token of the remainder), price: current price.
// liq: optional { usd } current pool liquidity; entryLiq: liquidity at entry.
function detect({ cfg, q, price, prev, noRouteCount, liq, entryLiq }) {
  if (!cfg) return null;
  if (q && !q.ok) {
    if (q.noRoute && noRouteCount >= cfg.noRouteConsecutive) return { kind: 'no-route', detail: noRouteCount + ' consecutive "no route" answers' };
    return null;
  }
  if (!q) return null;
  const imp = Number(q.priceImpactPct);
  if (Number.isFinite(imp) && imp > cfg.maxPriceImpactPct) return { kind: 'impact', detail: 'sell priceImpact ' + imp.toFixed(2) + '% > ' + cfg.maxPriceImpactPct + '%' };
  if (prev && num(prev.price) > 0 && price != null && num(price) >= 0) {
    const drop = (1 - num(price) / num(prev.price)) * 100;
    if (drop >= cfg.collapseDropPct) return { kind: 'collapse', detail: 'quote-implied price -' + drop.toFixed(1) + '% in one check (>= ' + cfg.collapseDropPct + '%)' };
  }
  if (liq && liq.usd != null) {
    const usd = num(liq.usd);
    if (cfg.minLiquidityUsd && usd <= cfg.minLiquidityUsd) return { kind: 'liquidity', detail: 'pool liquidity $' + Math.round(usd) + ' <= floor $' + cfg.minLiquidityUsd };
    if (cfg.liquidityDropPct && num(entryLiq) > 0 && usd <= num(entryLiq) * (1 - cfg.liquidityDropPct / 100)) return { kind: 'liquidity', detail: 'pool liquidity $' + Math.round(usd) + ' is down >= ' + cfg.liquidityDropPct + '% from entry $' + Math.round(entryLiq) };
  }
  return null;
}

// Last good quote (same tokens, <= creditMaxQuoteAgeSec old) -> { ok, quote } or { ok:false, why }.
function credit({ cfg, lastGood, tokensRemainingRaw, now }) {
  if (!cfg || !cfg.creditLastGoodQuote) return { ok: false, why: 'credit-off' };
  if (!lastGood) return { ok: false, why: 'no-good-quote' };
  if (String(lastGood.tokensRemainingRaw) !== String(tokensRemainingRaw)) return { ok: false, why: 'tokens-changed' };
  const ageSec = (now - lastGood.at) / 1000;
  if (!(ageSec >= 0 && ageSec <= cfg.creditMaxQuoteAgeSec)) return { ok: false, why: 'quote-too-old', ageSec: +ageSec.toFixed(1) };
  return { ok: true, ageSec: +ageSec.toFixed(1),
    quote: { ok: true, side: 'sell', inAmount: lastGood.inAmount, outAmount: lastGood.outAmount, priceImpactPct: lastGood.priceImpactPct, route: lastGood.route, at: lastGood.at } };
}

// Small per-position ring of recent checks, kept on the trade so the next review can measure real warning time.
function trailPush(pos, row, len) {
  const a = pos.checkTrail || (pos.checkTrail = []);
  a.push(row);
  if (a.length > (len || 12)) a.splice(0, a.length - (len || 12));
}

module.exports = { DEFAULTS, cfgFrom, detect, credit, trailPush };
