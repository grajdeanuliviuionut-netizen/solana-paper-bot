const config = require('./config');

function getFieldValue(pair, field) {
  if (field === 'h1') return pair.priceChange.h1;
  if (field === 'm5') return pair.priceChange.m5;
  if (field === 'buySellRatioH1') {
    const b = pair.txns.buys || 0;
    const s = pair.txns.sells || 1;
    return b / s;
  }
  if (field === 'volumeToLiquidity') return pair.volumeH1 / (pair.liquidityUsd || 1);
  if (field === 'volumeH1Usd') return pair.volumeH1;
  if (field === 'liqChange60mPct') return 0;
  if (field === 'dropFromHigh60m') return Math.max(0, -pair.priceChange.h1);
  return 0;
}

function matchesEntry(pair, strategy, rejections) {
  const u = strategy.universe;
  if (u.minLiquidityUsd && pair.liquidityUsd < u.minLiquidityUsd) {
    rejections.push(`${strategy.id}: liquidity ${pair.liquidityUsd} < ${u.minLiquidityUsd}`);
    return false;
  }
  if (u.maxLiquidityUsd && pair.liquidityUsd > u.maxLiquidityUsd) {
    rejections.push(`${strategy.id}: liquidity too high`);
    return false;
  }

  for (const cond of strategy.entry) {
    const val = getFieldValue(pair, cond.field);
    let pass = true;
    if (cond.op === '<=' && !(val <= cond.value)) pass = false;
    if (cond.op === '>=' && !(val >= cond.value)) pass = false;
    if (cond.op === '<' && !(val < cond.value)) pass = false;
    if (cond.op === '>' && !(val > cond.value)) pass = false;
    if (!pass) {
      rejections.push(`${strategy.id}: ${cond.field} ${val.toFixed(2)} not ${cond.op} ${cond.value}`);
      return false;
    }
  }
  return true;
}

function generateSignals(pairs) {
  const signals = [];
  const rejections = [];
  for (const strat of config.strategies) {
    for (const pair of pairs) {
      if (matchesEntry(pair, strat, rejections)) {
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
  return { signals, rejections: rejections.slice(0, 20) };
}

module.exports = { generateSignals };
