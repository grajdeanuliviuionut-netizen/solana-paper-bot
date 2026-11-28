// Backtest of the route-death exit on closed social-spike trades from GET /api/books (read-only; paper data only).
// usage: node scripts/route-death-backtest.js [books.json | https://.../api/books]   (default: the production URL)
// Per total-loss trade: last good quote before death, seconds between it and the first sign of death, the 10 min
// no-route wait it would have skipped, and the UPPER-BOUND SOL a "credit the last good quote" what-if would have booked.
const fs = require('fs');
const URL = 'https://solana-paper-bot-production.up.railway.app/api/books';
const SLIP = 0.98;                       // paper sell slip (2%)
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const f = (v, d) => v == null ? '-' : Number(v).toFixed(d == null ? 4 : d);

async function load(src) {
  if (src && fs.existsSync(src)) return JSON.parse(fs.readFileSync(src, 'utf8'));
  const res = await fetch(src || URL); return res.json();
}
function analyse(books, opts) {
  opts = opts || {};
  const maxAge = opts.maxAgeSec || 10;
  const rows = [];
  for (const t of (books.trades || []).filter(x => x.book === 'social-spike').sort((a, b) => a.entryTime < b.entryTime ? -1 : 1)) {
    const last = t.legs[t.legs.length - 1];
    const noRoute = last.reason === 'no-route-total-loss';
    const slDeath = last.reason === 'sl' && t.stopFill && (num(t.stopFill.priceImpactPct) >= 50 || num(t.stopFill.actualFillPct) <= -90);
    if (!noRoute && !slDeath) continue;
    const lastGoodAt = noRoute ? Date.parse(t.markAt) : Date.parse(t.stopFill.lastCheckBefore.at);
    const lastGoodPct = noRoute ? num(t.markPct) : num(t.stopFill.lastCheckBefore.pnlPct);
    const firstSignAt = noRoute ? Date.parse(t.noRouteSince) : Date.parse(t.stopFill.at);
    const blindSec = (firstSignAt - lastGoodAt) / 1000;                 // no information at all in this window
    const waitedSec = noRoute ? (Date.parse(t.closedAt) - firstSignAt) / 1000 : 0;   // 10 min timer skipped
    const basis = num(last.basisSol);
    const creditPnl = basis * (1 + lastGoodPct / 100) * SLIP - basis - num(last.costSol);
    const upper = creditPnl - num(last.pnlSol);                       // SOL the credit what-if adds vs the booked total loss
    rows.push({ symbol: t.symbol, entry: t.entryTime, kind: noRoute ? 'no-route' : 'sl@-100%', lastGoodPct, lastGoodImpact: noRoute && t.lastQuote ? num(t.lastQuote.priceImpactPct) : null,
      blindSec, waitedSec, quoteAgeAtFirstSign: blindSec, basis, bookedLegPnl: num(last.pnlSol), tradePnl: num(t.pnlSol), upper,
      creditableN1: blindSec <= maxAge, creditableN2: blindSec + 5 + 4 <= maxAge, partialFirst: t.legs.length > 1 });
  }
  const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
  const tot = { trades: rows.length, bookedLossSol: sum(rows, 'bookedLegPnl'), upperBoundSavedSol: sum(rows, 'upper'),
    upperBoundCreditableN1: rows.filter(r => r.creditableN1).reduce((s, r) => s + r.upper, 0), upperBoundCreditableN2: rows.filter(r => r.creditableN2).reduce((s, r) => s + r.upper, 0),
    zeroWarning: rows.filter(r => r.lastGoodImpact == null || r.lastGoodImpact < 20).length, noRouteWaitSkippedMin: sum(rows, 'waitedSec') / 60 };
  return { rows, tot };
}
function markdown(a) {
  const L = ['| # | coin | kind | last good mark % | last good impact % | s from last good quote to first sign | 10-min wait skipped (s) | booked loss SOL | upper-bound credit SOL (N=1) |', '|---|---|---|---|---|---|---|---|---|'];
  a.rows.forEach((r, i) => L.push('| ' + (i + 1) + ' | ' + r.symbol + ' ' + r.entry.slice(5, 16) + ' | ' + r.kind + (r.partialFirst ? ' (after +25% half)' : '') + ' | ' + f(r.lastGoodPct, 1) + ' | ' + f(r.lastGoodImpact, 2) + ' | ' + f(r.blindSec, 1) + ' | ' + f(r.waitedSec, 0) + ' | ' + f(r.bookedLegPnl) + ' | ' + f(r.upper) + ' |'));
  return L.join('\n') + '\n\n' + JSON.stringify(a.tot, null, 1);
}
module.exports = { analyse, markdown };
if (require.main === module) load(process.argv[2]).then(b => console.log(markdown(analyse(b)))).catch(e => { console.error(e.message); process.exit(1); });
