const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : './data';
const STATE_FILE = process.env.STATE_FILE || path.join(DATA_DIR, 'state.json');
const TRADES_FILE = process.env.TRADES_FILE || path.join(DATA_DIR, 'trades.jsonl');

function ensureDir() {
  try {
    const dirs = new Set([DATA_DIR, path.dirname(TRADES_FILE)]);
    for (const d of dirs) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    console.error('Could not create data dir', e.message);
  }
}

function freshState(startingSol, buildId) {
  return {
    build: buildId,
    startedAt: new Date().toISOString(),
    balance: startingSol,
    openPositions: [],
    trades: [],
    activity: [],
    lastUpdate: new Date().toISOString()
  };
}

// Loads persisted state. If it was written by a different build, starts fresh (the
// append-only trade log is kept) so results are counted from this build onward.
function loadState(startingSol = 4, buildId = null) {
  ensureDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (buildId && state.build !== buildId) {
        console.log(`State from build ${state.build || 'legacy'} -> starting fresh for ${buildId}`);
        return freshState(startingSol, buildId);
      }
      if (!state.activity) state.activity = [];
      if (!state.trades) state.trades = [];
      if (!state.openPositions) state.openPositions = [];
      if (typeof state.balance !== 'number') state.balance = startingSol;
      return state;
    }
  } catch (e) {
    console.error('State load failed, starting fresh', e.message);
  }
  return freshState(startingSol, buildId);
}

function saveState(state) {
  ensureDir();
  try {
    state.lastUpdate = new Date().toISOString();
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
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

function readTrades() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    return fs.readFileSync(TRADES_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    console.error('Trade read failed', e.message);
    return [];
  }
}

module.exports = { loadState, saveState, logTrade, readTrades };
