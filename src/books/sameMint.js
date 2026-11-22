// Cross-strategy same-mint guard (Liviu/RA 22 Nov, FIONA double holding). Paper only, read-only helper.
// No legacy strategy or book may open a mint that is already held anywhere: legacy state.openPositions or
// book state.books.open (a partly sold position still counts until it is fully closed and removed).
// Fail closed: a candidate without a mint is treated as held. Closed trades never block (they are no longer
// in either open list).
const REASON = 'sameMintHeld';

function openLists(state) {
  const legacy = (state && Array.isArray(state.openPositions)) ? state.openPositions : [];
  const books = (state && state.books && Array.isArray(state.books.open)) ? state.books.open : [];
  return legacy.map(p => ['legacy', p]).concat(books.map(p => ['book', p]));
}

// Returns null when the mint is free, else { reason, heldBy: [...] }.
function heldMint(state, cand) {
  const mint = cand && cand.mint ? String(cand.mint) : '';
  if (!mint) return { reason: REASON, failClosed: true, detail: 'candidate has no mint (fail closed)', heldBy: [] };
  const heldBy = [];
  for (const [kind, p] of openLists(state)) {
    if (!p) continue;
    if ((p.remainingFrac != null && p.remainingFrac <= 0) || p.closedAt) continue;   // fully closed, not a hold
    const same = (p.mint && String(p.mint) === mint) || (!p.mint && cand.pairAddress && p.pairAddress === cand.pairAddress);
    if (same) heldBy.push({ kind, strategyId: p.book || p.strategyId || null, positionId: p.id, symbol: p.symbol, entryTime: p.entryTime, sizeSol: p.sizeSol });
  }
  if (!heldBy.length) return null;
  return { reason: REASON, detail: 'mint already held by ' + heldBy.map(h => h.strategyId + (h.kind === 'legacy' ? ' (legacy)' : ' (book)')).join(', '), heldBy };
}

module.exports = { heldMint, REASON };
