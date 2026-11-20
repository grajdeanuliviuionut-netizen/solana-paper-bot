// Slot availability for a signal that passed its strategy gates, and scan-line formatting of skips.

// Returns null when a slot is free, else { reason: 'slot-full skip'|'balance-stop', scope: 'global'|'strategy'|'tier', open, max }.
// strat = null checks only the global cap. Per-strategy caps come from config.strategyOps (maxOpen,
// tierMaxOpen) when set, else strat.maxOpen.
// Paper equity = cash + cost basis still deployed in open positions. The full stop compares EQUITY
// (not cash) with fullStopBalance: with ~6 positions of 0.2 SOL open, cash alone dips under 2.5 SOL
// and blocked every new entry even though the account was nowhere near the stop.
function equityOf(state) {
  return (state.balance || 0) + (state.openPositions || []).reduce((a, p) => a + (p.sizeSol || 0) * (p.remainingFrac == null ? 1 : p.remainingFrac), 0);
}

function slotStatus(state, strat, config, tier = null) {
  const open = state.openPositions || [];
  if (equityOf(state) < config.fullStopBalance) return { reason: 'balance-stop', scope: 'global', open: open.length, max: config.maxOpen };
  // Cash must still cover a new position.
  if (state.balance < (strat && strat.sizeSol ? strat.sizeSol : 0.01) + 0.01) return { reason: 'balance-stop', scope: 'cash', open: open.length, max: config.maxOpen };
  if (open.length >= config.maxOpen) return { reason: 'slot-full skip', scope: 'global', open: open.length, max: config.maxOpen };
  if (strat) {
    const ops = (config.opsFor && config.opsFor(strat.id)) || {};
    const mine = open.filter(p => p.strategyId === strat.id);
    const max = ops.maxOpen || strat.maxOpen || config.maxOpen;
    if (mine.length >= max) return { reason: 'slot-full skip', scope: 'strategy', open: mine.length, max };
    const tmax = tier && ops.tierMaxOpen && ops.tierMaxOpen[tier];
    if (tmax) {
      const n = mine.filter(p => p.tier === tier).length;
      if (n >= tmax) return { reason: 'slot-full skip', scope: `tier ${tier}`, open: n, max: tmax };
    }
  }
  return null;
}

// Entry priority for free slots (lower = first): strategyOps priority, NCS tier priority.
function priorityOf(sig, config) {
  const ops = (config.opsFor && config.opsFor(sig.strategyId)) || {};
  const tp = sig.tier && ops.tierPriority && ops.tierPriority[sig.tier];
  return tp != null ? tp : (ops.priority != null ? ops.priority : 5);
}

// Order candidates by priority, interleaving strategies within the same priority so one strategy
// can't use up the per-tick rug-check budget.
function orderCandidates(candidates, config) {
  const groups = new Map();
  for (const c of candidates) {
    const p = priorityOf(c, config);
    if (!groups.has(p)) groups.set(p, {});
    const g = groups.get(p);
    (g[c.strategyId] = g[c.strategyId] || []).push(c);
  }
  const out = [];
  for (const p of [...groups.keys()].sort((a, b) => a - b)) {
    const queues = Object.values(groups.get(p));
    while (queues.some(q => q.length)) queues.forEach(q => { if (q.length) out.push(q.shift()); });
  }
  return out;
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

module.exports = { equityOf, slotStatus, priorityOf, orderCandidates, formatSkips };
