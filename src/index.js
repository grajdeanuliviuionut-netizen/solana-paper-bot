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
const { review } = require('./manager');
const { step: labStep } = require('./lab');

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

function lockedSol() {
  return (state.openPositions || []).reduce((sum, pos) => sum + (Number(pos.sizeSol) || 0), 0);
}

function equity() {
  return (Number(state.balance) || 0) + lockedSol();
}

function sessionPnl() {
  const since = state.riskResetAt || 0;
  return (state.trades || []).reduce((sum, trade) => {
    if (new Date(trade.closedAt).getTime() < since) return sum;
    return sum + (Number(trade.pnlSol) || 0);
  }, 0);
}

function canOpen() {
  if (equity() < config.fullStopBalance) {
    state.blockReason = 'equity under 2.5';
    return false;
  }
  if ((state.openPositions || []).length >= config.maxOpen) {
    state.blockReason = 'slots full';
    return false;
  }
  if (state.coolUntil && Date.now() < state.coolUntil) {
    state.blockReason = 'cooldown';
    return false;
  }
  if (sessionPnl() <= -config.dailyLossLimitSol) {
    state.coolUntil = Date.now() + 15 * 60 * 1000;
    state.riskResetAt = state.coolUntil;
    state.blockReason = 'cooldown 15m after -0.2';
    return false;
  }
  state.blockReason = '';
  return true;
}

async function tick() {
  try {
    if (state.paperReset !== 'work-1') {
      state.paperReset = 'work-1';
      state.riskResetAt = Date.now();
      state.coolUntil = 0;
      addActivity('MANAGER old losses no longer freeze new paper trades');
    }

    const notes = review(state, config).notes;
    for (const note of notes) addActivity(note);

    const pairs = await scan();
    addActivity('SCAN: ' + pairs.length + ' pairs');

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
        const trade = Object.assign({}, pos, { exitReason: exit.reason, exitPrice: exit.fillPrice, pnlSol: pnl, closedAt: new Date().toISOString() });
        state.trades.unshift(trade);
        if (state.trades.length > 100) state.trades.pop();
        logTrade(trade);
        const dec = logDecision('EXIT', pos.symbol, exit.reason, { pnl: pnl.toFixed(4) });
        state.decisions.unshift(dec);
        addActivity('EXIT ' + pos.symbol + ' ' + exit.reason + ' pnl=' + pnl.toFixed(4));
      } else {
        stillOpen.push(pos);
      }
    }
    state.openPositions = stillOpen;

    const labNotes = labStep(state, pairs);
    for (const note of labNotes) addActivity(note);
    state.labTicks = (state.labTicks || 0) + 1;
    if (state.lab && state.lab.lines && state.labTicks % 4 === 1) {
      addActivity('LAB ' + state.lab.lines[0]);
    }

    if (canOpen()) {
      const result = generateSignals(pairs) || { signals: [], rejections: [] };
      let opened = 0;
      for (const sig of (result.signals || []).slice(0, 3)) {
        if (!canOpen()) break;
        const already = state.openPositions.some(function (p) { return p.symbol === sig.symbol; });
        if (already) continue;
        if ((state.pausedIds || []).includes(sig.strategyId)) continue;

        const check = rugCheck(sig.pair || pairs.find(function (p) { return p.pairAddress === sig.pairAddress; }));
        if (!check.pass) {
          state.decisions.unshift(logDecision('SKIP', sig.symbol, 'rug check: ' + check.reason));
          continue;
        }

        const size = Math.max(0.05, sizePosition(state.balance) * (state.sizeMult || 1));
        const exec = executeEntry(sig, size, state.balance);
        if (exec.ok) {
          opened += 1;
          state.openPositions.push(exec.position);
          state.balance -= size;
          state.decisions.unshift(logDecision('ENTRY', sig.symbol, exec.reason, { size: size }));
          addActivity('ENTRY ' + sig.symbol + ' size ' + size.toFixed(3) + ' ' + (sig.strategyName || ''));
        }
      }
      if (opened) state.lastBlock = '';
      else if (state.lastBlock !== 'no-signal') {
        addActivity('SCAN no setup in ' + pairs.length + ' pairs');
        state.lastBlock = 'no-signal';
      }
    } else if (state.lastBlock !== state.blockReason) {
      addActivity('HOLD ' + state.blockReason);
      state.lastBlock = state.blockReason;
    }

    if (state.decisions.length > 100) state.decisions = state.decisions.slice(0, 100);
  } catch (e) {
    addActivity('Tick error: ' + e.message);
    console.error(e);
  }
  state.lastUpdate = new Date().toISOString();
  saveState(state);
}

app.get('/', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(render(state, config));
});

app.listen(config.port, function () {
  console.log('Dashboard running on port ' + config.port);
  tick();
  setInterval(tick, config.pollIntervalMs);
});
