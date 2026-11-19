const fs = require('fs');
const path = require('path');
const config = require('./config');

function loadState() {
  try {
    if (fs.existsSync(config.stateFile)) {
      const raw = fs.readFileSync(config.stateFile, 'utf8');
      const state = JSON.parse(raw);
      if (!state.activity) state.activity = [];
      if (!state.trades) state.trades = [];
      if (!state.openPositions) state.openPositions = [];
      return state;
    }
  } catch (e) {
    console.error('State load failed, starting fresh', e.message);
  }
  return {
    balance: config.startingSol,
    openPositions: [],
    trades: [],
    activity: [],
    lastUpdate: new Date().toISOString()
  };
}

function saveState(state) {
  state.lastUpdate = new Date().toISOString();
  const dir = path.dirname(config.stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

function logTrade(trade) {
  const dir = path.dirname(config.tradesFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(config.tradesFile, JSON.stringify(trade) + '\n');
}

module.exports = { loadState, saveState, logTrade };
