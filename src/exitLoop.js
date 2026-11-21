// PR14 (Liviu t72u): one exit loop for EVERY open paper trade (legacy dip-hold / momentum-entry /
// dip-buyers / buyer-turn / aggressive-flow + the 4 books), separate from the 45 s scan.
// Every exit decision is taken on a real Jupiter SELL quote (read-only quote API, never a swap) for the
// position's token amount, no older than maxExitQuoteAgeSec (10 s). No DexScreener price is used to mark
// or exit a legacy position any more. Paper only: nothing here signs or sends anything.
const stopFills = require('./stopFills');
const MIN = 60000;

// Cadence: aim for a pass every targetMs (5 s); never spend more than exitQuotesPerMin Jupiter quotes a
// minute on exits (the books bucket also serves entries), so with many open trades the period stretches
// (n * 60/exitQuotesPerMin s). Returns the pause after a pass.
function nextDelayMs(passMs, nChecked, cfg) {
  const target = cfg.targetMs || 5000;
  const budget = cfg.exitQuotesPerMin || 45;
  const period = Math.max(target, Math.ceil(nChecked * 60000 / budget));
  return Math.max(cfg.minRestMs == null ? 200 : cfg.minRestMs, period - passMs);
}

function pctile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null; }
function makeStats() {
  const s = { passes: 0, errors: 0, lastPassAt: null, lastPassMs: null, avgPassMs: null, lastDelayMs: null, lastError: null, positionsChecked: 0, quotesUsed: 0, staleRefusals: 0, intervals: [], passPeriods: [], lastPassStart: null };
  s.onCheck = function (pos, prev, t) { if (prev && prev.at) { s.intervals.push((t - Date.parse(prev.at)) / 1000); if (s.intervals.length > 500) s.intervals.shift(); } };
  s.view = function (cfg, openCount) {
    const iv = s.intervals.slice().sort((a, b) => a - b);
    const pp = s.passPeriods.slice().sort((a, b) => a - b);
    const r = v => (v == null ? null : +v.toFixed(2));
    return { targetSec: (cfg.targetMs || 5000) / 1000, exitQuotesPerMin: cfg.exitQuotesPerMin, maxExitQuoteAgeSec: cfg.maxExitQuoteAgeSec, openPositions: openCount,
      passes: s.passes, errors: s.errors, lastError: s.lastError, lastPassAt: s.lastPassAt, lastPassMs: s.lastPassMs, avgPassMs: s.avgPassMs, lastDelayMs: s.lastDelayMs,
      passPeriodSec: { median: r(pctile(pp, 0.5)), p90: r(pctile(pp, 0.9)), samples: pp.length },
      checkIntervalSec: { median: r(pctile(iv, 0.5)), p90: r(pctile(iv, 0.9)), max: r(iv.length ? iv[iv.length - 1] : null), samples: iv.length, note: 'seconds between two successive Jupiter-quoted checks of the same position (last 500)' },
      positionsChecked: s.positionsChecked, staleRefusals: s.staleRefusals };
  };
  return s;
}

