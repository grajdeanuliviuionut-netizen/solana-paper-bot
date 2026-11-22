// t86u (Liviu 22 Nov 12:12): the Manager's continuous improvement loop for runner-hunter (PAPER ONLY).
// Every 10 closed runner-hunter trades in the current scoreboard epoch it reviews those 10 trades, picks
// exactly ONE bounded change from a whitelist of paper knobs with fixed, deterministic rules (first rule that
// fires and whose knob is not at its bound wins), applies it as a new runner-hunter version (old config kept
// in previousVersions), logs { at, tradeIndex, stats, change, from, to, why } in state.manager.log and keeps
// trading. Every 30 closed trades it stores a report (win rate, avg win, avg loss, net) in state.manager.reports.
// It never touches sizes, wallets, keys, LIVE_TRADING or anything outside these knobs.
const BOUNDS = {
  'entry.minLiquidityUsd': { min: 100000, max: 300000, step: 25000 },
  'entry.maxH1': { min: 10, max: 25, step: 5 },
  'entry.minM5': { min: 0, max: 3, step: 0.5 },
  'entry.minVolumeToLiquidityH24': { min: 0.1, max: 0.5, step: 0.05 },
  'entry.maxTop10Pct': { min: 15, max: 30, step: 5 },
  'exit.stopLossPct': { min: 5, max: 8, step: 1 },
  'exit.partial.atPct': { min: 6, max: 12, step: 1 },
  'exit.trailPct': { min: 6, max: 12, step: 1 }
};
const RULES = [
  'R1 stops overshoot: >= 2 stops and avg stop overshoot <= -2 pts -> raise entry.minLiquidityUsd +25k (max 300k)',
  'R2 fast stops: win rate < 40% and >= 3 stops within 15 min -> require stronger 5-min move: entry.minM5 +0.5 (max 3)',
  'R3 noise stops: R2 fired but minM5 at max -> widen exit.stopLossPct +1 (max 8)',
  'R4 early trails: >= 3 trail exits averaging < +3% -> widen exit.trailPct +1 (max 12)',
  'R5 no partials: 0 partial sells and >= 3 time exits -> lower exit.partial.atPct -1 (min 6)',
  'R6 buying tops: win rate < 40% and losers entered on h1 >= 5 pts higher than winners -> lower entry.maxH1 -5 (min 10)',
  'R7 concentrated losers: losers top10 >= 5 pts higher than winners -> lower entry.maxTop10Pct -5 (min 15)',
  'R8 still losing: net < 0 -> busier coins only: entry.minVolumeToLiquidityH24 +0.05 (max 0.5)',
  'R9 healthy (net >= 0 and win rate >= 40%) -> no change'
];
// t89u v4 (Liviu 22 Nov 13:18): hard rules the Manager may only TIGHTEN (max = the hard value): slippage <= 150
// bps, top-10 <= 15%, stop <= 6%, max hold <= 30 min. Rug check, breakeven, trail, 15-min momentum rule and the
// 3-loss / 1 h + 5%/24 h guardrails are not in the whitelist at all. Entry knobs are tuned within bounds.
const BOUNDS_V4 = {
  'entry.minLiquidityUsd': { min: 100000, max: 300000, step: 25000 },
  'entry.maxH1': { min: 10, max: 25, step: 5 },
  'entry.minM5': { min: 0, max: 3, step: 0.5 },
  'entry.minVolumeToLiquidityH24': { min: 0.1, max: 0.5, step: 0.05 },
  'entry.maxTop10Pct': { min: 5, max: 15, step: 2.5, hard: 'tighten-only' },
  'entry.maxSlippageBps': { min: 50, max: 150, step: 25, hard: 'tighten-only' },
  'exit.stopLossPct': { min: 4, max: 6, step: 1, hard: 'tighten-only' },
  'exit.maxHoldMinutes': { min: 15, max: 30, step: 5, hard: 'tighten-only' }
};
// Hard ceilings (v4): a change past these is refused even if a bound were mis-set.
const HARD_V4 = { 'entry.maxTop10Pct': 15, 'entry.maxSlippageBps': 150, 'exit.stopLossPct': 6, 'exit.maxHoldMinutes': 30 };
const RULES_V4 = [
  'R1 stops overshoot: >= 2 stops and avg stop overshoot <= -2 pts -> entry.minLiquidityUsd +25k (max 300k)',
  'R2 fast stops: win rate < 40% and >= 3 stops within 15 min -> entry.minM5 +0.5 (max 3)',
  'R3 fast stops, minM5 at max -> cut losers sooner: exit.stopLossPct -1 (min 4; tighten only)',
  'R5 no momentum: >= 4 exits on the 15-min +4% rule -> entry.minM5 +0.5 (max 3)',
  'R6 buying tops: win rate < 40% and losers h1 >= 5 pts above winners -> entry.maxH1 -5 (min 10)',
  'R7 concentrated losers: losers top10 >= 5 pts above winners -> entry.maxTop10Pct -2.5 (min 5; tighten only)',
  'R10 costly fills: avg entry slippage >= 1% -> entry.maxSlippageBps -25 (min 50; tighten only)',
  'R8 still losing: net < 0 -> entry.minVolumeToLiquidityH24 +0.05 (max 0.5)',
  'R9 healthy (net >= 0 and win rate >= 40%) -> no change'
];
// t90u v5 (Liviu 22 Nov 13:56): hard rules the Manager may only TIGHTEN: volume spike >= 3x (min = hard),
// top-10 <= 15%, slippage <= 150 bps, stop <= 6%, time limit <= 25 min. Not in the whitelist at all: the TP tiers
// (+2..+4%), the breakout window, night hours, feed protection, sizing (5% of equity), rug check, 2-loss pause, halt.
const BOUNDS_V5 = {
  'entry.minLiquidityUsd': { min: 100000, max: 300000, step: 25000 },
  'entry.maxH1': { min: 10, max: 25, step: 5 },
  'entry.minM5': { min: 0, max: 3, step: 0.5 },
  'entry.minVolumeToLiquidityH24': { min: 0.1, max: 0.5, step: 0.05 },
  'entry.breakout.minVolSpike': { min: 3, max: 6, step: 0.5, hard: 'tighten-only (min 3)' },
  'entry.maxTop10Pct': { min: 5, max: 15, step: 2.5, hard: 'tighten-only' },
  'entry.maxSlippageBps': { min: 50, max: 150, step: 25, hard: 'tighten-only' },
  'exit.stopLossPct': { min: 4, max: 6, step: 1, hard: 'tighten-only' },
  'exit.maxHoldMinutes': { min: 15, max: 25, step: 5, hard: 'tighten-only' }
};
// value must stay <= max (or >= min) of these hard limits.
const HARD_V5 = { 'entry.maxTop10Pct': { max: 15 }, 'entry.maxSlippageBps': { max: 150 }, 'exit.stopLossPct': { max: 6 }, 'exit.maxHoldMinutes': { max: 25 }, 'entry.breakout.minVolSpike': { min: 3 } };
const RULES_V5 = [
  'R1 stops overshoot: >= 2 stops and avg stop overshoot <= -2 pts -> entry.minLiquidityUsd +25k (max 300k)',
  'R2 fast stops: win rate < 40% and >= 3 stops -> stronger spike: entry.breakout.minVolSpike +0.5 (max 6)',
  'R3 fast stops, spike at max -> cut losers sooner: exit.stopLossPct -1 (min 4; tighten only)',
  'R4 TP not reached: >= 4 time exits -> stronger 5-min move: entry.minM5 +0.5 (max 3)',
  'R6 buying tops: win rate < 40% and losers h1 >= 5 pts above winners -> entry.maxH1 -5 (min 10)',
  'R7 concentrated losers: losers top10 >= 5 pts above winners -> entry.maxTop10Pct -2.5 (min 5)',
  'R10 costly fills: avg entry slippage >= 1% -> entry.maxSlippageBps -25 (min 50)',
  'R8 still losing: net < 0 -> entry.minVolumeToLiquidityH24 +0.05 (max 0.5)',
  'R9 healthy (net >= 0 and win rate >= 40%) -> no change'
];
// t93u v6 Trend Following (Liviu 22 Nov 14:53): the Manager may only tighten: stop <= 4% (never looser than -4),
// liquidity floor >= $50k, top-10 <= 15%, slippage <= 150 bps; MA margin 0..3% above the 50 MA; TP 6..12%.
// Not in the whitelist: the MA period, the rug gates (mint/freeze revoked, blacklist), 2-loss pause, night
// hours, sizing, feed protection, the 2% slip cost model, the halt.
const BOUNDS_V6 = {
  'entry.minLiquidityUsd': { min: 50000, max: 250000, step: 25000, hard: 'never below $50k' },
  'entry.trend.minAbovePct': { min: 0, max: 3, step: 0.5 },
  'entry.maxTop10Pct': { min: 5, max: 15, step: 2.5, hard: 'tighten-only' },
  'entry.maxSlippageBps': { min: 50, max: 150, step: 25, hard: 'tighten-only' },
  'exit.stopLossPct': { min: 2, max: 4, step: 0.5, hard: 'tighten-only (never beyond -4%)' },
  'exit.takeProfitPct': { min: 6, max: 12, step: 1 }
};
const HARD_V6 = { 'entry.minLiquidityUsd': { min: 50000 }, 'entry.maxTop10Pct': { max: 15 }, 'entry.maxSlippageBps': { max: 150 }, 'exit.stopLossPct': { max: 4 } };
const RULES_V6 = [
  'R1 fast stops: win rate < 40% and >= 3 stops -> stronger trend: entry.trend.minAbovePct +0.5 (max 3)',
  'R2 stops overshoot: >= 2 stops and avg stop overshoot <= -2 pts -> entry.minLiquidityUsd +25k (max 250k)',
  'R3 TP rarely reached: >= 3 time exits and 0 TPs -> exit.takeProfitPct -1 (min 6)',
  'R7 concentrated losers: losers top10 >= 5 pts above winners -> entry.maxTop10Pct -2.5 (min 5)',
  'R10 costly fills: avg entry slippage >= 1% -> entry.maxSlippageBps -25 (min 50)',
  'R8 still losing: net < 0 -> entry.minLiquidityUsd +25k (max 250k)',
  'R9 healthy (net >= 0 and win rate >= 40%) -> no change'
];
const isV6 = book => !!(book && book.entry && book.entry.trend);
const isV5 = book => !!(book && book.exit && book.exit.takeProfit);
const isV4 = book => !!(book && ((book.entry && book.entry.rugCheck) || (book.exit && book.exit.breakevenAtPct != null)));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r = (v, d) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d == null ? 6 : d));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k] || (a[k] = {}); a[ks[ks.length - 1]] = v; }

