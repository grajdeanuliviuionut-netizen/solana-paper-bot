// PR14 (Liviu t72u): stop-fill log. For every stop exit (books 'sl'; legacy 'sl' / 'hard-stop') we
// record the configured stop, the expected stop price, the LAST check before the trigger, the actual
// Jupiter fill and the overshoot (actual gross % minus the stop level, e.g. -14 - (-12) = -2).
// All % here are GROSS Jupiter sell-quote returns vs the position's SOL cost basis (the 1.1% round-trip
// cost is charged separately inside pnlSol; netPnlPct is also recorded).
const STOP_REASONS = new Set(['sl', 'hard-stop']);
const isStop = r => STOP_REASONS.has(r);
// social-route-death-exit: a "stop" that filled on a dead pool (sell priceImpact ~100% / fill ~-100%) is a route death,
// not a fill-engine overshoot. It is tagged (deathLike) and reported separately, not mixed into the overshoot stats.
const DEATH_IMPACT_PCT = 50, DEATH_FILL_PCT = -90;
const isDeathLike = r => !!r && (r.deathLike === true || Number(r.priceImpactPct) >= DEATH_IMPACT_PCT || Number(r.actualFillPct) <= DEATH_FILL_PCT);
const r3 = v => (v == null || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(3));

function build({ pos, strategyId, strategyVersion, stopLevelPct, entryPriceSolPerToken, prevCheck, fill, netPnlPct, liquidityUsd, now }) {
  const stop = -Math.abs(Number(stopLevelPct));
  return {
    at: new Date(now).toISOString(), strategyId, strategyVersion, symbol: pos.symbol, mint: pos.mint || null, positionId: pos.id,
    stopLevelPct: stop,
    expectedStopPrice: entryPriceSolPerToken ? entryPriceSolPerToken * (1 + stop / 100) : null, priceUnit: 'SOL/token',
    entryPrice: entryPriceSolPerToken || null,
    lastCheckBefore: prevCheck ? { at: prevCheck.at, pnlPct: r3(prevCheck.pct), price: prevCheck.price || null, quoteAgeSec: r3(prevCheck.quoteAgeSec) } : null,
    lastCheckPnlPct: prevCheck ? r3(prevCheck.pct) : null,
    actualFillPrice: fill.price, actualFillPct: r3(fill.pct), netPnlPct: r3(netPnlPct),
    overshootPct: r3(fill.pct - stop),
    quoteAgeSec: r3(fill.quoteAgeSec), priceImpactPct: r3(fill.priceImpactPct), liquidityUsd: liquidityUsd == null ? null : Math.round(liquidityUsd),
    sinceLastCheckSec: prevCheck ? r3((now - Date.parse(prevCheck.at)) / 1000) : null,
    gapBetweenChecksPct: prevCheck ? r3(fill.pct - prevCheck.pct) : null,
    deathLike: Number(fill.priceImpactPct) >= DEATH_IMPACT_PCT || Number(fill.pct) <= DEATH_FILL_PCT
  };
}
function record(state, row) {
  state.stopFills = [row].concat(state.stopFills || []).slice(0, 200);
  return row;
}
function stats(rows) {
  const o = rows.map(r => r.overshootPct).filter(v => v != null).sort((a, b) => a - b);
  if (!o.length) return { count: 0, avgOvershootPct: null, medianOvershootPct: null, maxOvershootPct: null };
  const mid = o.length % 2 ? o[(o.length - 1) / 2] : (o[o.length / 2 - 1] + o[o.length / 2]) / 2;
  return { count: o.length, avgOvershootPct: r3(o.reduce((a, b) => a + b, 0) / o.length), medianOvershootPct: r3(mid), maxOvershootPct: r3(o[0]) };
}
function summary(state, since) {
  const all = (state.stopFills || []).filter(r => !since || r.at >= since);
  const rows = all.filter(r => !isDeathLike(r)), dead = all.filter(isDeathLike);
  const group = list => { const g = {}; for (const r of list) (g[r.strategyId] || (g[r.strategyId] = [])).push(r); return g; };
  const per = {};
  for (const [k, v] of Object.entries(group(rows))) per[k] = stats(v);
  const deadPer = {};
  for (const [k, v] of Object.entries(group(dead))) deadPer[k] = { count: v.length, avgFillPct: r3(v.reduce((a, r) => a + Number(r.actualFillPct || 0), 0) / v.length), symbols: v.map(r => r.symbol) };
  return Object.assign({ note: 'overshootPct = actual gross fill % - stop level % (negative = filled worse than the stop); maxOvershootPct = the worst. Death-like fills (sell priceImpact >= ' + DEATH_IMPACT_PCT + '% or fill <= ' + DEATH_FILL_PCT + '%: the pool died between two checks) are NOT in these stats: see routeDeath', since: since || null }, stats(rows),
    { countAll: all.length, byStrategy: per, routeDeath: { count: dead.length, note: 'stop exits that filled on a dead pool (~-100%); not a fill-engine overshoot', byStrategy: deadPer } });
}
module.exports = { isStop, isDeathLike, build, record, summary, stats, STOP_REASONS, DEATH_IMPACT_PCT, DEATH_FILL_PCT };
