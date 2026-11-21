function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;')
    .replace(/'/g, '\u0026#39;');
}

function solText(value) {
  const n = Number(value) || 0;
  return (n > 0 ? '+' : '') + n.toFixed(4);
}

function render(state, config) {
  const positions = state.openPositions || [];
  const trades = (state.trades || []).slice(0, 20);
  const activity = (state.activity || []).slice(0, 12);
  const wins = trades.filter((t) => (t.pnlSol || 0) > 0.00005).length;
  const losses = trades.filter((t) => (t.pnlSol || 0) < -0.00005).length;
  const locked = positions.reduce((sum, p) => sum + (Number(p.sizeSol) || 0), 0);
  const balance = Number(state.balance) || 0;
  const start = Number(config.startingSol) || 4;
  const tickError = (activity.find((a) => /error/i.test(a.msg || '')) || {}).msg || '';
  const scan = activity.find((a) => /SCAN:|Scanned/i.test(a.msg || ''));
  const scanned = scan ? ((String(scan.msg).match(/(\d+)/) || [])[1] || '-') : '-';
  const focus = positions[0];
  const seen = new Set();
  const tape = trades.filter((t) => {
    if (!t.symbol || seen.has(t.symbol)) return false;
    seen.add(t.symbol);
    return true;
  }).slice(0, 8);

  const tapeHtml = tape.length
    ? tape.map((t) => '<span class="' + ((t.pnlSol || 0) >= 0 ? 'win' : 'loss') + '">$' + esc(t.symbol) + ' ' + solText(t.pnlSol) + '</span>').join('')
    : '<span class="mute">waiting for closes</span>';

  const chips = positions.slice(0, 4).map((p) => '<div class="chip"><b>$' + esc(p.symbol) + '</b><span>' + esc(p.strategyName || '') + '</span></div>').join('')
    || '<p class="mute">no open names on the tape</p>';

  const tail = activity.map((a) => '<p class="' + (/error/i.test(a.msg || '') ? 'loss' : '') + '"><span class="mute">' + esc(new Date(a.time).toLocaleTimeString()) + '</span> ' + esc(a.msg) + '</p>').join('')
    || '<p class="mute">log empty</p>';

  const closes = trades.slice(0, 8).map((t) => '<li><div class="row"><b>$' + esc(t.symbol) + '</b><span class="' + ((t.pnlSol || 0) >= 0 ? 'win' : 'loss') + '">' + solText(t.pnlSol) + '</span></div><p class="mute">' + esc(new Date(t.closedAt).toLocaleTimeString()) + ' \u00b7 ' + esc(t.exitReason || '') + '</p><p class="note">reason: ' + esc(t.strategyName || 'signal') + '</p></li>').join('')
    || '<li class="mute">no closes yet</li>';

  const flow = positions.slice(0, 4).map((p) => '<li><span class="eq">' + esc(p.symbol) + '</span><span class="mute">' + esc(p.sizeSol) + ' SOL in</span></li>').join('')
    || '<li class="mute">no open flow</li>';

  const bar = Math.max(6, Math.min(100, (balance / start) * 100));
  const last = activity[0]
    ? new Date(activity[0].time).toLocaleTimeString() + ' \u00b7 ' + esc(activity[0].msg)
    : 'every trade gets a reason';
  const focusBlock = focus
    ? '<h2>$' + esc(focus.symbol) + '</h2><p>entry ' + esc(Number(focus.entryPrice || 0).toFixed(6)) + '</p><p>size ' + esc(focus.sizeSol) + ' SOL</p><p class="mute">' + esc(focus.strategyName || '') + '</p><p class="note">reason: ' + esc(focus.entryReason || 'signal passed scan, check, and size') + '</p>'
    : '<p class="mute">nothing open</p>';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paper Terminal</title><meta http-equiv="refresh" content="12"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet"><style>' +
    'body{margin:0;background:#07080c;color:#e7f6ee;font-family:Outfit,system-ui,sans-serif}' +
    '.wrap{max-width:1120px;margin:0 auto;padding:12px;display:grid;gap:12px}' +
    '.mono{font-family:\"IBM Plex Mono\",ui-monospace,monospace}' +
    '.mute{color:#7d8b96}.win{color:#3dff9a}.loss{color:#ff5d6c}.eq{color:#3ecbff}.note{color:#ffe14a}.scan{color:#e6ff4d}.rug{color:#ff4d6a}.size{color:#c084fc}.exec{color:#2ee6a8}' +
    '.card{background:#0c0f16;border:1px solid #243041;border-radius:14px;padding:12px;min-width:0}' +
    '.tape{display:flex;gap:12px;align-items:center;overflow:hidden;border-radius:999px;font-size:12px}' +
    '.scroll{display:flex;gap:14px;overflow-x:auto;min-width:0;flex:1}' +
    '.pill{border:1px solid #2ee6a8;color:#2ee6a8;border-radius:999px;padding:4px 8px;white-space:nowrap}' +
    '.off{border-color:#243041;color:#7d8b96}' +
    '.head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:center}' +
    '.brand{display:flex;gap:12px;align-items:center}' +
    '.mark{width:52px;height:52px;border-radius:50%;background:#e7f6ee;color:#07080c;display:grid;place-items:center;font-weight:700}' +
    'h1{margin:0;font-size:26px}.event{display:inline-block;margin-top:8px;border:1px solid #2ee6a8;color:#2ee6a8;border-radius:6px;padding:4px 8px;font-size:12px}' +
    '.cash{font-size:30px;margin:0}.stats{display:flex;gap:18px}.stats b{display:block;font-size:26px}' +
    '.layout{display:grid;grid-template-columns:250px 1fr;gap:12px;align-items:start}' +
    '.agents{display:grid;gap:8px}.agent{border-radius:14px;padding:10px 12px;background:#0c0f16}' +
    '.agent header,.row,.flow li{display:flex;justify-content:space-between;gap:8px;align-items:center}' +
    '.badge{border:1px solid currentColor;border-radius:6px;padding:1px 6px;font-size:11px}' +
    '.a-scan{box-shadow:inset 0 0 0 1px #e6ff4d}.a-rug{box-shadow:inset 0 0 0 1px #ff4d6a}.a-size{box-shadow:inset 0 0 0 1px #c084fc}.a-exec{box-shadow:inset 0 0 0 1px #2ee6a8}.a-note{box-shadow:inset 0 0 0 1px #ffe14a}.a-eq{box-shadow:inset 0 0 0 1px #3ecbff}' +
    '.sub{display:block;color:#7d8b96;font-size:12px}' +
    '.chips{display:flex;gap:8px;overflow-x:auto;margin-top:10px}.chip{min-width:120px;border:1px solid #c084fc;border-radius:10px;padding:8px}.chip span{display:block;color:#7d8b96;font-size:12px}' +
    '.nodes{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-top:10px}.node{border:1px solid currentColor;border-radius:10px;text-align:center;padding:8px}.line{height:1px;background:#2ee6a8;align-self:center}' +
    '.minis,.split{display:grid;gap:8px;margin-top:12px}.minis{grid-template-columns:repeat(4,1fr)}.split{grid-template-columns:1.1fr .9fr}' +
    '.log{max-height:220px;overflow:auto;font-size:12px}.flow{list-style:none;padding:0;margin:10px 0 0}.closes{list-style:none;padding:0}' +
    '.bar{height:8px;background:#243041;border-radius:99px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:#2ee6a8;width:' + bar + '%}' +
    '.net{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin-top:12px}.alert{border-color:#ff5d6c;color:#ff5d6c}' +
    '@media(max-width:800px){.layout,.split,.minis,.nodes{grid-template-columns:1fr}.line{display:none}}' +
    '</style></head><body><div class="wrap mono">' +
    '<header class="tape card"><div class="scroll">' + tapeHtml + '</div><span class="pill">paper</span><span class="pill off">live locked</span></header>' +
    '<section class="head card"><div class="brand"><div class="mark">PT</div><div><h1>Paper Terminal <span class="mute" style="font-size:16px">multi-bot</span></h1><p class="mute">' + (tickError ? 'fault' : 'running') + ' \u00b7 open ' + positions.length + '/' + config.maxOpen + '</p><div class="event">' + last + '</div></div></div>' +
    '<div><p class="cash eq">' + balance.toFixed(4) + ' SOL</p><p class="mute">cash \u00b7 locked ' + locked.toFixed(2) + '</p></div>' +
    '<div class="stats"><div><b>' + trades.length + '</b><span class="mute">trades</span></div><div><b class="win">' + wins + '</b><span class="mute">wins</span></div><div><b class="loss">' + losses + '</b><span class="mute">losses</span></div></div></section>' +
    (tickError ? '<p class="card alert">exits blocked \u2014 ' + esc(tickError) + '</p>' : '') +
    '<div class="layout"><aside class="agents"><p class="mute">AGENTS \u00b7 6 ONLINE</p>' +
    '<article class="agent a-scan"><header><b class="scan">SCANNER</b><span class="badge scan">SCAN</span></header><p>flags pairs, never trades</p><p class="sub">last pass ' + esc(scanned) + ' pairs</p></article>' +
    '<article class="agent a-rug"><header><b class="rug">RUG CHECK</b><span class="badge rug">' + (tickError ? 'HOLD' : 'PASS') + '</span></header><p>thin pools stay out</p><p class="sub">liquidity floor before a buy</p></article>' +
    '<article class="agent a-size"><header><b class="size">SIZER</b><span class="badge size">EQ</span></header><p>size comes from cash</p><p class="sub">cap 0.32 SOL</p></article>' +
    '<article class="agent a-exec"><header><b class="exec">EXECUTOR</b><span class="badge exec">' + (positions.length ? 'LIVE' : 'IDLE') + '</span></header><p>opens and closes with a reason</p><p class="sub">' + (focus ? 'open ' + esc(focus.symbol) : 'no open ticket') + '</p></article>' +
    '<article class="agent a-note"><header><b class="note">LOGGER</b><span class="badge note">WRITE</span></header><p>no trade without a line</p><p class="sub">' + (activity[0] ? esc(activity[0].msg) : 'log empty') + '</p></article>' +
    '<article class="agent a-eq"><header><b class="eq">EQUITY</b><span class="badge eq">BOOK</span></header><p>cash plus locked size</p><p class="sub">' + (balance + locked).toFixed(4) + ' SOL</p></article></aside><section>' +
    '<div class="card"><div class="row mute"><span>LIVE PIPELINE \u00b7 SCAN \u2192 CHECK \u2192 SIZE \u2192 EXEC \u2192 LOG</span><span>checked ' + esc(scanned) + '</span></div><div class="chips">' + chips + '</div><div class="nodes"><div class="node rug"><div>RUG CHECK</div><b>' + (tickError ? 'blocked' : 'gate open') + '</b></div><div class="line"></div><div class="node exec"><div>EXECUTOR</div><b>' + (focus ? 'live $' + esc(focus.symbol) : 'idle') + '</b></div></div></div>' +
    '<div class="minis"><div class="card"><div class="rug">FILTERED</div><b>' + (tickError ? 'exits stuck' : 'clear') + '</b></div><div class="card"><div class="note">LOGGER</div><b>' + activity.length + ' lines</b></div><div class="card"><div class="size">SIZER</div><b>from cash</b></div><div class="card"><div class="eq">EQUITY</div><b>' + solText(balance - start) + '</b></div></div>' +
    '<div class="split"><div class="card"><div class="row mute"><span>activity</span><span>' + activity.length + ' lines</span></div><div class="log">' + tail + '</div></div><div class="card"><div class="row mute"><span>TRADE</span><span class="pill">' + (focus ? 'OPEN' : 'FLAT') + '</span></div>' + focusBlock + '</div></div>' +
    '<div class="split"><div class="card"><div class="row"><span class="mute">START ' + start.toFixed(2) + ' SOL</span><span class="eq">NOW ' + balance.toFixed(4) + '</span></div><div class="bar"><i></i></div><p class="mute">' + wins + ' W / ' + losses + ' L on the last ' + trades.length + ' \u00b7 locked ' + locked.toFixed(2) + ' SOL</p></div><div class="card"><div class="mute">FLOW</div><p>Wallet radar is off. This feed does not see holder wallets.</p><ul class="flow">' + flow + '</ul></div></div>' +
    '<div class="card net"><b class="loss">NETWORK</b><span>pairs ' + esc(scanned) + '</span><span>paper only</span></div>' +
    '<div class="card" style="margin-top:12px"><p class="mute">LOG \u00b7 closes, with the exit reason</p><ul class="closes">' + closes + '</ul></div>' +
    '</section></div></div></body></html>';
}

module.exports = { render };
