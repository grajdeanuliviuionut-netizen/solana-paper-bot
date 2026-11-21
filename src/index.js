const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade } = require('./logger');
const { scan } = require('./agents/scanner');
const { rugCheck } = require('./agents/rugCheck');
const { sizePosition } = require('./agents/sizer');
const { executeEntry } = require('./agents/executor');
const { logDecision } = require('./agents/logger');
const { generateSignals } = require('./buyAgent');
const sellAgent = require('./sellAgent');

const shouldExit = sellAgent.shouldExit;
const computePnl = sellAgent.computePnl || function(pos, exitPrice) {
  const gross = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const net = gross - (config.costRoundtripPct || 1.1) / 100;
  return net * pos.sizeSol;
};

let state = loadState();
if (!state || typeof state !== 'object') state = {};
if (!Array.isArray(state.activity)) state.activity = [];
if (!Array.isArray(state.openPositions)) state.openPositions = [];
if (!Array.isArray(state.trades)) state.trades = [];
if (typeof state.balance !== 'number') state.balance = config.startingSol;
if (!Array.isArray(state.decisions)) state.decisions = [];

const app = express();

function addActivity(msg) {
  state.activity.unshift({ time: new Date().toISOString(), msg });
  if (state.activity.length > 50) state.activity.pop();
}

function canOpen() {
  if (state.balance < config.fullStopBalance) return false;
  if (state.openPositions.length >= config.maxOpen) return false;
  return true;
}

async function tick() {
  try {
    const pairs = await scan();
    addActivity(`SCAN: ${pairs.length} pairs`);

    const byAddr = {};
    for (const p of pairs) {
      if (p && p.pairAddress) byAddr[p.pairAddress] = p;
    }

    const stillOpen = [];
    for (const pos of state.openPositions) {
      const pair = byAddr[pos.pairAddress];
      const price = pair ? pair.priceUsd : pos.entryPrice;
      if (price > (pos.highest || 0)) pos.highest = price;
      const exit = shouldExit(pos, price);
      if (exit) {
        const pnl = computePnl(pos, exit.fillPrice);
        state.balance += pos.sizeSol + pnl;
        const trade = { ...pos, exitReason: exit.reason, exitPrice: exit.fillPrice, pnlSol: pnl, closedAt: new Date().toISOString() };
        state.trades.unshift(trade);
        if (state.trades.length > 100) state.trades.pop();
        logTrade(trade);
        const dec = logDecision('EXIT', pos.symbol, exit.reason, { pnl: pnl.toFixed(4) });
        state.decisions.unshift(dec);
        addActivity(`EXIT ${pos.symbol} ${exit.reason} pnl=${pnl.toFixed(4)}`);
      } else {
        stillOpen.push(pos);
      }
    }
    state.openPositions = stillOpen;

    if (canOpen()) {
      const result = generateSignals(pairs) || { signals: [], rejections: [] };
      for (const sig of (result.signals || []).slice(0, 3)) {
        if (!canOpen()) break;
        const already = state.openPositions.some(p => p.symbol === sig.symbol);
        if (already) continue;

        const check = rugCheck(sig.pair || pairs.find(p => p.pairAddress === sig.pairAddress));
        if (!check.pass) {
          const dec = logDecision('SKIP', sig.symbol, `rug check: ${check.reason}`);
          state.decisions.unshift(dec);
          continue;
        }

        const size = sizePosition(state.balance);

        const exec = executeEntry(sig, size, state.balance);
        if (exec.ok) {
          state.openPositions.push(exec.position);
          state.balance -= size;
          const dec = logDecision('ENTRY', sig.symbol, exec.reason, { size });
          state.decisions.unshift(dec);
          addActivity(`ENTRY ${sig.symbol} size ${size.toFixed(3)}`);
        }
      }
    }

    if (state.decisions.length > 100) state.decisions = state.decisions.slice(0, 100);
  } catch (e) {
    addActivity(`Tick error: ${e.message}`);
    console.error(e);
  }
  saveState(state);
}

