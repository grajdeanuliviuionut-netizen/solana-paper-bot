// Depth-based paper fill model. Pure functions (rng injectable) so they can be unit tested.
const config = require('./config');

const STOP_REASONS = new Set(['sl', 'trail', 'breakeven', 'emergency-liq', 'emergency-nosells', 'emergency-rug']);

function isStopReason(reason) {
  return STOP_REASONS.has(reason) || String(reason).startsWith('emergency');
}

// Constant-product approximation: each side of the pool holds ~liquidity/2 USD.
// Buying with V USD: average price multiplier = 1 + V/R. Selling V USD: 1 / (1 + V/R).
function buyImpactPct(sizeUsd, liquidityUsd) {
  const R = Math.max(1, liquidityUsd / 2);
  return (sizeUsd / R) * 100;
}
function sellImpactPct(sizeUsd, liquidityUsd) {
  const R = Math.max(1, liquidityUsd / 2);
  return (1 - 1 / (1 + sizeUsd / R)) * 100;
}

// Adverse drift over n blocks, from 5m realised move: sigma_block = |m5| / sqrt(blocksPer5m).
function delayDriftPct(m5Pct, blocks, f = config.fills) {
  const sigmaBlock = Math.max(f.minBlockVolPct, Math.abs(m5Pct || 0) / Math.sqrt(f.blocksPer5m));
  return sigmaBlock * Math.sqrt(Math.max(0, blocks));
}

function txCostSol(landedTxs, failedTxs = 0, f = config.fills) {
  // Landed txs pay base + priority + Jito tip; failed txs still pay base + priority (no tip).
  return landedTxs * (f.baseFeeSol + f.priorityFeeSol + f.jitoTipSol) + failedTxs * (f.baseFeeSol + f.priorityFeeSol);
}

function fillEntry({ midPrice, sizeSol, solUsd, liquidityUsd }, f = config.fills) {
  const sizeUsd = sizeSol * solUsd;
  const impactPct = buyImpactPct(sizeUsd, liquidityUsd);
  const slippagePct = f.baseSlippagePct;
  const feePct = f.dexFeePctPerSide;
  const price = midPrice * (1 + impactPct / 100) * (1 + slippagePct / 100) * (1 + feePct / 100);
  return { price, midPrice, impactPct, slippagePct, feePct, txCostSol: txCostSol(1, 0, f), sizeUsd };
}

function fillExit({ midPrice, valueUsd, liquidityUsd, reason, m5Pct = 0, rng = Math.random }, f = config.fills) {
  const stop = isStopReason(reason);
  const mult = stop ? f.stopSlippageMult : 1;
  const impactPct = sellImpactPct(valueUsd, liquidityUsd) * mult;
  const slippagePct = f.baseSlippagePct * mult;
  const feePct = f.dexFeePctPerSide;
  let driftPct = stop ? delayDriftPct(m5Pct, f.stopDelayBlocks, f) : 0;
  const failedFirst = rng() < f.failedExitRate;
  if (failedFirst) driftPct += delayDriftPct(m5Pct, f.failedExitDelayBlocks, f);
  const price = midPrice * (1 - impactPct / 100) * (1 - slippagePct / 100) * (1 - feePct / 100) * (1 - driftPct / 100);
  return {
    price, midPrice, stop, impactPct, slippagePct, feePct, driftPct, failedFirst,
    txCostSol: txCostSol(1, failedFirst ? 1 : 0, f)
  };
}

module.exports = { fillEntry, fillExit, buyImpactPct, sellImpactPct, delayDriftPct, txCostSol, isStopReason };
