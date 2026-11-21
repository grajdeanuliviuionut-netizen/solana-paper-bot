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
const { render } = require('./dashboard');

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
  state.lastUpdate = new Date().toISOString();
  saveState(state);
}

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(render(state, config));
});

app.listen(config.port, () => {
  console.log(`Dashboard running on port ${config.port}`);
  tick();
  setInterval(tick, config.pollIntervalMs);
});