function stats(trades) {
  const pnl = trades.map(t => num(t.pnlSol));
  const wins = trades.filter(t => num(t.pnlSol) > 0), losses = trades.filter(t => num(t.pnlSol) <= 0);
  const stops = trades.filter(t => t.exitReason === 'sl');
  const over = stops.map(t => t.stopFill && t.stopFill.overshootPct).filter(x => Number.isFinite(Number(x))).map(Number);
  const trails = trades.filter(t => t.exitReason === 'trail');
  const h1 = a => avg(a.map(t => t.entrySignal && t.entrySignal.h1).filter(x => Number.isFinite(Number(x))).map(Number));
  const top = a => avg(a.map(t => t.entrySignal && t.entrySignal.top10Pct).filter(x => Number.isFinite(Number(x))).map(Number));
  return {
    trades: trades.length, wins: wins.length, losses: losses.length, winRatePct: trades.length ? r((100 * wins.length) / trades.length, 1) : null,
    avgWinSol: r(avg(wins.map(t => num(t.pnlSol)))), avgLossSol: r(avg(losses.map(t => num(t.pnlSol)))),
    avgWinPct: r(avg(wins.map(t => num(t.pnlPct))), 3), avgLossPct: r(avg(losses.map(t => num(t.pnlPct))), 3),
    netSol: r(pnl.reduce((s, x) => s + x, 0)),
    stops: stops.length, fastStops: stops.filter(t => num(t.holdMinutes) < 15).length, avgStopOvershootPct: r(avg(over), 3),
    trails: trails.length, trailAvgPct: r(avg(trails.map(t => num(t.pnlPct))), 3),
    timeExits: trades.filter(t => t.exitReason === 'time').length, tps: trades.filter(t => t.exitReason === 'tp').length,
    partials: trades.filter(t => (t.legs || []).some(l => /partial/.test(String(l.reason)))).length,
    noMomentum: trades.filter(t => t.exitReason === 'no-momentum').length,
    avgEntrySlippagePct: r(avg(trades.map(t => t.entrySlippagePct).filter(x => Number.isFinite(Number(x))).map(Number)), 3),
    winnersAvgH1: r(h1(wins), 2), losersAvgH1: r(h1(losses), 2), winnersAvgTop10: r(top(wins), 2), losersAvgTop10: r(top(losses), 2)
  };
}

