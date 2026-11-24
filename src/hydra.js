// t124u (Liviu 24 Nov): HYDRA orchestration API. Paper only.
// - POST /api/halt   -> operator pause: no new entries in ANY book (entry scanning stops), open positions keep
//                       being exited by the exit loop. Persisted in state.apiPause (survives restarts).
// - POST /api/resume (or POST /api/halt with {"paused": false}) -> entries resume.
// - Optional auth: when env HYDRA_TOKEN is set, halt/resume need header x-hydra-token equal to it.
// - GET /api/status  -> { status: 'online', equity, open_pnl, open_positions, paused, build }.
// Separate from the drawdown size cut (src/halt.js), which is unchanged.
const crypto = require('crypto');

function isPaused(state) { return !!(state && state.apiPause && state.apiPause.paused); }

function setPaused(state, paused, by, nowMs, meta) {
  const at = new Date(nowMs).toISOString();
  const prev = state.apiPause || {};
  const rec = { at, by: by || 'api', paused: !!paused };
  if (meta && meta.ip) rec.ip = String(meta.ip).slice(0, 64);
  state.apiPause = Object.assign({}, prev, { paused: !!paused, at, by: rec.by, changed: prev.paused !== !!paused,
    history: [rec].concat(prev.history || []).slice(0, 30) });
  return state.apiPause;
}

function view(state) {
  const p = (state && state.apiPause) || {};
  return { paused: !!p.paused, at: p.at || null, by: p.by || null, history: (p.history || []).slice(0, 5),
    howTo: 'POST /api/halt to pause new entries (exits keep running); POST /api/resume (or POST /api/halt {"paused": false}) to resume' + (process.env.HYDRA_TOKEN ? '; header x-hydra-token required' : '') };
}

// null = no HYDRA_TOKEN configured (open, as asked); true/false = header matches (constant time).
function tokenOk(given, env) {
  const want = env && env.HYDRA_TOKEN ? String(env.HYDRA_TOKEN) : '';
  if (!want) return null;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// CORS for /api/*: any origin, GET/POST/OPTIONS, Content-Type + x-hydra-token; OPTIONS preflight -> 204.
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-hydra-token');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// open_positions rows for GET /api/status. pnlPct = mark vs cost basis (Jupiter sell quote), priceMovePct =
// price move since entry (books with priceBasis entryQuote), null when not marked yet.
function statusPositions(positions) {
  const n = v => (v == null || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(3));
  return (positions || []).map(p => ({ book: p.book || p.strategyId || null, symbol: p.symbol || null, mint: p.mint || null, entryTime: p.entryTime || null,
    sizeSol: p.sizeSol == null ? null : +Number(p.sizeSol).toFixed(6), pnlPct: n(p.markPct), priceMovePct: n(p.movePct) }));
}

module.exports = { isPaused, setPaused, view, tokenOk, cors, statusPositions };
