const config = require('./config');

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getFieldValue(pair, field) {
  const change = pair.priceChange || {};
  if (field === 'h1') return num(change.h1);
  if (field === 'm5') return num(change.m5);
  if (field === 'buySellRatioH1') {
    const b = num(pair.txns && pair.txns.buys);
    const s = num(pair.txns && pair.txns.sells) || 1;
    return b / s;
  }
  if (field === 'volumeToLiquidity') return num(pair.volumeH1) / (num(pair.liquidityUsd) || 1);
  if (field === 'volumeH1Usd') return num(pair.volumeH1);
  if (field === 'liqChange60mPct') return 0;
  if (field === 'dropFromHigh60m') return Math.max(0, -num(change.h1));
  return 0;
}

function matchesEntry(pair, strategy, rejections) {
  const u = strategy.universe || {};
  if (u.minLiquidityUsd && num(pair.liquidityUsd) < u.minLiquidityUsd) return false;
  if (u.maxLiquidityUsd && num(pair.liquidityUsd) > u.maxLiquidityUsd) return false;
  if (u.minAgeDays && num(pair.ageDays) < u.minAgeDays) return false;
  if (u.maxAgeDays && num(pair.ageDays) > u.maxAgeDays) return false;

  for (const cond of strategy.entry) {
    const val = getFieldValue(pair, cond.field);
    let pass = true;
    if (cond.op === '<=' && !(val <= cond.value)) pass = false;
    if (cond.op === '>=' && !(val >= cond.value)) pass = false;
    if (cond.op === '<' && !(val < cond.value)) pass = false;
    if (cond.op === '>' && !(val > cond.value)) pass = false;
    if (!pass) {
      rejections.push(strategy.id + ': ' + cond.field);
      return false;
    }
  }
  return true;
}

function generateSignals(pairs) {
  const signals = [];
  const rejections = [];
  if (!Array.isArray(pairs)) return { signals, rejections };
  for (const strat of config.strategies) {
    if (strat.paused) continue;
    for (const pair of pairs) {
      if (!pair) continue;
      if (matchesEntry(pair, strat, rejections)) {
        signals.push({
          strategyId: strat.id,
          strategyName: strat.name,
          symbol: pair.symbol,
          pairAddress: pair.pairAddress,
          price: pair.priceUsd,
          exit: strat.exit,
          pair: pair
        });
      }
    }
  }
  return { signals, rejections: rejections.slice(0, 20) };
}

module.exports = { generateSignals };
