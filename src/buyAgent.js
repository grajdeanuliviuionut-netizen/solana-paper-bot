const config = require('./config');

function matchesEntry(pair, strategy) {
  const u = strategy.universe;
  if (u.minLiquidityUsd && pair.liquidityUsd < u.minLiquidityUsd) return false;
  if (u.maxLiquidityUsd && pair.liquidityUsd > u.maxLiquidityUsd) return false;

  for (const cond of strategy.entry) {
    let val;
    if (cond.field === 'h1') val = pair.priceChange.h1;
    else if (cond.field === 'm5') val = pair.priceChange.m5;
    else if (cond.field === 'buySellRatioH1') {
      const b = pair.txns.buys || 0;
      const s = pair.txns.sells || 1;
      val = b / s;
    } else if (cond.field === 'volumeToLiquidity') val = pair.volumeH1 / (pair.liquidityUsd || 1);
    else if (cond.field === 'liqChange60mPct') val = 0; // not always available
    else if (cond.field === 'dropFromHigh60m') val = Math.max(0, -pair.priceChange.h1);
    else val = 0;

    if (cond.op === '<=' && !(val <= cond.value)) return false;
    if (cond.op === '>=' && !(val >= cond.value)) return false;
    if (cond.op === '<' && !(val < cond.value)) return false;
    if (cond.op === '>' && !(val > cond.value)) return false;
  }
  return true;
}

function generateSignals(pairs) {
  const signals = [];
  for (const strat of config.strategies) {
    for (const pair of pairs) {
      if (matchesEntry(pair, strat)) {
        signals.push({
          strategyId: strat.id,
          strategyName: strat.name,
          symbol: pair.symbol,
          pairAddress: pair.pairAddress,
          price: pair.priceUsd,
          exit: strat.exit
        });
      }
    }
  }
  return signals;
}

module.exports = { generateSignals };
