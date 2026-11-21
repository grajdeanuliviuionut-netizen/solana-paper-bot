// Scores closed trades every tick. Liviu's rule: never pause a strategy for losing; cut its size
// instead. A strategy that is net negative after enough trades trades at half size (per strategy),
// and the whole book halves after 5 losses in a row. Size never goes below config.minPositionSol.
// Only strategies marked paused:true in config.js stay paused (set by hand, not by results).
function review(state, config) {
  const notes = [];
  const stats = {};
  // PR11: trades archived at the scoreboard reset (state.managerHistory) still count here, so the
  // reset never restores a legacy strategy's cut size. Book trades live in state.books (not scored here).
  for (const t of (state.trades || []).concat(state.managerHistory || [])) {
    const id = t.strategyId || 'unknown';
    if (!stats[id]) stats[id] = { n: 0, pnl: 0, wins: 0 };
    const row = stats[id];
    row.n += 1;
    row.pnl += Number(t.pnlSol) || 0;
    if ((Number(t.pnlSol) || 0) > 0) row.wins += 1;
  }

  const minTrades = config.pauseAfterTrades || 8;
  const configPaused = (config.strategies || []).filter(s => s.paused).map(s => s.id);
  const before = Array.isArray(state.pausedIds) ? state.pausedIds.slice() : [];
  // Drop results-based pauses (e.g. dip-hold auto-paused at 13:33); keep the hand-set config pauses.
  for (const id of before) {
    const strat = (config.strategies || []).find(s => s.id === id);
    if (strat && !strat.paused) notes.push('MANAGER unpause ' + id + ': strategies are never paused for results, size is cut instead');
  }
  for (const id of configPaused) if (!before.includes(id)) notes.push('MANAGER pause ' + id + ': paused in config');
  state.pausedIds = configPaused;

  if (!state.stratSizeMult || typeof state.stratSizeMult !== 'object') state.stratSizeMult = {};
  for (const strat of config.strategies || []) {
    const row = stats[strat.id];
    const losing = !!(row && row.n >= minTrades && row.pnl < 0);
    const cfgMult = Number(strat.sizeMult) > 0 ? Number(strat.sizeMult) : 1;
    // Effective per-strategy size multiplier: the results cut (0.5) or the config sizeMult, whichever is
    // lower (they do not stack). E.g. dip-buyers: config sizeMult 0.5 -> 0.5 even without a losing record.
    const mult = Math.min(losing ? 0.5 : 1, cfgMult);
    const prev = state.stratSizeMult[strat.id] || 1;
    if (mult !== prev && !strat.paused) {
      notes.push(mult < 1
        ? 'MANAGER size x' + mult + ' for ' + strat.id + ': ' + (losing && cfgMult >= 0.5 ? row.n + ' trades, pnl ' + row.pnl.toFixed(4) + ' SOL, win ' + Math.round((100 * row.wins) / row.n) + '%' : 'config sizeMult ' + cfgMult)
        : 'MANAGER size restored for ' + strat.id);
    }
    state.stratSizeMult[strat.id] = mult;
  }

  let streak = 0;
  for (const t of state.trades || []) {
    if ((Number(t.pnlSol) || 0) < 0) streak += 1;
    else break;
  }
  const sizeMult = streak >= 5 ? 0.5 : 1;
  if (sizeMult !== (state.sizeMult || 1)) {
    notes.push(sizeMult < 1
      ? 'MANAGER size halved: ' + streak + ' losses in a row'
      : 'MANAGER size restored after a win');
  }
  state.sizeMult = sizeMult;
  state.lossStreak = streak;
  state.strategyStats = stats;
  return { notes, pausedIds: state.pausedIds, sizeMult, stratSizeMult: state.stratSizeMult };
}

// Position size for a strategy: sizer base x book multiplier x strategy multiplier, floored.
function sizeFor(base, state, config, strategyId) {
  const floor = Number(config.minPositionSol) > 0 ? Number(config.minPositionSol) : 0.02;
  const cut = (state.stratSizeMult && state.stratSizeMult[strategyId]) || 1;
  const def = (config.strategies || []).find(s => s.id === strategyId);
  const cfg = def && Number(def.sizeMult) > 0 ? Number(def.sizeMult) : 1;
  const strat = Math.min(cut, cfg); // half size from config and the manager cut do not stack
  return Math.max(floor, base * (state.sizeMult || 1) * strat);
}

module.exports = { review, sizeFor };
