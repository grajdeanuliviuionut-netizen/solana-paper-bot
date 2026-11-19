const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade } = require('./logger');
const { getCandidatePairs } = require('./dataFetcher');
const { generateSignals } = require('./buyAgent');
const { shouldExit, computePnl } = require('./sellAgent');

let state = loadState();
const app = express();

function canOpen() {
  if (state.balance < config.fullStopBalance) return false;
  if (state.openPositions.length >= config.maxOpen) return false;
  return true;
}

async function tick() {
  try {
    const pairs = await getCandidatePairs();
    const byAddr = {};
    pairs.forEach(p => byAddr[p.pairAddress] = p);

    // exits
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
        console.log(`EXIT ${pos.symbol} ${exit.reason} pnl=${pnl.toFixed(4)}`);
      } else {
        stillOpen.push(pos);
      }
    }
    state.openPositions = stillOpen;

    // entries
    if (canOpen()) {
      const signals = generateSignals(pairs);
      for (const sig of signals.slice(0, 3)) {
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
        console.log(`ENTRY ${sig.symbol} ${sig.strategyName} @ ${sig.price}`);
      }
    }
  } catch (e) {
    console.error('Tick error', e.message);
  }
  saveState(state);
}

// Dashboard
app.get('/', (req, res) => {
  const open = state.openPositions.map(p => `
    <tr>
      <td>${p.symbol}</td>
      <td>${p.strategyName}</td>
      <td>${p.entryPrice.toFixed(6)}</td>
      <td>${p.sizeSol}</td>
      <td>${new Date(p.entryTime).toLocaleTimeString()}</td>
    </tr>`).join('');

  const closed = state.trades.slice(0, 20).map(t => `
    <tr class="${t.pnlSol >= 0 ? 'win' : 'loss'}">
      <td>${t.symbol}</td>
      <td>${t.strategyName}</td>
      <td>${t.exitReason}</td>
      <td>${t.pnlSol.toFixed(4)}</td>
      <td>${new Date(t.closedAt).toLocaleTimeString()}</td>
    </tr>`).join('');

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
      </style>
    </head>
    <body>
      <h1>Solana Paper Bot</h1>
      <div class="balance">Balance: ${state.balance.toFixed(4)} SOL</div>
      <p>Open positions: ${state.openPositions.length} / ${config.maxOpen} | Last update: ${new Date(state.lastUpdate).toLocaleString()}</p>
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
