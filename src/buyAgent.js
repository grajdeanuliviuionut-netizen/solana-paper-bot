const config = require('./config');
const denylist = require('./denylist');

function ratio(t) {
  const b = (t && t.buys) || 0;
  const s = (t && t.sells) || 1;
  return b / s;
}

function getFieldValue(pair, field) {
  switch (field) {
    case 'h1': return pair.priceChange.h1;
    case 'm5': return pair.priceChange.m5;
    case 'h6': return pair.priceChange.h6;
    case 'h24': return pair.priceChange.h24;
    case 'buySellRatioH1': return ratio(pair.txns);
    case 'buySellRatioM5': return ratio(pair.txnsM5);
    case 'buysH1': return pair.txns.buys || 0;
    case 'sellsH1': return pair.txns.sells || 0;
    case 'volumeToLiquidity': return pair.volumeH1 / (pair.liquidityUsd || 1);
    case 'volumeH1Usd': return pair.volumeH1;
    case 'liquidityUsd': return pair.liquidityUsd;
    case 'mcapUsd': return pair.mcapUsd || 0;
    case 'ageDays': return pair.ageDays;
    case 'liqChange60mPct': return pair.liqChange60mPct == null ? 0 : pair.liqChange60mPct;
    case 'dropFromHigh60m': return Math.max(0, -pair.priceChange.h1);
    default: return 0;
  }
}

function cmp(val, op, value) {
  if (op === '<=') return val <= value;
  if (op === '>=') return val >= value;
  if (op === '<') return val < value;
  if (op === '>') return val > value;
  return false;
}

// Returns { fails: [gateName...], tier?, sizeMult? } evaluating ALL gates (for counts + near-misses).
function evalSimple(pair, strategy) {
  const fails = [];
  const u = strategy.universe || {};
  const minLiq = Math.max(u.minLiquidityUsd || 0, config.minLiquidityUsd);
  if (pair.liquidityUsd < minLiq) fails.push('minLiquidity');
  if (u.maxLiquidityUsd && pair.liquidityUsd > u.maxLiquidityUsd) fails.push('maxLiquidity');
  for (const cond of strategy.entry) {
    const val = Number(getFieldValue(pair, cond.field)) || 0;
    if (!cmp(val, cond.op, cond.value)) fails.push(`${cond.field}${cond.op}${cond.value}`);
  }
  return { fails, tier: null, sizeMult: 1 };
}

function evalNcs(pair, strategy) {
  const fails = [];
  const u = strategy.universe;
  const e = strategy.entry;
  if (u.excludeBondingCurve && /^pumpfun$|bonding|launchlab|moonshot/i.test(pair.dexId || '')) fails.push('bondingCurve');
  const age = pair.pairAgeMin;
  if (age == null || age < u.pairAgeMinMin || age > u.pairAgeMaxMin) fails.push('pairAge');
  let tier = null;
  if (pair.liquidityUsd >= u.tiers.A.minLiquidityUsd) tier = 'A';
  else if (pair.liquidityUsd >= u.tiers.B.minLiquidityUsd && age != null && age <= u.tiers.B.maxPairAgeMin) tier = 'B';
  if (!tier) fails.push('tierLiquidity');
  const m5 = pair.priceChange.m5;
  if (!(m5 >= e.m5Min && m5 <= e.m5Max)) fails.push('m5Range');
  const t5 = pair.txnsM5 || { buys: 0, sells: 0 };
  if (!((t5.buys || 0) > (t5.sells || 0))) fails.push('m5BuysGtSells');
  const minVol = e.minVolumeM5Usd[tier || 'B'];
  if (!(pair.volumeM5 >= minVol)) fails.push('volumeM5');
  if (!(pair.priceChange.h1 <= e.h1Max)) fails.push('h1Max');
  if (pair.liqChangeVsPrevPct != null && pair.liqChangeVsPrevPct < -e.maxLiqDropVsPrevPct) fails.push('liqDropVsPrev');
  const liq = pair.liquidityUsd || 1;
  if (pair.volumeH1 / liq > e.maxH1VolToLiq) fails.push('washH1');
  if (pair.volumeM5 / liq > e.maxM5VolToLiq) fails.push('washM5');
  const hp = e.honeypot;
  const tx = (t5.buys || 0) + (t5.sells || 0);
  if (tx < hp.minTxnsM5 || (t5.sells || 0) < hp.minSellsM5 || ratio(t5) > hp.maxBuySellRatioM5) fails.push('honeypotSells');
  return { fails, tier, sizeMult: tier ? u.tiers[tier].sizeMult : 0 };
}

function evaluate(pair, strategy) {
  if (!pair.mint || config.excludedMints[pair.mint]) return { fails: ['excludedMint'], tier: null, sizeMult: 0 };
  // Universe filter (not part of any strategy's config hash): tokenized stocks are never traded.
  const eq = denylist.staticCheck({ mint: pair.mint, symbol: pair.symbol, name: pair.name });
  if (eq) return { fails: [denylist.REASON], tier: null, sizeMult: 0, detail: eq };
  return strategy.type === 'ncs' ? evalNcs(pair, strategy) : evalSimple(pair, strategy);
}

// hooks: { count(strategyId, gate), nearMiss(rec) } - optional
function generateSignals(pairs, hooks = {}) {
  const signals = [];
  const rejections = [];
  const gateStats = {};
  for (const strat of config.strategies) {
    const stat = { scanned: pairs.length, passed: 0, fails: {} };
    gateStats[strat.id] = stat;
    for (const pair of pairs) {
      const r = evaluate(pair, strat);
      for (const g of r.fails) {
        stat.fails[g] = (stat.fails[g] || 0) + 1;
        if (hooks.count) hooks.count(strat.id, g);
      }
      if (hooks.count) hooks.count(strat.id, '_evaluated');
      if (r.fails.length === 1 && hooks.nearMiss && r.fails[0] !== 'excludedMint' && r.fails[0] !== denylist.REASON) {
        hooks.nearMiss({
          strategyId: strat.id, gate: r.fails[0], mint: pair.mint, pairAddress: pair.pairAddress, symbol: pair.symbol,
          liquidityUsd: pair.liquidityUsd, m5: pair.priceChange.m5, h1: pair.priceChange.h1, priceUsd: pair.priceUsd
        });
      }
      if (r.fails[0] === denylist.REASON && hooks.skip) {
        hooks.skip({ strategyId: strat.id, reason: denylist.REASON, detail: r.detail, mint: pair.mint, pairAddress: pair.pairAddress, symbol: pair.symbol }, { count: false });
      }
      if (r.fails.length) {
        if (rejections.length < 20) rejections.push(`${strat.id}: ${pair.symbol} ${r.fails[0]}`);
        continue;
      }
      stat.passed++;
      signals.push({
        strategyId: strat.id,
        strategyName: strat.name,
        strategy: strat,
        symbol: pair.symbol,
        name: pair.name,
        mint: pair.mint,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        liquidityUsd: pair.liquidityUsd,
        m5: pair.priceChange.m5,
        tier: r.tier,
        sizeMult: r.sizeMult,
        price: pair.priceUsd,
        exit: strat.exit
      });
    }
  }
  return { signals, rejections, gateStats };
}

module.exports = { generateSignals, getFieldValue, evaluate };
