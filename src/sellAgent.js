const config = require('./config');
const fillModel = require('./fillModel');

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
  // When exits are judged on sell quotes, trails use the high-water mark of the judged price.
  const hi = pos.judgedHigh != null ? pos.judgedHigh : pos.highest;

  if (pos.strategyType === 'ncs') {
    if (priceFresh) {
      const em = ex.emergency || {};
      if (q && pos.entryLiquidityUsd > 0 && em.liqDropFromEntryPct &&
          q.liquidityUsd <= pos.entryLiquidityUsd * (1 - em.liqDropFromEntryPct / 100)) return close('emergency-liq');
      if (q && q.txnsM5 && em.zeroSellsMinBuysM5 && (q.txnsM5.sells || 0) === 0 && (q.txnsM5.buys || 0) >= em.zeroSellsMinBuysM5) {
        return close('emergency-nosells');
      }
    }
    // Entry grace (as AF): only the hard stop from the entry fill (judged sell-quote PnL) can fire;
    // emergency exits above stay active.
    if (ex.graceSec > 0 && minsOpen * 60 < ex.graceSec) {
      if (priceFresh && ex.hardStopPct > 0 && changePct <= -ex.hardStopPct) return close('hard-stop');
      return null;
    }
    if (priceFresh) {
      if (!pos.tp1Done && changePct <= -ex.stopLossPct) return close('sl');
      // Profit lock before TP1: once the judged net peak reached lockAfterPct, exit at lockAtPct.
      if (!pos.tp1Done && ex.lockAfterPct) {
        const peakPct = (((hi || price) - pos.entryPrice) / pos.entryPrice) * 100;
        if (peakPct >= ex.lockAfterPct && changePct <= (ex.lockAtPct || 0)) return close('lock');
      }
      if (pos.tp1Done) {
        if (ex.breakevenAfterTp1 && price <= pos.entryPrice) return close('breakeven');
        if (ex.trailAfterTp1Pct && price <= (hi || price) * (1 - ex.trailAfterTp1Pct / 100)) return close('trail');
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

  // Entry grace: only the hard stop (from the entry fill, on the judged sell-quote PnL) can fire.
  if (ex.graceSec > 0 && minsOpen * 60 < ex.graceSec) {
    if (priceFresh && ex.hardStopPct > 0 && changePct <= -ex.hardStopPct) return close('hard-stop');
    return null;
  }
  if (priceFresh) {
    if (changePct >= ex.takeProfitPct) return close('tp');
    if (changePct <= -ex.stopLossPct) return close('sl');
    if (ex.trailAfterPct) {
      const peakPct = (((hi || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakPct >= ex.trailAfterPct && price <= (hi || pos.entryPrice) * (1 - (ex.trailPct || 5) / 100)) return close('trail');
    }
    // PR5 breakeven lock: once the judged (net) peak reached breakevenArmPct, exit if net falls back to
    // breakevenLockPct (e.g. +3% -> lock +0.5%).
    if (ex.breakevenArmPct != null) {
      const peakPct = (((hi || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakPct >= ex.breakevenArmPct && changePct <= (ex.breakevenLockPct || 0)) return close('breakeven');
    }
    // PR5 early-failure exit: not up earlyFailMinPeakPct (net peak) within earlyFailAfterMin -> exit
    // (reason 'stall', so the mint guard's 2h cooldown applies).
    if (ex.earlyFailAfterMin && minsOpen >= ex.earlyFailAfterMin) {
      const peakPct = (((hi || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakPct < ex.earlyFailMinPeakPct) return close('stall');
    }
    // Stall exit: after stallAfterMin, a trade that never got above stallMaxPeakPct and is down
    // stallLossPct is cut instead of bleeding to the full stop.
    if (ex.stallAfterMin && minsOpen >= ex.stallAfterMin) {
      const peakPct = (((hi || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakPct < (ex.stallMaxPeakPct != null ? ex.stallMaxPeakPct : 1) && changePct <= -ex.stallLossPct) return close('stall');
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

// Exit judging on what we would actually get. quote = Jupiter sell quote for the position's
// remaining tokens (sane, or null); otherwise falls back to the depth model (mid minus modeled
// impact/slippage/fee). Net of the exit tx cost and the remaining share of the entry tx cost.
// Returns { price, netPct, netSol, execPrice, source }: `price` is the mid-equivalent to feed decide()
// (entryPrice * (1 + netPct/100)), so every %-trigger (TP/SL/trail/breakeven/time) compares NET PnL.
function judgeExit(pos, { quote, midPrice, liquidityUsd, solUsd }) {
  const frac = pos.remainingFrac == null ? 1 : pos.remainingFrac;
  const basis = pos.sizeSol * frac;
  let execPrice, source;
  if (quote && quote.ok && quote.quotedPriceUsd > 0) {
    execPrice = quote.quotedPriceUsd; source = 'jupiter';
  } else {
    if (!(midPrice > 0)) return null;
    const valueUsd = basis * solUsd * (midPrice / pos.entryFillPrice);
    execPrice = fillModel.fillExit({ midPrice, valueUsd, liquidityUsd: liquidityUsd || pos.entryLiquidityUsd || 0, reason: 'judge', rng: () => 1 }).price;
    source = 'model';
  }
  const netSol = basis * (execPrice / pos.entryFillPrice - 1) - fillModel.txCostSol(1, 0) - (pos.entryTxCostSol || 0) * frac;
  const netPct = (netSol / basis) * 100;
  return { price: pos.entryPrice * (1 + netPct / 100), netPct, netSol, execPrice, source };
}

const PROFIT_REASONS = new Set(['tp', 'tp1', 'tp2']);
function isProfitReason(reason) { return PROFIT_REASONS.has(reason); }

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

// Waiting for the first real sell quote (after a restart the exit-quote cache is empty).
// While waiting and judged on the MODEL price: only a hard stop (net <= -hardStopPct, at least the
// strategy's own stop) or an emergency exit (rug / liquidity / no sells) may fire; SL, trail,
// breakeven, TP and time exits are held until a quote arrives or the wait expires.
// Returns { d, held, modelExit }.
function awaitQuoteGate(pos, d, judge, { waiting, hardStopPct }) {
  if (!waiting || !judge || judge.source !== 'model') return { d, held: null, modelExit: false };
  if (d && /^(hard-stop|emergency)/.test(d.reason)) return { d, held: null, modelExit: true };
  const ex = pos.exit || {};
  const hs = Math.max(hardStopPct || 0, ex.hardStopPct || 0, ex.stopLossPct || 0);
  if (hs > 0 && judge.netPct <= -hs) {
    return { d: { action: 'close', reason: 'hard-stop', sellFrac: pos.remainingFrac == null ? 1 : pos.remainingFrac, fillPrice: judge.price }, held: d ? d.reason : null, modelExit: true };
  }
  return { d: null, held: d ? d.reason : null, modelExit: false };
}

module.exports = { decide, shouldExit, legPnlSol, judgeExit, isProfitReason, awaitQuoteGate };