app.get('/', (req, res) => {
  const open = (state.openPositions || []).map(p => `
    <tr>
      <td>${p.symbol || ''}</td>
      <td>${p.strategyName || ''}</td>
      <td>${(p.entryPrice || 0).toFixed(6)}</td>
      <td>${p.sizeSol || 0}</td>
      <td>${new Date(p.entryTime).toLocaleTimeString()}</td>
    </tr>`).join('');

  const closed = (state.trades || []).slice(0, 20).map(t => `
    <tr class="${(t.pnlSol || 0) >= 0 ? 'win' : 'loss'}">
      <td>${t.symbol || ''}</td>
      <td>${t.strategyName || ''}</td>
      <td>${t.exitReason || ''}</td>
      <td>${(t.pnlSol || 0).toFixed(4)}</td>
      <td>${new Date(t.closedAt).toLocaleTimeString()}</td>
    </tr>`).join('');

  const decisions = (state.decisions || []).slice(0, 15).map(d => `
    <div class="log-line">${new Date(d.time).toLocaleTimeString()} — ${d.type} ${d.symbol} — ${d.reason}</div>`).join('');

  const activityHtml = (state.activity || []).slice(0, 20).map(a => `
    <div class="log-line">${new Date(a.time).toLocaleTimeString()} — ${a.msg}</div>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Paper Trading Dashboard</title>
      <meta http-equiv="refresh" content="30">
      <style>
        body { font-family: system-ui; background: #0f172a; color: #e2e8f0; padding: 20px; }
        h1 { color: #38bdf8; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #334155; }
        th { background: #1e293b; }
        .win { color: #4ade80; }
        .loss { color: #f87171; }
        .balance { font-size: 2em; color: #38bdf8; }
        .log { background: #1e293b; padding: 12px; border-radius: 8px; max-height: 280px; overflow-y: auto; font-family: monospace; font-size: 0.9em; }
        .log-line { margin: 4px 0; border-bottom: 1px solid #334155; padding-bottom: 4px; }
        .agents { display: flex; gap: 12px; margin: 16px 0; }
        .agent { background: #1e293b; padding: 10px 14px; border-radius: 8px; font-size: 0.85em; }
      </style>
    </head>
    <body>
      <h1>Solana Paper Bot — Multi-Agent</h1>
      <div class="balance">Balance: ${(state.balance || 0).toFixed(4)} SOL</div>
      <p>Open: ${(state.openPositions || []).length} / ${config.maxOpen} | Last: ${new Date(state.lastUpdate || Date.now()).toLocaleString()}</p>
      <div class="agents">
        <div class="agent">SCANNER</div>
        <div class="agent">RUG CHECK</div>
        <div class="agent">SIZER</div>
        <div class="agent">EXECUTOR</div>
        <div class="agent">LOGGER</div>
      </div>
      <h2>Open Positions</h2>
      <table>
        <tr><th>Symbol</th><th>Strategy</th><th>Entry</th><th>Size</th><th>Time</th></tr>
        ${open || '<tr><td colspan="5">None</td></tr>'}
      </table>
      <h2>Recent Closed Trades</h2>
      <table>
        <tr><th>Symbol</th><th>Strategy</th><th>Exit</th><th>PnL (SOL)</th><th>Time</th></tr>
        ${closed || '<tr><td colspan="5">None yet</td></tr>'}
      </table>
      <h2>Decision Log (with reasons)</h2>
      <div class="log">${decisions || '<div>No decisions yet</div>'}</div>
      <h2>Activity</h2>
      <div class="log">${activityHtml || '<div>No activity yet</div>'}</div>
      <p style="color:#64748b">Auto-refreshes every 30s. Paper only. Multi-agent pipeline.</p>
    </body>
    </html>
  `);
});

app.listen(config.port, () => {
  console.log(`Dashboard running on port ${config.port}`);
  tick();
  setInterval(tick, config.pollIntervalMs);
});
