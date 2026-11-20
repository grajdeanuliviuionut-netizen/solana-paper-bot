const config = require('./config');
const denylist = require('./denylist');

function ratio(t) {
  const b = (t && t.buys) || 0;
  const s = (t && t.sells) || 1;
  return b / s;
}

function getFieldValue(pair, field) {
  switch (field) {
    case 'h1': return pair.priceChange && Number.isFinite(pair.priceChange.h1) ? pair.priceChange.h1 : NaN; // NaN fails every comparison
    case 'm5': return pair.priceChange.m5;
    case 'h6': return pair.priceChange.h6;
    case 'h24': return pair.priceChange.h24;
    case 'buySellRatioH1': return ratio(pair.txns);
    case 'buySellRatioM5': return ratio(pair.txnsM5);
    // 1 when the m5 txn counts are present and buys > sells; missing/non-numeric data fails closed (0).
    case 'buysGtSellsM5': {
      const t = pair.txnsM5;
      return t && Number.isFinite(t.buys) && Number.isFinite(t.sells) && t.buys > t.sells ? 1 : 0;
    }
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

// Returns { fails: [gateName...], details: [{gate, value}], tier?, sizeMult? } evaluating ALL gates
// (for counts, near-misses and /api/rejections?detail=1).
function evalSimple(pair, strategy) {
  const fails = [], details = [];
  const fail = (g, v) => { fails.push(g); details.push({ gate: g, value: v }); };
  const u = strategy.universe || {};
  const minLiq = Math.max(u.minLiquidityUsd || 0, config.minLiquidityUsd);
  if (pair.liquidityUsd < minLiq) fail('minLiquidity', pair.liquidityUsd);
  if (u.maxLiquidityUsd && pair.liquidityUsd > u.maxLiquidityUsd) fail('maxLiquidity', pair.liquidityUsd);
  for (const cond of strategy.entry) {
    const val = Number(getFieldValue(pair, cond.field)) || 0;
    if (!cmp(val, cond.op, cond.value)) fail(`${cond.field}${cond.op}${cond.value}`, +val.toFixed(4));
  }
  return { fails, details, tier: null, sizeMult: 1 };
}

// Bonding-curve / launchpad pools (spec universe.exclude_bonding_curve_pools). DEX Screener marks
// them by dexId (pumpfun, moonshot, ...) or by pair labels (Meteora "DBC", Raydium "LaunchLab").
const BONDING_DEX_RE = /^pumpfun$|bonding|launchlab|launchpad|moonshot|^boop|^believe/i;
const BONDING_LABEL_RE = /^(dbc|launchlab|bonding.*|launchpad)$/i;
function isBondingCurve(pair) {
  return BONDING_DEX_RE.test(pair.dexId || '') || (pair.labels || []).some(l => BONDING_LABEL_RE.test(String(l)));
}

// New Coin Scout gates, exactly as /workspace/specs/ncs_fresh_momentum_v1.json:
//   universe: pair age 5..240 min, no bonding-curve pools, tier A liq >= 15k, tier B liq >= 8k and age <= 60;
//   entry: m5 in [+3, +40], m5 buys > sells, m5 volume >= 5000 (B: 3000), h1 <= +300,
//          liquidity not down > 10% vs the PREVIOUS POLL (a pair with no previous poll cannot pass);
//   wash: h1 vol/liq <= 12, m5 vol/liq <= 3; honeypot: m5 txns >= 20, sells >= 3, buys/sells <= 4.
// token_first_seen_max_hours (6h) needs the token's creation time and is checked at entry (index.js).
function evalNcs(pair, strategy) {
  const fails = [], details = [];
  const fail = (g, v) => { fails.push(g); details.push({ gate: g, value: v }); };
  const u = strategy.universe;
  const e = strategy.entry;
  if (u.excludeBondingCurve && isBondingCurve(pair)) fail('bondingCurve', `${pair.dexId}${(pair.labels || []).length ? '/' + pair.labels.join(',') : ''}`);
  const age = pair.pairAgeMin;
  if (age == null || !(age >= u.pairAgeMinMin) || !(age <= u.pairAgeMaxMin)) fail('pairAge', age == null ? null : +age.toFixed(1));
  let tier = null;
  if (pair.liquidityUsd >= u.tiers.A.minLiquidityUsd) tier = 'A';
  else if (pair.liquidityUsd >= u.tiers.B.minLiquidityUsd && age != null && age <= u.tiers.B.maxPairAgeMin) tier = 'B';
  if (!tier) fail('tierLiquidity', pair.liquidityUsd);
  const m5 = pair.priceChange.m5;
  if (!(m5 >= e.m5Min && m5 <= e.m5Max)) fail('m5Range', m5);
  const t5 = pair.txnsM5 || { buys: 0, sells: 0 };
  if (!((t5.buys || 0) > (t5.sells || 0))) fail('m5BuysGtSells', `${t5.buys || 0}/${t5.sells || 0}`);
  const minVol = e.minVolumeM5Usd[tier || 'B'];
  if (!(pair.volumeM5 >= minVol)) fail('volumeM5', pair.volumeM5);
  if (!(pair.priceChange.h1 <= e.h1Max)) fail('h1Max', pair.priceChange.h1);
  if (pair.liqChangeVsPrevPct == null) {
    if (e.requirePrevLiqPoll) fail('liqPrevMissing', null);
  } else if (pair.liqChangeVsPrevPct < -e.maxLiqDropVsPrevPct) fail('liqDropVsPrev', +pair.liqChangeVsPrevPct.toFixed(2));
  const liq = pair.liquidityUsd || 1;
  if (pair.volumeH1 / liq > e.maxH1VolToLiq) fail('washH1', +(pair.volumeH1 / liq).toFixed(2));
  if (pair.volumeM5 / liq > e.maxM5VolToLiq) fail('washM5', +(pair.volumeM5 / liq).toFixed(2));
  const hp = e.honeypot;
  const tx = (t5.buys || 0) + (t5.sells || 0);
  if (tx < hp.minTxnsM5 || (t5.sells || 0) < hp.minSellsM5 || ratio(t5) > hp.maxBuySellRatioM5) fail('honeypotSells', `${t5.buys || 0}/${t5.sells || 0}`);
  return { fails, details, tier, sizeMult: tier ? u.tiers[tier].sizeMult : 0 };
}

// Snapshot of the inputs every gate saw (stored on each position/trade for later audits).
function gateInputs(pair) {
  return {
    dexId: pair.dexId, labels: pair.labels || [], quoteMint: pair.quoteMint || null,
    pairAgeMin: pair.pairAgeMin == null ? null : +pair.pairAgeMin.toFixed(1), liquidityUsd: pair.liquidityUsd,
    prevLiquidityUsd: pair.prevLiquidityUsd == null ? null : pair.prevLiquidityUsd, liqChangeVsPrevPct: pair.liqChangeVsPrevPct == null ? null : +pair.liqChangeVsPrevPct.toFixed(2),
    m5: pair.priceChange.m5, h1: pair.priceChange.h1, txnsM5: pair.txnsM5, txnsH1: pair.txns,
    volumeM5: pair.volumeM5, volumeH1: pair.volumeH1, priceUsd: pair.priceUsd
  };
}

function evaluate(pair, strategy) {
  if (!pair.mint || config.excludedMints[pair.mint]) return { fails: ['excludedMint'], details: [{ gate: 'excludedMint', value: pair.mint }], tier: null, sizeMult: 0 };
  // Universe filter (not part of any strategy's config hash): tokenized stocks are never traded.
  const eq = denylist.staticCheck({ mint: pair.mint, symbol: pair.symbol, name: pair.name });
  if (eq) return { fails: [denylist.REASON], details: [{ gate: denylist.REASON, value: eq }], tier: null, sizeMult: 0, detail: eq };
  return strategy.type === 'ncs' ? evalNcs(pair, strategy) : evalSimple(pair, strategy);
}

// hooks: { count(strategyId, gate), nearMiss(rec), skip(rec), detail(rec) } - optional
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
      if (r.fails.length && hooks.detail) {
        hooks.detail({ strategyId: strat.id, mint: pair.mint, pairAddress: pair.pairAddress, symbol: pair.symbol, gate: r.fails[0], value: r.details && r.details[0] ? r.details[0].value : null, fails: r.details || r.fails.map(g => ({ gate: g })) });
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
        exit: strat.exit,
        gateInputs: gateInputs(pair)
      });
    }
  }
  return { signals, rejections, gateStats };
}

module.exports = { generateSignals, getFieldValue, evaluate, isBondingCurve, gateInputs };
