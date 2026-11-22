// t89u (Liviu 22 Nov 13:18): Manager hard halt. If portfolio equity (marked: cash + Jupiter-marked open
// positions) drops >= dropPct (5%) from its highest point within any rolling windowHours (24 h), ALL new
// trading stops: state.halt.halted = true, persisted in state.json (survives restarts), never auto-cleared.
// Open positions keep exiting. The window uses the full equity.jsonl history (1 snapshot/min, every epoch),
// so a new scoreboard epoch cannot reset it. After a manual restart (clear) the window restarts at the clear
// time (halt.resumeFrom), otherwise the same old peak would re-halt at once.
// Manual restart: POST /api/admin/halt/clear with header x-admin-token = ADMIN_TOKEN or KILL_TOKEN env
// (>= 16 chars, constant-time compare), or set env HALT_CLEAR_ID=<state.halt.id> and redeploy (cleared once at boot).

// points: [{ t: iso, markEquity|equity }]; returns the drawdown inside [now - window, now].
function drawdown(points, nowMs, opts) {
  const win = (opts.windowHours || 24) * 3600000;
  const from = Math.max(nowMs - win, opts.resumeFromMs || 0);
  let peak = null, peakAt = null, cur = null, curAt = null;
  for (const p of points || []) {
    const t = Date.parse(p.t);
    const v = Number(p.markEquity != null ? p.markEquity : p.equity);
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < from || t > nowMs + 60000) continue;
    if (peak == null || v > peak) { peak = v; peakAt = p.t; }
    if (curAt == null || t >= Date.parse(curAt)) { cur = v; curAt = p.t; }
  }
  if (peak == null || cur == null || !(peak > 0)) return { ok: false, points: 0 };
  const dropPct = ((peak - cur) / peak) * 100;
  return { ok: true, windowFrom: new Date(from).toISOString(), peak: +peak.toFixed(6), peakAt, equity: +cur.toFixed(6), equityAt: curAt, dropPct: +dropPct.toFixed(3) };
}

// Evaluate and (maybe) set the halt. Returns the evaluation. Never clears.
function check(state, points, nowMs, opts) {
  const h = state.halt || null;
  const d = drawdown(points, nowMs, { windowHours: opts.windowHours, resumeFromMs: h && h.resumeFrom ? Date.parse(h.resumeFrom) : 0 });
  state.haltLastCheck = Object.assign({ at: new Date(nowMs).toISOString(), limitPct: opts.dropPct, windowHours: opts.windowHours }, d);
  if (d.ok && d.dropPct >= opts.dropPct && !(h && h.halted)) {
    state.halt = Object.assign({}, h || {}, { halted: true, id: 'halt-' + nowMs.toString(36), at: new Date(nowMs).toISOString(), reason: 'equity -' + d.dropPct.toFixed(2) + '% within ' + opts.windowHours + ' h (limit ' + opts.dropPct + '%)',
      peak: d.peak, peakAt: d.peakAt, equity: d.equity, dropPct: d.dropPct, windowFrom: d.windowFrom, clearHow: 'POST /api/admin/halt/clear with header x-admin-token (ADMIN_TOKEN or KILL_TOKEN), or env HALT_CLEAR_ID=<id> + redeploy' });
    state.haltHistory = [state.halt].concat(state.haltHistory || []).slice(0, 20);
    return Object.assign({ triggered: true }, d);
  }
  return Object.assign({ triggered: false }, d);
}

function clear(state, by, nowMs) {
  if (!state.halt || !state.halt.halted) return false;
  state.halt = Object.assign({}, state.halt, { halted: false, clearedAt: new Date(nowMs).toISOString(), clearedBy: by, resumeFrom: new Date(nowMs).toISOString() });
  state.haltHistory = [state.halt].concat((state.haltHistory || []).slice(1)).slice(0, 20);
  return true;
}

function isHalted(state) { return !!(state && state.halt && state.halt.halted); }

// Constant-time token check; null when no admin token is configured.
function tokenOk(given, env) {
  const crypto = require('crypto');
  const want = (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16) ? env.ADMIN_TOKEN : (env.KILL_TOKEN && env.KILL_TOKEN.length >= 16 ? env.KILL_TOKEN : null);
  if (!want) return null;
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { drawdown, check, clear, isHalted, tokenOk };