// Pure: picks one change. params = { entry, exit }. Returns { rule, knob, from, to, why } or { rule: 'R9'|'none', knob: null, why }.
function decide(s, params, v4) {
  const v5 = v4 === 'v5';
  const BB = v5 ? BOUNDS_V5 : v4 ? BOUNDS_V4 : BOUNDS;
  const at = k => getPath(params, k);
  const can = (k, dir) => { const b = BB[k], v = at(k); if (!b) return false; return v != null && (dir > 0 ? v + 1e-9 < b.max : v - 1e-9 > b.min); };
  const move = (k, dir) => { const b = BB[k]; const v = at(k); return +Math.min(b.max, Math.max(b.min, v + dir * b.step)).toFixed(4); };
  const pick = (rule, k, dir, why) => (can(k, dir) ? { rule, knob: k, from: at(k), to: move(k, dir), why } : null);
  const lowWin = s.winRatePct != null && s.winRatePct < 40;
  if (v4 === 'v6') {
    const B6 = BOUNDS_V6;
    const can6 = (k, dir) => { const b = B6[k], v = at(k); return !!b && v != null && (dir > 0 ? v + 1e-9 < b.max : v - 1e-9 > b.min); };
    const pick6 = (rule, k, dir, why) => (can6(k, dir) ? { rule, knob: k, from: at(k), to: +Math.min(B6[k].max, Math.max(B6[k].min, at(k) + dir * B6[k].step)).toFixed(4), why } : null);
    const tps = s.tps != null ? s.tps : null;
    const c6 = [
      () => lowWin && s.stops >= 3 && pick6('R1', 'entry.trend.minAbovePct', +1, 'win rate ' + s.winRatePct + '% with ' + s.stops + ' stops: require price further above the 50 MA'),
      () => s.stops >= 2 && s.avgStopOvershootPct != null && s.avgStopOvershootPct <= -2 && pick6('R2', 'entry.minLiquidityUsd', +1, s.stops + ' stops filled ' + s.avgStopOvershootPct + ' pts past the stop: deeper pools'),
      () => s.timeExits >= 3 && !tps && pick6('R3', 'exit.takeProfitPct', -1, s.timeExits + ' trades hit the 240 min cap without the TP'),
      () => s.losersAvgTop10 != null && s.winnersAvgTop10 != null && s.losersAvgTop10 - s.winnersAvgTop10 >= 5 && pick6('R7', 'entry.maxTop10Pct', -1, 'losers had top-10 ' + s.losersAvgTop10 + '% vs winners ' + s.winnersAvgTop10 + '%'),
      () => s.avgEntrySlippagePct != null && s.avgEntrySlippagePct >= 1 && pick6('R10', 'entry.maxSlippageBps', -1, 'average entry slippage ' + s.avgEntrySlippagePct + '%'),
      () => s.netSol < 0 && pick6('R8', 'entry.minLiquidityUsd', +1, 'net ' + s.netSol + ' SOL over the last ' + s.trades + ' trades: only deeper pools')
    ];
    if (s.netSol >= 0 && !lowWin) return { rule: 'R9', knob: null, why: 'healthy: net ' + s.netSol + ' SOL, win rate ' + s.winRatePct + '%: no change' };
    for (const c of c6) {
      const d = c();
      const hl = d && HARD_V6[d.knob];
      if (d && !(hl && ((hl.max != null && d.to > hl.max) || (hl.min != null && d.to < hl.min)))) return d;
    }
    return { rule: 'none', knob: null, why: 'no rule fired with a knob inside its bounds: no change' };
  }
  if (v5) {
    const c5 = [
      () => s.stops >= 2 && s.avgStopOvershootPct != null && s.avgStopOvershootPct <= -2 && pick('R1', 'entry.minLiquidityUsd', +1, s.stops + ' stops filled ' + s.avgStopOvershootPct + ' pts past the level on average: thicker pools fill closer to the stop'),
      () => lowWin && s.stops >= 3 && pick('R2', 'entry.breakout.minVolSpike', +1, 'win rate ' + s.winRatePct + '% with ' + s.stops + ' stops: require a bigger volume spike'),
      () => lowWin && s.stops >= 3 && !can('entry.breakout.minVolSpike', +1) && pick('R3', 'exit.stopLossPct', -1, s.stops + ' stops and the spike filter at its cap: cut losers one point sooner'),
      () => s.timeExits >= 4 && pick('R4', 'entry.minM5', +1, s.timeExits + ' trades missed the TP within the time limit: require a stronger 5-min move'),
      () => lowWin && s.losersAvgH1 != null && s.winnersAvgH1 != null && s.losersAvgH1 - s.winnersAvgH1 >= 5 && pick('R6', 'entry.maxH1', -1, 'losers entered on h1 ' + s.losersAvgH1 + '% vs winners ' + s.winnersAvgH1 + '%'),
      () => s.losersAvgTop10 != null && s.winnersAvgTop10 != null && s.losersAvgTop10 - s.winnersAvgTop10 >= 5 && pick('R7', 'entry.maxTop10Pct', -1, 'losers had top-10 ' + s.losersAvgTop10 + '% vs winners ' + s.winnersAvgTop10 + '%'),
      () => s.avgEntrySlippagePct != null && s.avgEntrySlippagePct >= 1 && pick('R10', 'entry.maxSlippageBps', -1, 'average entry slippage ' + s.avgEntrySlippagePct + '%'),
      () => s.netSol < 0 && pick('R8', 'entry.minVolumeToLiquidityH24', +1, 'net ' + s.netSol + ' SOL over the last ' + s.trades + ' trades: only busier coins')
    ];
    if (s.netSol >= 0 && !lowWin) return { rule: 'R9', knob: null, why: 'healthy: net ' + s.netSol + ' SOL, win rate ' + s.winRatePct + '%: no change' };
    for (const c of c5) {
      const d = c();
      const hl = d && HARD_V5[d.knob];
      if (d && !(hl && ((hl.max != null && d.to > hl.max) || (hl.min != null && d.to < hl.min)))) return d;   // never loosen a hard rule
    }
    return { rule: 'none', knob: null, why: 'no rule fired with a knob inside its bounds: no change' };
  }
  if (v4) {
    const c4 = [
      () => s.stops >= 2 && s.avgStopOvershootPct != null && s.avgStopOvershootPct <= -2 && pick('R1', 'entry.minLiquidityUsd', +1, s.stops + ' stops filled ' + s.avgStopOvershootPct + ' pts past the level on average: thicker pools fill closer to the stop'),
      () => lowWin && s.fastStops >= 3 && pick('R2', 'entry.minM5', +1, 'win rate ' + s.winRatePct + '% with ' + s.fastStops + ' stops inside 15 min: require a stronger 5-min move'),
      () => lowWin && s.fastStops >= 3 && !can('entry.minM5', +1) && pick('R3', 'exit.stopLossPct', -1, s.fastStops + ' fast stops and minM5 at its cap: cut losers one point sooner'),
      () => s.noMomentum >= 4 && pick('R5', 'entry.minM5', +1, s.noMomentum + ' exits had not reached +4% in 15 min: require a stronger 5-min move'),
      () => lowWin && s.losersAvgH1 != null && s.winnersAvgH1 != null && s.losersAvgH1 - s.winnersAvgH1 >= 5 && pick('R6', 'entry.maxH1', -1, 'losers entered on h1 ' + s.losersAvgH1 + '% vs winners ' + s.winnersAvgH1 + '%: stop buying extended moves'),
      () => s.losersAvgTop10 != null && s.winnersAvgTop10 != null && s.losersAvgTop10 - s.winnersAvgTop10 >= 5 && pick('R7', 'entry.maxTop10Pct', -1, 'losers had top-10 ' + s.losersAvgTop10 + '% vs winners ' + s.winnersAvgTop10 + '%: tighten holder concentration'),
      () => s.avgEntrySlippagePct != null && s.avgEntrySlippagePct >= 1 && pick('R10', 'entry.maxSlippageBps', -1, 'average entry slippage ' + s.avgEntrySlippagePct + '%: tighten the slippage limit'),
      () => s.netSol < 0 && pick('R8', 'entry.minVolumeToLiquidityH24', +1, 'net ' + s.netSol + ' SOL over the last ' + s.trades + ' trades: only busier coins')
    ];
    if (s.netSol >= 0 && !lowWin) return { rule: 'R9', knob: null, why: 'healthy: net ' + s.netSol + ' SOL, win rate ' + s.winRatePct + '%: no change' };
    for (const c of c4) {
      const d = c();
      if (d && !(HARD_V4[d.knob] != null && d.to > HARD_V4[d.knob])) return d;   // never loosen a hard rule
    }
    return { rule: 'none', knob: null, why: 'no rule fired with a knob inside its bounds: no change' };
  }
  const cands = [
    () => s.stops >= 2 && s.avgStopOvershootPct != null && s.avgStopOvershootPct <= -2 && pick('R1', 'entry.minLiquidityUsd', +1, s.stops + ' stops filled ' + s.avgStopOvershootPct + ' pts past the level on average: thicker pools fill closer to the stop'),
    () => lowWin && s.fastStops >= 3 && pick('R2', 'entry.minM5', +1, 'win rate ' + s.winRatePct + '% with ' + s.fastStops + ' stops inside 15 min: require a stronger 5-min move'),
    () => lowWin && s.fastStops >= 3 && !can('entry.minM5', +1) && pick('R3', 'exit.stopLossPct', +1, s.fastStops + ' fast stops and minM5 already at its cap: give the stop one more point'),
    () => s.trails >= 3 && s.trailAvgPct != null && s.trailAvgPct < 3 && pick('R4', 'exit.trailPct', +1, s.trails + ' trail exits averaging ' + s.trailAvgPct + '%: the trail gives back too early'),
    () => s.partials === 0 && s.timeExits >= 3 && pick('R5', 'exit.partial.atPct', -1, 'no trade reached the partial and ' + s.timeExits + ' timed out: take the first third earlier'),
    () => lowWin && s.losersAvgH1 != null && s.winnersAvgH1 != null && s.losersAvgH1 - s.winnersAvgH1 >= 5 && pick('R6', 'entry.maxH1', -1, 'losers entered on h1 ' + s.losersAvgH1 + '% vs winners ' + s.winnersAvgH1 + '%: stop buying extended moves'),
    () => s.losersAvgTop10 != null && s.winnersAvgTop10 != null && s.losersAvgTop10 - s.winnersAvgTop10 >= 5 && pick('R7', 'entry.maxTop10Pct', -1, 'losers had top-10 ' + s.losersAvgTop10 + '% vs winners ' + s.winnersAvgTop10 + '%: tighten holder concentration'),
    () => s.netSol < 0 && pick('R8', 'entry.minVolumeToLiquidityH24', +1, 'net ' + s.netSol + ' SOL over the last ' + s.trades + ' trades: only busier coins')
  ];
  if (s.netSol >= 0 && !lowWin) return { rule: 'R9', knob: null, why: 'healthy: net ' + s.netSol + ' SOL, win rate ' + s.winRatePct + '%: no change' };
  for (const c of cands) { const d = c(); if (d) return d; }
  return { rule: 'none', knob: null, why: 'no rule fired with a knob inside its bounds: no change' };
}

