// Per-coin re-entry cooldown: after ANY exit on a token, no new entry on that same token for
// config.reentryCooldownMin (45) minutes, for every strategy. Keyed by token mint and by pool
// (pair) address, never by ticker (tickers are reused by unrelated tokens).
function minutes(config) {
  const m = Number(config && config.reentryCooldownMin);
  return Number.isFinite(m) && m > 0 ? m : 45;
}
function keysFor(x) {
  const keys = [];
  if (x && x.mint) keys.push('mint:' + x.mint);
  if (x && x.pairAddress) keys.push('pair:' + x.pairAddress);
  return keys;
}
function ensure(state) {
  if (!state.reentryCooldowns || typeof state.reentryCooldowns !== 'object') state.reentryCooldowns = {};
  return state.reentryCooldowns;
}
function recordExit(state, pos, config, at) {
  const map = ensure(state);
  const t = at == null ? Date.now() : at;
  const until = t + minutes(config) * 60000;
  for (const k of keysFor(pos)) if (!map[k] || map[k].until < until) map[k] = { until, symbol: pos.symbol || '', reason: pos.exitReason || '' };
}
function blocked(state, sig, now) {
  const map = ensure(state);
  const t = now == null ? Date.now() : now;
  for (const k of keysFor(sig)) if (map[k] && map[k].until > t) return { key: k, until: map[k].until, minsLeft: Math.ceil((map[k].until - t) / 60000) };
  return null;
}
function prune(state, now) {
  const map = ensure(state);
  const t = now == null ? Date.now() : now;
  for (const k of Object.keys(map)) if (!(map[k] && map[k].until > t)) delete map[k];
}
// Rebuild from closed trades (state.trades) so a restart keeps the cooldowns.
function seed(state, config, now) {
  const t = now == null ? Date.now() : now;
  for (const tr of state.trades || []) {
    const at = new Date(tr.closedAt).getTime();
    if (Number.isFinite(at) && at + minutes(config) * 60000 > t) recordExit(state, tr, config, at);
  }
  prune(state, t);
  return Object.keys(ensure(state)).length;
}
module.exports = { recordExit, blocked, prune, seed, keysFor, minutes };
