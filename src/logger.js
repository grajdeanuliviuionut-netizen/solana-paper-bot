const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  try {
    if (fs.existsSync(config.stateFile)) {
      return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    }
  } catch (e) {}
  return {
    balance: config.startingSol,
    openPositions: [],
    trades: [],
    startedAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString()
  };
}

function saveState(state) {
  ensureDir(config.stateFile);
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

function logTrade(trade) {
  ensureDir(config.tradesFile);
  fs.appendFileSync(config.tradesFile, JSON.stringify(trade) + '\n');
}

module.exports = { loadState, saveState, logTrade };
