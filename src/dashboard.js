function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/\"/g, '"')
    .replace(/'/g, '&#39;');
}

function solText(value) {
  const n = Number(value) || 0;
  return (n > 0 ? '+' : '') + n.toFixed(4);
}

function render(state, config) {
  const positions = state.openPositions || [];
  const trades = (state.trades || []).slice(0, 20);
  const activity = (state.activity || []).slice(0, 12);
  const wins = trades.filter(function (t) { return (t.pnlSol || 0) > 0.00005; }).length;
  const losses = trades.filter(function (t) { return (t.pnlSol || 0) < -0.00005; }).length;
  const locked = positions.reduce(function (sum, p) { return sum + (Number(p.sizeSol) || 0); }, 0);
  const balance = Number(state.balance) || 0;
  const start = Number(config.startingSol) || 4;
  const tickError = (activity.find(function (a) { return /error/i.test(a.msg || ''); }) || {}).msg || '';
  const scan = activity.find(function (a) { return /SCAN:|Scanned/i.test(a.msg || ''); });
  const scanned = scan ? ((String(scan.msg).match(/(\d+)/) || [])[1] || '-') : '-';
  const focus = positions[0];
  const seen = {};
  const tape = trades.filter(function (t) {
    if (!t.symbol || seen[t.symbol]) return false;
    seen[t.symbol] = true;
    return true;
  }).slice(0, 8);
  const mult = Number(state.sizeMult) || 1;
  const nextSize = Math.max(0.05, Math.min(balance * 0.08, 0.32) * mult);
  const pausedNames = (config.strategies || []).filter(function (s) {
    return s.paused || (state.pausedIds || []).indexOf(s.id) !== -1;
  }).map(function (s) { return s.name || s.id; });
  const board = (state.lab && state.lab.board) || [];
  const lines = (state.lab && state.lab.lines) || [];
  const labHtml = board.length
    ? board.map(function (row) {
      return '<li><span class="' + (row.pnl >= 0 ? 'win' : 'loss') + '">' + esc(row.id) + '</span><span class="mute">' + row.wins + '/' + row.n + ' ' + solText(row.pnl) + '</span></li>';
    }).join('')
    : (lines.length ? lines : ['lab waiting for a score']).map(function (line) {
      return '<li class="mute">' + esc(line) + '</li>';
    }).join('');
  const skipHtml = (state.skips || []).slice(0, 4).map(function (line) {
    return '<li class="mute">' + esc(line) + '</li>';
  }).join('') || '<li class="mute">no miss recorded this pass</li>';

  function liveLine(pos) {
    const entry = Number(pos.entryPrice) || 0;
    const now = Number(pos.lastPrice) || 0;
    if (!(entry > 0) || !(now > 0)) return '<p class="mute">waiting for the next price</p>';
    const pct = ((now - entry) / entry) * 100;
    const pnl = (Number(pos.sizeSol) || 0) * ((pct - 1.1) / 100);
    return '<p class="' + (pnl >= 0 ? 'win' : 'loss') + '">now ' + pct.toFixed(1) + '% \u00b7 ' + solText(pnl) + ' SOL after cost</p>';
  }

  const tapeHtml = tape.length
    ? tape.map(function (t) { return '<span class="' + ((t.pnlSol || 0) >= 0 ? 'win' : 'loss') + '">$' + esc(t.symbol) + ' ' + solText(t.pnlSol) + '</span>'; }).join('')
    : '<span class="mute">waiting for closes</span>';
  const chips = positions.slice(0, 4).map(function (p) {
    return '<div class="chip"><b>$' + esc(p.symbol) + '</b><span>' + esc(p.strategyName || '') + '</span></div>';
  }).join('') || '<p class="mute">no open names on the tape</p>';
  const tail = activity.map(function (a) {
    return '<p class="' + (/error/i.test(a.msg || '') ? 'loss' : '') + '"><span class="mute">' + esc(new Date(a.time).toLocaleTimeString()) + '</span> ' + esc(a.msg) + '</p>';
  }).join('') || '<p class="mute">log empty</p>';
  const closes = trades.slice(0, 8).map(function (t) {
    return '<li><div class="row"><b>$' + esc(t.symbol) + '</b><span class="' + ((t.pnlSol || 0) >= 0 ? 'win' : 'loss') + '">' + solText(t.pnlSol) + '</span></div><p class="mute">' + esc(new Date(t.closedAt).toLocaleTimeString()) + ' \u00b7 ' + esc(t.exitReason || '') + (t.strategyName || t.strategyId ? ' \u00b7 ' + esc(t.strategyName || t.strategyId) : '') + '</p></li>';
  }).join('') || '<li class="mute">no closes yet</li>';
  const openHtml = positions.length ? positions.map(function (p) {
    return '<h2>$' + esc(p.symbol) + '</h2><p>entry ' + esc(Number(p.entryPrice || 0).toFixed(6)) + '</p><p>size ' + esc(Number(p.sizeSol || 0).toFixed(3)) + ' SOL</p>' + liveLine(p) + '<p class="mute">' + esc(p.strategyName || '') + '</p>';
  }).join('') : '<p class="mute">nothing open</p>';
  const bar = Math.max(6, Math.min(100, (balance / start) * 100));
  const last = activity[0] ? new Date(activity[0].time).toLocaleTimeString() + ' \u00b7 ' + esc(activity[0].msg) : 'every trade gets a reason';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paper Terminal</title><meta http-equiv="refresh" content="12"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet"><style>' +
    'body{margin:0;background:#07080c;color:#e7f6ee;font-family:Outfit,system-ui,sans-serif}.wrap{max-width:1120px;margin:0 auto;padding:12px;display:grid;gap:12px}.mono{font-family:\"IBM Plex Mono\",ui-monospace,monospace}.mute{color:#7d8b96}.win{color:#3dff9a}.loss{color:#ff5d6c}.eq{color:#3ecbff}' +
    '.card{background:#0c0f16;border:1px solid #243041;border-radius:14px;padding:12px;min-width:0}.tape{display:flex;gap:12px;align-items:center;overflow:hidden;border-radius:999px;font-size:12px}.scroll{display:flex;gap:14px;overflow-x:auto;min-width:0;flex:1}' +
    '.pill{border:1px solid #2ee6a8;color:#2ee6a8;border-radius:999px;padding:4px 8px;white-space:nowrap}.off{border-color:#243041;color:#7d8b96}.head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:center}.brand{display:flex;gap:12px;align-items:center}' +
    '.mark{width:52px;height:52px;border-radius:50%;background:#e7f6ee;color:#07080c;display:grid;place-items:center;font-weight:700}h1{margin:0;font-size:26px}.event{display:inline-block;margin-top:8px;border:1px solid #2ee6a8;color:#2ee6a8;border-radius:6px;padding:4px 8px;font-size:12px}' +
    '.cash{font-size:30px;margin:0}.stats{display:flex;gap:18px}.stats b{display:block;font-size:26px}.layout{display:grid;grid-template-columns:250px 1fr;gap:12px;align-items:start}.agents{display:grid;gap:8px}.agent{border-radius:14px;padding:10px 12px;background:#0c0f16}' +
    '.agent header,.row,.flow li{display:flex;justify-content:space-between;gap:8px;align-items:center}.badge{border:1px solid currentColor;border-radius:6px;padding:1px 6px;font-size:11px}.a-scan{box-shadow:inset 0 0 0 1px #e6ff4d}.a-rug{box-shadow:inset 0 0 0 1px #ff4d6a}.a-size{box-shadow:inset 0 0 0 1px #c084fc}.a-exec{box-shadow:inset 0 0 0 1px #2ee6a8}.a-note{box-shadow:inset 0 0 0 1px #ffe14a}.a-eq{box-shadow:inset 0 0 0 1px #3ecbff}' +
    '.sub{display:block;color:#7d8b96;font-size:12px}.chips{display:flex;gap:8px;overflow-x:auto;margin-top:10px}.chip{min-width:120px;border:1px solid #c084fc;border-radius:10px;padding:8px}.chip span{display:block;color:#7d8b96;font-size:12px}' +
    '.nodes{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-top:10px}.node{border:1px solid currentColor;border-radius:10px;text-align:center;padding:8px}.line{height:1px;background:#2ee6a8}.minis,.split{display:grid;gap:8px;margin-top:12px}.minis{grid-template-columns:repeat(4,1fr)}.split{grid-template-columns:1.1fr .9fr}' +
    '.log{max-height:220px;overflow:auto;font-size:12px}.flow,.closes{list-style:none;padding:0;margin:8px 0 0}.bar{height:8px;background:#243041;border-radius:99px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:#2ee6a8;width:' + bar + '%}' +
    '.net{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin-top:12px}@media(max-width:800px){.layout,.split,.minis,.nodes{grid-template-columns:1fr}.line{display:none}}' +
    '</style></head><body><div class="wrap mono"><header class="tape card"><div class="scroll">' + tapeHtml + '</div><span class="pill">paper</span><span class="pill off">live locked</span></header>' +
    '<section class="head card"><div class="brand"><div class="mark">PT</div><div><h1>Paper Terminal <span class="mute" style="font-size:16px">multi-bot</span></h1><p class="mute">' + (tickError ? 'fault' : 'running') + ' \u00b7 open ' + positions.length + '/' + config.maxOpen + '</p><div class="event">' + last + '</div></div></div>' +
    '<div><p class="cash eq">' + balance.toFixed(4) + ' SOL</p><p class="mute">cash \u00b7 locked ' + locked.toFixed(2) + '</p></div><div class="stats"><div><b>' + trades.length + '</b><span class="mute">trades</span></div><div><b class="win">' + wins + '</b><span class="mute">wins</span></div><div><b class="loss">' + losses + '</b><span class="mute">losses</span></div></div></section>' +
    '<div class="layout"><aside class="agents"><p class="mute">AGENTS \u00b7 6 ONLINE</p>' +
    '<article class="agent a-scan"><header><b class="scan">SCANNER</b><span class="badge scan">SCAN</span></header><p>flags pairs, never trades</p><p class="sub">last pass ' + esc(scanned) + ' pairs</p></article>' +
    '<article class="agent a-rug"><header><b class="rug">RUG CHECK</b><span class="badge rug">' + (tickError ? 'HOLD' : 'PASS') + '</span></header><p>thin pools stay out</p><p class="sub">liquidity floor before a buy</p></article>' +
    '<article class="agent a-size"><header><b class="size">SIZER</b><span class="badge size">EQ</span></header><p>size comes from cash</p><p class="sub">next buy ' + nextSize.toFixed(3) + ' SOL' + (mult < 0.99 ? ' \u00b7 halved' : '') + '</p></article>' +
    '<article class="agent a-exec"><header><b class="exec">EXECUTOR</b><span class="badge exec">' + (positions.length ? 'LIVE' : 'IDLE') + '</span></header><p>opens and closes with a reason</p><p class="sub">' + (focus ? 'open ' + esc(focus.symbol) : 'no open ticket') + '</p></article>' +
    '<article class="agent a-note"><header><b class="note">LOGGER</b><span class="badge note">WRITE</span></header><p>no trade without a line</p><p class="sub">' + (activity[0] ? esc(activity[0].msg) : 'log empty') + '</p></article>' +
    '<article class="agent a-eq"><header><b class="eq">EQUITY</b><span class="badge eq">BOOK</span></header><p>cash plus locked size</p><p class="sub">' + (balance + locked).toFixed(4) + ' SOL</p></article></aside><section>' +
    '<div class="card"><div class="row mute"><span>LIVE PIPELINE</span><span>checked ' + esc(scanned) + '</span></div><div class="chips">' + chips + '</div></div>' +
    '<div class="split"><div class="card"><div class="row mute"><span>activity</span><span>' + activity.length + ' lines</span></div><div class="log">' + tail + '</div></div><div class="card"><div class="row mute"><span>TRADE</span><span class="pill">' + (focus ? 'OPEN' : 'FLAT') + '</span></div>' + openHtml + '</div></div>' +
    '<div class="split"><div class="card"><div class="row"><span class="mute">START ' + start.toFixed(2) + ' SOL</span><span class="eq">NOW ' + balance.toFixed(4) + '</span></div><div class="bar"><i></i></div><p class="mute">' + wins + ' W / ' + losses + ' L on the last ' + trades.length + '</p></div>' +
    '<div class="card"><div class="mute">LAB \u00b7 scored every scan</div><ul class="flow">' + labHtml + '</ul><p class="mute">paused: ' + esc(pausedNames.join(', ') || 'none') + '</p><p class="mute">why the last pass did not buy</p><ul class="flow">' + skipHtml + '</ul></div></div>' +
    '<div class="card" style="margin-top:12px"><p class="mute">LOG \u00b7 closes</p><ul class="closes">' + closes + '</ul></div></section></div></div></body></html>';
}

module.exports = { render };
