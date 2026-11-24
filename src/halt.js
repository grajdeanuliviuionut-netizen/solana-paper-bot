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

// t118u (Liviu 24 Nov): default mode is 'size-cut' - the 24 h drawdown never freezes entries again. Past the limit,
// sizing is cut to sizeCutMult (0.5 -> 2.5% of equity instead of 5%) and trading continues; normal size returns as soon
// as the drawdown is back under the limit. halted stays false. opts.mode 'halt' keeps the old t89u hard halt.
function mode(opts) { return opts && opts.mode === 'halt' ? 'halt' : 'size-cut'; }
function sizeCutView(state, opts) {
  const sc = (state && state.sizeCut) || {};
  const mult = opts && opts.sizeCutMult > 0 && opts.sizeCutMult <= 1 ? opts.sizeCutMult : 0.5;
  return { mode: mode(opts), sizeCutActive: !!sc.active, sizeMultiplier: sc.active ? mult : 1, cutMultiplier: mult, drawdownPct: sc.dropPct == null ? null : sc.dropPct,
    limitPct: opts ? opts.dropPct : null, since: sc.active ? sc.since || null : null, lastChangeAt: sc.lastChangeAt || null, cuts: sc.cuts || 0, history: (sc.history || []).slice(0, 10) };
}
// Size multiplier for new entries (1 normally, cutMult while the size cut is active). Never touches open positions.
function sizeMultiplier(state) { const sc = state && state.sizeCut; return sc && sc.active && sc.mult > 0 && sc.mult <= 1 ? sc.mult : 1; }

// Evaluate the drawdown. size-cut mode: toggles state.sizeCut, never halts (and lifts a legacy halt).
// halt mode: sets the hard halt (never clears). Returns the evaluation.
function check(state, points, nowMs, opts) {
  const h = state.halt || null;
  const d = drawdown(points, nowMs, { windowHours: opts.windowHours, resumeFromMs: h && h.resumeFrom ? Date.parse(h.resumeFrom) : 0 });
  state.haltLastCheck = Object.assign({ at: new Date(nowMs).toISOString(), limitPct: opts.dropPct, windowHours: opts.windowHours, mode: mode(opts) }, d);
  if (mode(opts) === 'size-cut') {
    if (h && h.halted) clear(state, 'size-cut mode (t118u)', nowMs);
    const mult = opts.sizeCutMult > 0 && opts.sizeCutMult <= 1 ? opts.sizeCutMult : 0.5;
    const sc = state.sizeCut = Object.assign({ active: false, cuts: 0, history: [] }, state.sizeCut || {});
    if (!d.ok) return Object.assign({ triggered: false, sizeCut: null }, d);
    const at = new Date(nowMs).toISOString();
    sc.dropPct = d.dropPct; sc.checkedAt = at; sc.mult = mult;
    const over = d.dropPct >= opts.dropPct;
    let change = null;
    if (over && !sc.active) {
      Object.assign(sc, { active: true, since: at, lastChangeAt: at, cuts: (sc.cuts || 0) + 1 }); change = 'cut';
      sc.history = [{ at, action: 'cut', dropPct: d.dropPct, peak: d.peak, equity: d.equity, mult }].concat(sc.history || []).slice(0, 20);
    } else if (!over && sc.active) {
      Object.assign(sc, { active: false, since: null, lastChangeAt: at }); change = 'restore';
      sc.history = [{ at, action: 'restore', dropPct: d.dropPct, peak: d.peak, equity: d.equity, mult: 1 }].concat(sc.history || []).slice(0, 20);
    }
    return Object.assign({ triggered: false, sizeCut: change }, d);
  }
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

module.exports = { drawdown, check, clear, isHalted, tokenOk, mode, sizeCutView, sizeMultiplier };
