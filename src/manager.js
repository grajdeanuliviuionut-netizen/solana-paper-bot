// Scores closed trades every tick. Pauses a strategy that is negative after
// enough trades, and halves size after 5 losses in a row. Never raises risk.
function review(state, config) {
  const notes = [];
  const stats = {};
  for (const t of state.trades || []) {
    const id = t.strategyId || 'unknown';
    if (!stats[id]) stats[id] = { n: 0, pnl: 0, wins: 0 };
    const row = stats[id];
    row.n += 1;
    row.pnl += Number(t.pnlSol) || 0;
    if ((Number(t.pnlSol) || 0) > 0) row.wins += 1;
  }

  if (!Array.isArray(state.pausedIds)) state.pausedIds = [];
  const minTrades = config.pauseAfterTrades || 8;

  for (const strat of config.strategies || []) {
    if (strat.paused && !state.pausedIds.includes(strat.id)) {
      state.pausedIds.push(strat.id);
      notes.push('MANAGER pause ' + strat.id + ': flow scalps are the losing book');
    }
  }

  for (const [id, row] of Object.entries(stats)) {
    if (row.n >= minTrades && row.pnl < 0 && !state.pausedIds.includes(id)) {
      state.pausedIds.push(id);
      const win = Math.round((100 * row.wins) / row.n);
      notes.push('MANAGER pause ' + id + ': ' + row.n + ' trades, pnl ' + row.pnl.toFixed(4) + ' SOL, win ' + win + '%');
    }
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
  return { notes, pausedIds: state.pausedIds, sizeMult };
}

module.exports = { review };
