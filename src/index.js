const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade } = require('./logger');
const { getCandidatePairs } = require('./dataFetcher');
const { generateSignals } = require('./buyAgent');
const { shouldExit, computePnl } = require('./sellAgent');

let state = loadState();
if (!state.activity) state.activity = [];
if (!state.openPositions) state.openPositions = [];
if (!state.trades) state.trades = [];
if (typeof state.balance !== 'number') state.balance = config.startingSol;

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
    const pairs = await getCandidatePairs();
    addActivity(`Scanned ${pairs.length} pairs`);
    const byAddr = {};
    pairs.forEach(p => { if (p && p.pairAddress) byAddr[p.pairAddress] = p; });

    const stillOpen = [];
    for (const pos of state.openPositions) {
      const pair = byAddr[pos.pairAddress];
      const price = pair ? pair.priceUsd : pos.entryPrice;
      if (price > (pos.highest || 0)) pos.highest = price;
      const exit = shouldExit(pos, price);
      if (exit) {
        const pnl = computePnl(pos, exit.fillPrice);
        state.balance += pos.sizeSol + pnl;
        const trade = {
          ...pos,
          exitReason: exit.reason,
          exitPrice: exit.fillPrice,
          pnlSol: pnl,
          closedAt: new Date().toISOString()
        };
        state.trades.unshift(trade);
        if (state.trades.length > 100) state.trades.pop();
        logTrade(trade);
        addActivity(`EXIT ${pos.symbol} (${pos.strategyName}) ${exit.reason} pnl=${pnl.toFixed(4)} SOL`);
      } else {
        stillOpen.push(pos);
      }
    }
    state.openPositions = stillOpen;

    if (canOpen()) {
      const result = generateSignals(pairs);
      const signals = result.signals || [];
      const rejections = result.rejections || [];
      if (rejections.length) {
        addActivity(`Rejections: ${rejections.slice(0, 2).join(' | ')}`);
      }
      for (const sig of signals.slice(0, 5)) {
        if (!canOpen()) break;
        const already = state.openPositions.some(p => p.pairAddress === sig.pairAddress && p.strategyId === sig.strategyId);
        if (already) continue;
        const pos = {
          id: Date.now() + Math.random(),
          strategyId: sig.strategyId,
          strategyName: sig.strategyName,
          symbol: sig.symbol,
          pairAddress: sig.pairAddress,
          entryPrice: sig.price,
          sizeSol: config.positionSizeSol,
          entryTime: new Date().toISOString(),
          exit: sig.exit,
          highest: sig.price
        };
        state.openPositions.push(pos);
        state.balance -= config.positionSizeSol;
        addActivity(`ENTRY ${sig.symbol} (${sig.strategyName}) @ ${sig.price}`);
      }
    }
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

  const activityHtml = (state.activity || []).slice(0, 30).map(a => `
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
        .log { background: #1e293b; padding: 12px; border-radius: 8px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.9em; }
        .log-line { margin: 4px 0; border-bottom: 1px solid #334155; padding-bottom: 4px; }
      </style>
    </head>
    <body>
      <h1>Solana Paper Bot</h1>
      <div class="balance">Balance: ${(state.balance || 0).toFixed(4)} SOL</div>
      <p>Open positions: ${(state.openPositions || []).length} / ${config.maxOpen} | Last update: ${new Date(state.lastUpdate || Date.now()).toLocaleString()}</p>
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
      <h2>Activity Log</h2>
      <div class="log">
        ${activityHtml || '<div>No activity yet</div>'}
      </div>
      <p style="color:#64748b">Auto-refreshes every 30s. Paper only.</p>
    </body>
    </html>
  `);
});

app.listen(config.port, () => {
  console.log(`Dashboard running on port ${config.port}`);
  tick();
  setInterval(tick, config.pollIntervalMs);
});
