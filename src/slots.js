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

// Global open cap: the raised allocator cap when cash covers filling it at the largest strategy size
// plus a cash buffer, else the base cap.
function maxSizeSol(config) {
  return Math.max(config.positionSizeSol || 0.2, ...(config.strategies || []).map(s => s.sizeSol || 0));
}
function maxOpenFor(state, config) {
  const a = config.allocator;
  if (!a) return config.maxOpen;
  const open = (state.openPositions || []).length;
  const need = Math.max(0, a.targetMaxOpen - open) * maxSizeSol(config) + a.cashBufferSol;
  return (state.balance || 0) >= need ? a.targetMaxOpen : a.baseMaxOpen;
}
// Slots still held back for reserved strategies other than `stratId`.
function reservedFor(state, config, stratId) {
  const r = (config.allocator && config.allocator.reserve) || {};
  const open = state.openPositions || [];
  return Object.entries(r).reduce((a, [id, n]) => id === stratId ? a : a + Math.max(0, n - open.filter(p => p.strategyId === id).length), 0);
}

function slotStatus(state, strat, config, tier = null) {
  const open = state.openPositions || [];
  const maxOpen = maxOpenFor(state, config);
  if (equityOf(state) < config.fullStopBalance) return { reason: 'balance-stop', scope: 'global', open: open.length, max: maxOpen };
  // Cash must still cover a new position.
  if (state.balance < (strat && strat.sizeSol ? strat.sizeSol : 0.01) + 0.01) return { reason: 'balance-stop', scope: 'cash', open: open.length, max: maxOpen };
  if (open.length >= maxOpen) return { reason: 'slot-full skip', scope: 'global', open: open.length, max: maxOpen };
  if (strat) {
    const held = reservedFor(state, config, strat.id);
    if (held && open.length + 1 + held > maxOpen) return { reason: 'slot-full skip', scope: 'reserved', open: open.length, max: maxOpen - held };
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

// Weakest bumpable position: a victim strategy, paper only, past its entry grace; lowest judged net %
// (sell quote, else mid vs entry fill).
function weakness(p) {
  if (p.lastJudge && Number.isFinite(p.lastJudge.netPct)) return p.lastJudge.netPct;
  return p.entryFillPrice > 0 && p.lastPrice > 0 ? (p.lastPrice / p.entryFillPrice - 1) * 100 : 0;
}
function pickBumpVictim(state, config, forStratId, now = Date.now()) {
  const b = config.allocator && config.allocator.bump;
  if (!b || !b.for.includes(forStratId)) return null;
  const minAgeMs = (b.minAgeSec || 0) * 1000;
  const c = (state.openPositions || []).filter(p => b.victims.includes(p.strategyId) && !p.live && !p.bumping
    && now - Date.parse(p.entryTime) >= minAgeMs);
  if (!c.length) return null;
  return c.sort((x, y) => weakness(x) - weakness(y))[0];
}

module.exports = { maxOpenFor, reservedFor, pickBumpVictim, weakness, equityOf, slotStatus, priorityOf, orderCandidates, formatSkips };
