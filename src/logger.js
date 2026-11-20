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

// Loads persisted state. Balance, open positions and history carry over across deploys
// (a new buildId no longer resets the paper account). Go-live counts are per strategy
// configHash, so they reset only when that strategy's parameters change.
// Set RESET_STATE=1 to deliberately start a fresh paper account.
function loadState(startingSol = 4, buildId = null) {
  ensureDir();
  try {
    if (process.env.RESET_STATE !== '1' && fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (buildId && state.build !== buildId) {
        console.log(`State from build ${state.build || 'legacy'} carried over to ${buildId} (balance=${Number(state.balance).toFixed(4)} open=${(state.openPositions || []).length})`);
        state.buildHistory = (state.buildHistory || []).concat([{ build: buildId, at: new Date().toISOString(), from: state.build || null }]).slice(-20);
        state.build = buildId;
      }
      if (!state.activity) state.activity = [];
      if (!state.trades) state.trades = [];
      if (!state.openPositions) state.openPositions = [];
      if (!state.startedAt) state.startedAt = new Date().toISOString();
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
