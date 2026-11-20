const config = require('./config');

function getFieldValue(pair, field) {
  if (field === 'h1') return pair.priceChange.h1;
  if (field === 'm5') return pair.priceChange.m5;
  if (field === 'h6') return pair.priceChange.h6;
  if (field === 'h24') return pair.priceChange.h24;
  if (field === 'buySellRatioH1') {
    const b = pair.txns.buys || 0;
    const s = pair.txns.sells || 1;
    return b / s;
  }
  if (field === 'buySellRatioM5') {
    const t = pair.txnsM5 || { buys: 0, sells: 0 };
    const b = t.buys || 0;
    const s = t.sells || 1;
    return b / s;
  }
  if (field === 'buysH1') return pair.txns.buys || 0;
  if (field === 'sellsH1') return pair.txns.sells || 0;
  if (field === 'volumeToLiquidity') return pair.volumeH1 / (pair.liquidityUsd || 1);
  if (field === 'volumeH1Usd') return pair.volumeH1;
  if (field === 'liquidityUsd') return pair.liquidityUsd;
  if (field === 'mcapUsd') return pair.mcapUsd || 0;
  if (field === 'ageDays') return pair.ageDays;
  if (field === 'liqChange60mPct') return 0; // not tracked yet
  if (field === 'dropFromHigh60m') return Math.max(0, -pair.priceChange.h1);
  return 0;
}

function matchesEntry(pair, strategy, rejections, stat = { fails: {} }) {
  const fail = key => { stat.fails[key] = (stat.fails[key] || 0) + 1; return false; };
  if (!pair.mint || config.excludedMints[pair.mint]) return fail('excludedMint');
  const u = strategy.universe;
  const minLiq = Math.max(u.minLiquidityUsd || 0, config.minLiquidityUsd);
  if (pair.liquidityUsd < minLiq) {
    rejections.push(`${strategy.id}: liquidity ${Math.round(pair.liquidityUsd)} < ${minLiq}`);
    return fail('minLiquidity');
  }
  if (u.maxLiquidityUsd && pair.liquidityUsd > u.maxLiquidityUsd) {
    rejections.push(`${strategy.id}: liquidity too high`);
    return fail('maxLiquidity');
  }

  for (const cond of strategy.entry) {
    const val = Number(getFieldValue(pair, cond.field)) || 0;
    let pass = true;
    if (cond.op === '<=' && !(val <= cond.value)) pass = false;
    if (cond.op === '>=' && !(val >= cond.value)) pass = false;
    if (cond.op === '<' && !(val < cond.value)) pass = false;
    if (cond.op === '>' && !(val > cond.value)) pass = false;
    if (!pass) {
      rejections.push(`${strategy.id}: ${cond.field} ${val.toFixed(2)} not ${cond.op} ${cond.value}`);
      return fail(`${cond.field}${cond.op}${cond.value}`);
    }
  }
  return true;
}

function generateSignals(pairs) {
  const signals = [];
  const rejections = [];
  const gateStats = {};
  for (const strat of config.strategies) {
    const stat = { scanned: pairs.length, passed: 0, fails: {} };
    gateStats[strat.id] = stat;
    for (const pair of pairs) {
      if (matchesEntry(pair, strat, rejections, stat)) {
        stat.passed++;
        signals.push({
          strategyId: strat.id,
          strategyName: strat.name,
          symbol: pair.symbol,
          mint: pair.mint,
          pairAddress: pair.pairAddress,
          dexId: pair.dexId,
          liquidityUsd: pair.liquidityUsd,
          price: pair.priceUsd,
          exit: strat.exit
        });
      }
    }
  }
  return { signals, rejections: rejections.slice(0, 20), gateStats };
}

module.exports = { generateSignals, getFieldValue };
