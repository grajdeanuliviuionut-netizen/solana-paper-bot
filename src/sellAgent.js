const config = require('./config');

// Decide what to do with an open position.
// q = fresh normalized quote of the pinned pair (or null), price = price to use.
// priceFresh=false: only time stops may fire (never fake TP/SL off a stale number).
// Returns null | { action: 'close'|'partial', reason, sellFrac (of ORIGINAL size), fillPrice }.
function decide(pos, price, priceFresh = true, q = null, now = Date.now()) {
  // Simple strategies use the CURRENT config exit rules (so open positions pick up changes such as
  // the momentum-entry time-stop rule); NCS positions keep the rules they were opened with.
  const live = pos.strategyType !== 'ncs' && config.strategies.find(s => s.id === pos.strategyId);
  const ex = Object.assign({}, pos.exit || {}, live && live.exit ? live.exit : {});
  const minsOpen = (now - new Date(pos.entryTime).getTime()) / 60000;
  const changePct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const remaining = pos.remainingFrac == null ? 1 : pos.remainingFrac;
  const close = reason => ({ action: 'close', reason, sellFrac: remaining, fillPrice: price });

  if (pos.strategyType === 'ncs') {
    if (priceFresh) {
      const em = ex.emergency || {};
      if (q && pos.entryLiquidityUsd > 0 && em.liqDropFromEntryPct &&
          q.liquidityUsd <= pos.entryLiquidityUsd * (1 - em.liqDropFromEntryPct / 100)) return close('emergency-liq');
      if (q && q.txnsM5 && em.zeroSellsMinBuysM5 && (q.txnsM5.sells || 0) === 0 && (q.txnsM5.buys || 0) >= em.zeroSellsMinBuysM5) {
        return close('emergency-nosells');
      }
      if (!pos.tp1Done && changePct <= -ex.stopLossPct) return close('sl');
      if (pos.tp1Done) {
        if (ex.breakevenAfterTp1 && price <= pos.entryPrice) return close('breakeven');
        if (ex.trailAfterTp1Pct && price <= (pos.highest || price) * (1 - ex.trailAfterTp1Pct / 100)) return close('trail');
      }
      const tps = ex.takeProfits || [];
      const last = tps[tps.length - 1];
      if (last && changePct >= last.atPct) return close('tp2');
      if (tps[0] && !pos.tp1Done && changePct >= tps[0].atPct && tps[0].sellPct < 100) {
        return { action: 'partial', reason: 'tp1', sellFrac: Math.min(remaining, tps[0].sellPct / 100), fillPrice: price };
      }
    }
    const ts = ex.timeStop;
    if (ts && !pos.tp1Done && minsOpen >= ts.afterMin && changePct < ts.ifNotAbovePct) return close(priceFresh ? 'time-flat' : 'time-stale');
    if (minsOpen >= (ex.maxHoldMinutes || config.defaultMaxHoldMinutes)) return close(priceFresh ? 'time' : 'time-stale');
    return null;
  }

  if (priceFresh) {
    if (changePct >= ex.takeProfitPct) return close('tp');
    if (changePct <= -ex.stopLossPct) return close('sl');
    if (ex.trailAfterPct) {
      const peakPct = (((pos.highest || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakPct >= ex.trailAfterPct && price <= (pos.highest || pos.entryPrice) * (1 - (ex.trailPct || 5) / 100)) return close('trail');
    }
  }
  if (minsOpen >= (ex.maxHoldMinutes || config.defaultMaxHoldMinutes)) {
    if (!ex.timeStopOnlyIfLoss || changePct < 0) return close(priceFresh ? 'time' : 'time-stale');
    // In profit at max hold: no time exit; arm a trailing stop from here instead.
    if (!pos.timeTrailArmedAt) { pos.timeTrailArmedAt = new Date(now).toISOString(); pos.timeTrailHigh = price; }
    if (priceFresh) {
      if (price > (pos.timeTrailHigh || 0)) pos.timeTrailHigh = price;
      if (price <= pos.timeTrailHigh * (1 - (ex.timeTrailPct || ex.trailPct || 5) / 100)) return close('time-trail');
    }
  }
  return null;
}

// Back-compat wrapper used by PR1 tests.
function shouldExit(pos, currentPrice, priceFresh = true) {
  const d = decide(pos, currentPrice, priceFresh);
  return d ? { reason: d.reason, fillPrice: d.fillPrice } : null;
}

// PnL of selling `sellFrac` of the original size at exitFill, bought at entryFill (fills include
// impact, slippage and DEX fees). Flat tx costs are charged separately.
function legPnlSol(pos, exitFill, sellFrac) {
  return pos.sizeSol * sellFrac * (exitFill / pos.entryFillPrice - 1);
}

module.exports = { decide, shouldExit, legPnlSol };