// Legacy positions (state.openPositions). Token amount: tokensRaw from the Jupiter buy quote taken at entry;
// positions opened before PR14 get an estimate sizeSol * SOL/USD / entryPriceUsd (tokensEstimated: true).
function makeLegacyExits({ config, quotes, mintAuth, sellAgent, computePnl, classifyBlocked, onClose, log, now }) {
  const nowFn = now || Date.now;
  const C = config.books;
  const stats = { checks: 0, quoteFailures: 0, noRoute: 0, staleRefusals: 0, tokenEstimates: 0, tokenEstimateFailures: 0, closes: 0 };

  function liveExit(pos) {
    const live = pos.strategyType !== 'ncs' && config.strategies.find(s => s.id === pos.strategyId);
    return Object.assign({}, pos.exit || {}, live && live.exit ? live.exit : {});
  }
  async function ensureTokens(pos) {
    if (pos.tokensRaw && /^[0-9]+$/.test(String(pos.tokensRaw)) && pos.tokensRaw !== '0') return true;
    if (!pos.mint || !(pos.entryPrice > 0) || !(pos.sizeSol > 0)) return false;
    const m = await mintAuth.check(pos.mint);
    const sol = await quotes.getSolUsd();
    if (!Number.isInteger(m && m.decimals) || !(sol && sol.v > 0)) { stats.tokenEstimateFailures++; return false; }
    const ui = (pos.sizeSol * sol.v) / pos.entryPrice;
    const raw = BigInt(Math.floor(ui * 10 ** Math.min(m.decimals, 9))) * 10n ** BigInt(Math.max(0, m.decimals - 9));
    if (raw <= 0n) { stats.tokenEstimateFailures++; return false; }
    pos.tokensRaw = raw.toString(); pos.decimals = m.decimals; pos.tokensEstimated = true;
    pos.tokensEstimate = { solUsd: sol.v, entryPriceUsd: pos.entryPrice, at: new Date(nowFn()).toISOString(), note: 'opened before PR14: tokens = sizeSol * SOL/USD / entry price' };
    stats.tokenEstimates++;
    return true;
  }
  function close(state, pos, reason, price, extra) {
    const pnl = computePnl(pos, price);
    const t = nowFn();
    state.balance += pos.sizeSol + pnl;
    const trade = Object.assign({}, pos, { legacy: true, book: null, strategyVersion: (pos.strategyId || 'legacy') + ' legacy', exitReason: reason, exitPrice: price, exitPriceSource: 'jupiter-sell-quote',
      pnlSol: pnl, pnlPct: +((pnl / (pos.sizeSol || 1)) * 100).toFixed(3), closedAt: new Date(t).toISOString() }, extra || {});
    state.openPositions = state.openPositions.filter(p => p !== pos); // by identity: keeps entries pushed meanwhile
    stats.closes++;
    if (onClose) onClose(trade, pos);
    return trade;
  }

  async function runOne(state, pos, hooks) {
    const maxAge = C.maxExitQuoteAgeSec || 10;
    if (!(await ensureTokens(pos))) {
      // No token amount (no mint / RPC down): only time exits on the last mark; never a TP/SL.
      const d = sellAgent.decide(pos, Number(pos.lastPrice) || pos.entryPrice, false, null, nowFn());
      if (d) close(state, pos, d.reason, Number(pos.lastPrice) || pos.entryPrice, { exitPriceSource: 'last-mark (no token amount)' });
      return;
    }
    const q = await quotes.sellQuote(pos.mint, pos.tokensRaw);
    const t = nowFn();
    stats.checks++;
    pos.quoteChecks = (pos.quoteChecks || 0) + 1;
    if (!q.ok) {
      stats.quoteFailures++;
      pos.quoteFailures = (pos.quoteFailures || 0) + 1;
      pos.lastQuoteError = String(q.error || '').slice(0, 80);
      if (q.noRoute) {
        stats.noRoute++;
        pos.noRouteCount = (pos.noRouteCount || 0) + 1;
        if (!pos.noRouteSince) pos.noRouteSince = new Date(t).toISOString();
        if (pos.noRouteCount >= (C.noRouteConsecutive || 5) && t - Date.parse(pos.noRouteSince) >= C.noRouteTotalLossMin * MIN) {
          close(state, pos, 'no-route-total-loss', 0, { exitPriceSource: 'no sell route (' + pos.noRouteCount + ' consecutive)' });
          if (log) log('EXIT', pos.symbol, 'no-route-total-loss');
        }
        return;
      }
      // Quote failed (not a missing route): only time exits may fire, on the last Jupiter mark.
      const d = sellAgent.decide(pos, Number(pos.lastPrice) || pos.entryPrice, false, null, t);
      if (d) close(state, pos, d.reason, Number(pos.lastPrice) || pos.entryPrice, { exitPriceSource: 'last jupiter mark (quote failed)' });
      return;
    }
    pos.noRouteSince = null; pos.noRouteCount = 0;
    const ageSec = (t - q.at) / 1000;
    if (!(ageSec <= maxAge)) { stats.staleRefusals++; pos.staleQuoteRefusals = (pos.staleQuoteRefusals || 0) + 1; return; }
    const pct = (Number(q.outAmount) / 1e9 / pos.sizeSol - 1) * 100;     // gross Jupiter sell quote vs SOL size
    const price = pos.entryPrice * (1 + pct / 100);                      // entry-price equivalent fed to the exit rules
    const prevCheck = pos.lastCheck || null;
    if (hooks && hooks.onCheck) hooks.onCheck(pos, prevCheck, t);
    if (!pos.quoteMarkedSince) {
      // First Jupiter mark: drop highs taken from DexScreener marks so trails/locks judge one source.
      pos.quoteMarkedSince = new Date(t).toISOString();
      pos.dexHighestBeforePR14 = pos.highest == null ? null : pos.highest;
      pos.highest = Math.max(pos.entryPrice, price);
      if (pos.judgedHigh != null) delete pos.judgedHigh;
      if (pos.timeTrailArmedAt) pos.timeTrailHigh = price;
    }
    pos.lastCheck = { at: new Date(t).toISOString(), pct: +pct.toFixed(3), price, quoteAgeSec: +ageSec.toFixed(2), priceImpactPct: q.priceImpactPct };
    pos.lastPrice = price; pos.lastPricedAt = pos.lastCheck.at; pos.priceStale = false;
    pos.markSource = 'jupiter-sell-quote'; pos.markPct = +pct.toFixed(3); pos.markAt = new Date(q.at).toISOString();
    pos.lastQuote = { inAmount: q.inAmount, outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, at: pos.markAt };
    if (price > (pos.highest || 0)) pos.highest = price;
    pos.peakPct = Math.max(pos.peakPct == null ? -Infinity : pos.peakPct, pos.markPct);
    const exitQuote = { inAmount: q.inAmount, outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, at: pos.markAt, ageSec: +ageSec.toFixed(2), route: q.route || null };
    const stockWhy = classifyBlocked({ mint: pos.mint, symbol: pos.symbol, name: pos.name });
    if (stockWhy) {
      state.stockClosures = (state.stockClosures || []).concat([{ symbol: pos.symbol, mint: pos.mint || null, strategyId: pos.strategyId, reason: stockWhy, price, priceSource: 'jupiter-sell-quote', at: new Date(t).toISOString() }]).slice(-20);
      close(state, pos, 'stock-block', price, { exitQuote });
      return;
    }
    const d = sellAgent.decide(pos, price, true, null, t);
    if (!d) return;
    const extra = { exitQuote };
    if (stopFills.isStop(d.reason)) {
      const ex = liveExit(pos);
      const level = d.reason === 'hard-stop' ? ex.hardStopPct : ex.stopLossPct;
      const net = pct - (config.costRoundtripPct || 1.1);
      extra.stopFill = stopFills.record(state, stopFills.build({ pos, strategyId: pos.strategyId, strategyVersion: (pos.strategyId || 'legacy') + ' legacy', stopLevelPct: level,
        entryPriceSolPerToken: pos.entryPrice, prevCheck, fill: { price, pct, quoteAgeSec: ageSec, priceImpactPct: q.priceImpactPct }, netPnlPct: net,
        liquidityUsd: pos.lastLiquidityUsd != null ? pos.lastLiquidityUsd : pos.entryLiquidityUsd, now: t }));
      extra.stopFill.priceUnit = 'USD (entry-price equivalent of the Jupiter quote)';
      if (pos.tokensEstimated) extra.stopFill.tokensEstimated = true;
    }
    close(state, pos, d.reason, price, extra);
  }

  async function run(state, hooks) {
    let n = 0;
    for (const pos of (state.openPositions || []).slice()) {
      if (!state.openPositions.includes(pos)) continue;
      n++;
      await runOne(state, pos, hooks);
    }
    return n;
  }
  return { run, runOne, ensureTokens, stats };
}

module.exports = { makeLegacyExits, nextDelayMs, makeStats };
