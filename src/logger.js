const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : './data';
const STATE_FILE = process.env.STATE_FILE || path.join(DATA_DIR, 'state.json');
const TRADES_FILE = process.env.TRADES_FILE || path.join(DATA_DIR, 'trades.jsonl');

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Could not create data dir', e.message);
  }
}

function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(raw);
      if (!state.activity) state.activity = [];
      if (!state.trades) state.trades = [];
      if (!state.openPositions) state.openPositions = [];
      if (typeof state.balance !== 'number') state.balance = 4;
      return state;
    }
  } catch (e) {
    console.error('State load failed, starting fresh', e.message);
  }
  return {
    balance: 4,
    openPositions: [],
    trades: [],
    activity: [],
    lastUpdate: new Date().toISOString()
  };
}

function saveState(state) {
  ensureDir();
  try {
    state.lastUpdate = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Save failed', e.message);
  }
}

function logTrade(trade) {
  ensureDir();
  try {
    fs.appendFileSync(TRADES_FILE, JSON.stringify(trade) + '\n');
  } catch (e) {
    console.error('Trade log failed', e.message);
  }
}

module.exports = { loadState, saveState, logTrade };
