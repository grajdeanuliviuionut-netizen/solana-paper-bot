// Entry confirmation (PR5, 16:52 RA/Liviu "loser-cut" spec).
//  - upTicks: the pair's price must have risen on N consecutive scans (scan-to-scan DEX Screener
//    priceUsd), e.g. upTicks 2 => p[t-2] < p[t-1] < p[t]. In memory only: after a restart a pair
//    needs N+1 scans of history before it can be entered.
//  - delayed confirmation: the first time a candidate passes everything it is parked; it is entered
//    only if, >= delaySec later, the fresh price is higher than at the signal (booked at that price).
const hist = new Map();    // pairAddress -> [{ price, at }]
const pending = new Map(); // mint -> { priceAt, at, pairAddress }

function record(pairs, now = Date.now()) {
  for (const p of pairs || []) {
    if (!p || !p.pairAddress || !(Number(p.priceUsd) > 0)) continue;
    const a = hist.get(p.pairAddress) || [];
    if (a.length && now - a[a.length - 1].at < 5000) a[a.length - 1] = { price: Number(p.priceUsd), at: now }; // same scan
    else a.push({ price: Number(p.priceUsd), at: now });
    while (a.length > 5) a.shift();
    hist.set(p.pairAddress, a);
  }
  if (hist.size > 5000) for (const [k, a] of hist) if (now - a[a.length - 1].at > 15 * 60000) hist.delete(k);
}

// { ok, why, prices }
function upTickCheck(pairAddress, n, now = Date.now(), maxGapMs = 5 * 60000) {
  if (!(n > 0)) return { ok: true };
  const a = hist.get(pairAddress) || [];
  if (a.length < n + 1) return { ok: false, why: `history ${a.length}/${n + 1} scans`, prices: a.map(x => x.price) };
  const last = a.slice(-(n + 1));
  if (now - last[0].at > maxGapMs * (n + 1)) return { ok: false, why: 'history-stale', prices: last.map(x => x.price) };
  for (let i = 1; i < last.length; i++) if (!(last[i].price > last[i - 1].price)) return { ok: false, why: 'not-rising', prices: last.map(x => x.price) };
  return { ok: true, prices: last.map(x => x.price) };
}

// Returns { state: 'parked'|'wait'|'ok'|'fail', ...}. Call with the fresh price each time the
// candidate gets this far; 'ok' => enter now at `price`.
function delayedCheck(mint, pairAddress, price, delaySec, now = Date.now(), maxAgeSec = 180) {
  const p = pending.get(mint);
  if (!p || now - p.at > maxAgeSec * 1000 || p.pairAddress !== pairAddress) {
    pending.set(mint, { priceAt: price, at: now, pairAddress });
    return { state: 'parked', priceAt: price };
  }
  const ageSec = (now - p.at) / 1000;
  if (ageSec < delaySec) return { state: 'wait', ageSec, priceAt: p.priceAt };
  pending.delete(mint);
  const chgPct = ((price - p.priceAt) / p.priceAt) * 100;
  return price > p.priceAt ? { state: 'ok', ageSec, priceAt: p.priceAt, chgPct } : { state: 'fail', ageSec, priceAt: p.priceAt, chgPct };
}

function pendingList() { return [...pending.entries()].map(([mint, p]) => ({ mint, ...p })); }
function reset() { hist.clear(); pending.clear(); }

module.exports = { record, upTickCheck, delayedCheck, pendingList, reset, _hist: hist, _pending: pending };
