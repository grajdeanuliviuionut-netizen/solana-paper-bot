// Per-mint entry guards shared by ALL strategies (outside every configHash):
//  - stop cooldown: no re-entry on a mint for config.mintGuard.stopCooldownMin after a stop-type exit
//  - daily cap: at most config.mintGuard.maxEntriesPerDay entries per mint per London day
//  - broken-quote denylist: a mint whose Jupiter quote was ever absurd (gap > brokenGapPct, no
//    reverse/sell route, NaN or zero output) is denied for good. Persisted in state.
// Seeded at startup from trades.jsonl / events.jsonl / shadow.jsonl so today's history counts.
const fs = require('fs');

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
function londonDay(ts) { return dayFmt.format(new Date(ts)); }

function ensure(state) {
  state.mintGuard = state.mintGuard || {};
  state.mintGuard.stops = state.mintGuard.stops || {};     // mint -> { until, reason, symbol, at, strategyId }
  state.mintGuard.entries = state.mintGuard.entries || {}; // londonDay -> { mint: count }
  state.brokenQuoteMints = state.brokenQuoteMints || {};   // mint -> { symbol, reason, at, source }
  return state.mintGuard;
}

function isStopReason(reason, cfg) { return (cfg.stopReasons || []).includes(String(reason)); }

function recordEntry(state, mint, ts = Date.now()) {
  const g = ensure(state);
  const day = londonDay(ts);
  g.entries[day] = g.entries[day] || {};
  g.entries[day][mint] = (g.entries[day][mint] || 0) + 1;
  for (const d of Object.keys(g.entries)) if (d < londonDay(ts - 2 * 86400000)) delete g.entries[d];
}

function recordExit(state, { mint, reason, symbol, strategyId }, cfg, ts = Date.now()) {
  if (!isStopReason(reason, cfg)) return false;
  const g = ensure(state);
  const until = ts + cfg.stopCooldownMin * 60000;
  if (!g.stops[mint] || g.stops[mint].until < until) g.stops[mint] = { until, reason, symbol, strategyId, at: new Date(ts).toISOString() };
  return true;
}

// null when the mint may be entered, else { reason: 'broken-quote-denylist'|'cooldown'|'mint-daily-cap', detail }.
function check(state, mint, cfg, now = Date.now()) {
  const g = ensure(state);
  const b = state.brokenQuoteMints[mint];
  if (b) return { reason: 'broken-quote-denylist', detail: `${b.symbol || ''} ${b.reason}`.trim() };
  const s = g.stops[mint];
  if (s && s.until > now) return { reason: 'cooldown', detail: `mint stop cooldown: ${s.reason} (${s.strategyId || ''}) until ${new Date(s.until).toISOString()}` };
  const n = (g.entries[londonDay(now)] || {})[mint] || 0;
  if (n >= cfg.maxEntriesPerDay) return { reason: 'mint-daily-cap', detail: `${n}/${cfg.maxEntriesPerDay} entries today (London)` };
  return null;
}

function addBroken(state, { mint, symbol, reason, source, at }) {
  ensure(state);
  if (!mint || state.brokenQuoteMints[mint]) return false;
  state.brokenQuoteMints[mint] = { symbol: symbol || null, reason: String(reason || 'broken-quote'), source: source || null, at: at || new Date().toISOString() };
  return true;
}

