// Slot availability for a signal that passed its strategy gates, and scan-line formatting of skips.

// Returns null when a slot is free, else { reason: 'slot-full skip'|'balance-stop', scope: 'global'|'strategy', open, max }.
// strat = null checks only the global cap.
function slotStatus(state, strat, config) {
  const open = state.openPositions || [];
  if (state.balance < config.fullStopBalance) return { reason: 'balance-stop', scope: 'global', open: open.length, max: config.maxOpen };
  if (open.length >= config.maxOpen) return { reason: 'slot-full skip', scope: 'global', open: open.length, max: config.maxOpen };
  if (strat) {
    const n = open.filter(p => p.strategyId === strat.id).length;
    const max = strat.maxOpen || config.maxOpen;
    if (n >= max) return { reason: 'slot-full skip', scope: 'strategy', open: n, max };
  }
  return null;
}

// e.g. "slot-full skip: momentum-entry:GTBx…pump(JEANPHIL) | tokenized-equity: aggressive-flow:TTWo…FbKo(TTWO)"
function formatSkips(list) {
  const byReason = {};
  for (const k of list) {
    const label = k.reason;
    const arr = (byReason[label] = byReason[label] || []);
    const item = `${k.strategyId}:${k.mint}${k.symbol ? '(' + k.symbol + ')' : ''}`;
    if (!arr.includes(item)) arr.push(item);
  }
  return Object.entries(byReason).map(([r, arr]) => `${r}: ${arr.slice(0, 6).join(', ')}${arr.length > 6 ? ` +${arr.length - 6} more` : ''}`).join(' | ');
}

module.exports = { slotStatus, formatSkips };