function ensure(state, epoch, since) {
  const m = state.manager && typeof state.manager === 'object' ? state.manager : (state.manager = {});
  if (!Array.isArray(m.log)) m.log = [];
  if (!Array.isArray(m.reports)) m.reports = [];
  if (m.epoch !== epoch) { m.epoch = epoch; m.since = since; m.reviewedThrough = 0; m.reportedThrough = 0; }
  return m;
}

// One step (cheap; called every exit pass). book = the live runner-hunter config object (mutated on a change).
// Returns the log entry when a review ran, else null.
function step(state, book, opts) {
  const sb = state.scoreboard || {};
  if (!book || !sb.epoch || !sb.since) return null;
  const m = ensure(state, sb.epoch, sb.since);
  const sinceMs = Date.parse(sb.since);
  const trades = ((state.books && state.books.trades) || []).filter(t => t.book === book.id && Date.parse(t.closedAt) >= sinceMs
      && !(opts && opts.baseVersion && t.bookVersion != null && Number(t.bookVersion) < opts.baseVersion))   // v2 leftovers closing in the v3 epoch are not v3 results
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const nowIso = new Date((opts && opts.now) || Date.now()).toISOString();
  m.closedTrades = trades.length;
  let out = null;
  while (trades.length >= m.reportedThrough + 30) {
    const blk = trades.slice(m.reportedThrough, m.reportedThrough + 30);
    const s = stats(blk);
    m.reports.push({ at: nowIso, epoch: sb.epoch, fromTrade: m.reportedThrough + 1, toTrade: m.reportedThrough + 30, trades: s.trades, winRatePct: s.winRatePct, avgWinSol: s.avgWinSol, avgLossSol: s.avgLossSol, avgWinPct: s.avgWinPct, avgLossPct: s.avgLossPct, netSol: s.netSol,
      netWithoutBestSol: r(s.netSol - Math.max(...blk.map(t => num(t.pnlSol)))), worstLossPct: r(Math.min(...blk.map(t => num(t.pnlPct))), 3), version: book.version });
    m.reportedThrough += 30;
  }
  if (trades.length >= m.reviewedThrough + 10) {
    const blk = trades.slice(m.reviewedThrough, m.reviewedThrough + 10);
    const s = stats(blk);
    if (opts && opts.rejects) s.rejectsByFilter = opts.rejects;
    const params = { entry: JSON.parse(JSON.stringify(book.entry)), exit: JSON.parse(JSON.stringify(book.exit)) };
    const d = decide(s, params, isV6(book) ? 'v6' : isV5(book) ? 'v5' : isV4(book));
    const entry = { at: nowIso, epoch: sb.epoch, tradeIndex: m.reviewedThrough + 10, fromVersion: book.version, stats: s, rule: d.rule, change: d.knob, from: d.from == null ? null : d.from, to: d.to == null ? null : d.to, why: d.why, toVersion: book.version };
    if (d.knob) {
      const prev = { version: book.version, until: nowIso, entry: JSON.parse(JSON.stringify(params.entry)), exit: JSON.parse(JSON.stringify(params.exit)), by: 'manager', rule: d.rule };
      setPath(params, d.knob, d.to);
      book.previousVersions = [prev].concat(book.previousVersions || []).slice(0, 40);
      book.version = +(book.version + 0.01).toFixed(2);
      book.entry = params.entry; book.exit = params.exit;
      entry.toVersion = book.version;
      m.params = { baseVersion: (opts && opts.baseVersion) || null, version: book.version, entry: params.entry, exit: params.exit, previousVersions: book.previousVersions, at: nowIso };
    }
    m.log.unshift(entry);
    if (m.log.length > 200) m.log.length = 200;
    m.reviewedThrough += 10;
    out = entry;
  }
  return out;
}

// On boot: re-apply the manager's last version if it was built on the same code version.
function restore(state, book, baseVersion) {
  const p = state.manager && state.manager.params;
  if (!book || !p || p.baseVersion !== baseVersion || !p.entry || !p.exit) return false;
  book.version = p.version; book.entry = p.entry; book.exit = p.exit;
  if (Array.isArray(p.previousVersions)) book.previousVersions = p.previousVersions;
  return true;
}

module.exports = { step, decide, stats, restore, isV4, isV5, isV6, BOUNDS_V6, RULES_V6, HARD_V6, BOUNDS_V5, RULES_V5, HARD_V5, BOUNDS, RULES, BOUNDS_V4, RULES_V4, HARD_V4 };