// Entry quote-sanity result -> broken reason or null.
function brokenFromEntrySanity({ gapPct, reasons, quotedPriceUsd }, cfg) {
  const rs = reasons || [];
  if (gapPct != null && Number.isFinite(gapPct) && Math.abs(gapPct) > cfg.brokenGapPct) return `gap ${gapPct.toFixed(1)}%>${cfg.brokenGapPct}%`;
  const hit = rs.find(r => /^(reverse-no-route|gap-uncomputable|roundtrip-no-proceeds)/.test(r));
  if (hit) return hit;
  if (quotedPriceUsd != null && !(Number(quotedPriceUsd) > 0)) return 'quote-zero-or-nan';
  return null;
}
// Exit quote-sanity result (checkExit) -> broken reason or null.
function brokenFromExitSanity({ gapPct, reasons }, cfg) {
  if ((reasons || []).includes('bad-price')) return 'exit-quote-bad-price';
  if (gapPct != null && Number.isFinite(gapPct) && Math.abs(gapPct) > cfg.brokenGapPct) return `exit gap ${gapPct.toFixed(1)}%>${cfg.brokenGapPct}%`;
  return null;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Rebuild today's entry counts and stop cooldowns from the trade log (+ open positions), and add any
// broken-quote mints found in trades / events / shadow history. Idempotent: entry counts are
// recomputed from the logs (source of truth), not added on top of the persisted counts.
function seed(state, { trades = [], events = [], shadowRows = [], openPositions = [] }, cfg, now = Date.now()) {
  const g = ensure(state);
  const today = londonDay(now);
  const counts = {};
  const seenIds = new Set();
  const countEntry = (id, mint, entryTime) => {
    if (!mint || !entryTime || (id && seenIds.has(id))) return;
    if (id) seenIds.add(id);
    if (londonDay(Date.parse(entryTime)) === today) counts[mint] = (counts[mint] || 0) + 1;
  };
  for (const t of trades) {
    countEntry(t.id, t.mint, t.entryTime);
    const closed = Date.parse(t.closedAt || t.exitTime);
    if (Number.isFinite(closed)) recordExit(state, { mint: t.mint, reason: t.exitReason, symbol: t.symbol, strategyId: t.strategyId }, cfg, closed);
    const bad = Math.abs(t.entryFillGapPct || 0) > cfg.brokenGapPct ? `entry gap ${Number(t.entryFillGapPct).toFixed(1)}%`
      : Math.abs(t.exitFillGapPct || 0) > cfg.brokenGapPct ? `exit gap ${Number(t.exitFillGapPct).toFixed(1)}%`
      : (t.entryShadow && t.entryShadow.ok && !(t.entryShadow.quotedPriceUsd > 0)) ? 'entry quote zero/NaN' : null;
    if (bad) addBroken(state, { mint: t.mint, symbol: t.symbol, reason: bad, source: 'trades.jsonl', at: t.entryTime });
  }
  for (const p of openPositions) countEntry(p.id, p.mint, p.entryTime);
  g.entries[today] = counts;
  for (const e of events) {
    let reason = null;
    if (e.type === 'exit-quote-insane') reason = brokenFromExitSanity({ gapPct: e.quotedPriceUsd > 0 && e.modelPriceUsd > 0 ? ((e.quotedPriceUsd - e.modelPriceUsd) / e.modelPriceUsd) * 100 : null, reasons: (e.reasons || []).concat(e.quotedPriceUsd != null && !(e.quotedPriceUsd > 0) ? ['bad-price'] : []) }, cfg);
    else if (e.type === 'exit-quote-failed' && e.source === 'jupiter' && e.noRoute) reason = 'sell no-route';
    else if (e.type === 'quote-sanity-reject' || e.type === 'broken-quote-denied') reason = e.brokenReason || brokenFromEntrySanity(e, cfg);
    if (reason) addBroken(state, { mint: e.mint, symbol: e.symbol, reason, source: 'events.jsonl', at: e.time });
  }
  for (const r of shadowRows) {
    if (r.type !== 'shadow-reject') continue;
    const reasons = String(r.detail || '').split(';').map(s => s.trim()).filter(Boolean);
    const reason = brokenFromEntrySanity({ gapPct: r.gapPct, reasons, quotedPriceUsd: r.quotedPriceUsd }, cfg) || (r.reverseOk === false ? 'reverse-failed' : null);
    if (reason) addBroken(state, { mint: r.mint, symbol: r.symbol, reason, source: 'shadow.jsonl', at: r.time });
  }
  for (const s of cfg.seedBrokenMints || []) addBroken(state, { ...s, source: 'config seed' });
  return summary(state, cfg, now);
}

function summary(state, cfg, now = Date.now()) {
  const g = ensure(state);
  const stops = Object.entries(g.stops).filter(([, s]) => s.until > now);
  const today = g.entries[londonDay(now)] || {};
  const capped = Object.entries(today).filter(([, n]) => n >= cfg.maxEntriesPerDay);
  return {
    rules: { stopCooldownMin: cfg.stopCooldownMin, stopReasons: cfg.stopReasons, maxEntriesPerDay: cfg.maxEntriesPerDay, day: londonDay(now), dayTimeZone: 'Europe/London', brokenGapPct: cfg.brokenGapPct },
    inCooldown: stops.map(([mint, s]) => ({ mint, symbol: s.symbol, reason: s.reason, strategyId: s.strategyId, until: new Date(s.until).toISOString() })),
    dailyCapped: capped.map(([mint, n]) => ({ mint, entries: n })),
    entriesToday: Object.keys(today).length,
    brokenQuoteMints: Object.entries(state.brokenQuoteMints).map(([mint, b]) => ({ mint, ...b }))
  };
}

module.exports = { londonDay, ensure, recordEntry, recordExit, check, addBroken, brokenFromEntrySanity, brokenFromExitSanity, seed, summary, readJsonl, isStopReason };
