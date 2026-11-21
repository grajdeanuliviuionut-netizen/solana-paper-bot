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
const { review, sizeFor } = require('./manager');
const reentry = require('./reentry');
const httpBackoff = require('./httpBackoff');
const poolPrice = require('./poolPrice');
const { step: labStep } = require('./lab');

const shouldExit = sellAgent.shouldExit;
const computePnl = sellAgent.computePnl || function (pos, exitPrice) {
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
console.log('Re-entry cooldowns seeded from closed trades: ' + reentry.seed(state, config));

const app = express();

function addActivity(msg) {
  state.activity.unshift({ time: new Date().toISOString(), msg });
  if (state.activity.length > 50) state.activity.pop();
}

function lockedSol() {
  return (state.openPositions || []).reduce(function (sum, pos) { return sum + (Number(pos.sizeSol) || 0); }, 0);
}

function equity() {
  return (Number(state.balance) || 0) + lockedSol();
}

function sessionPnl() {
  const since = state.riskResetAt || 0;
  return (state.trades || []).reduce(function (sum, trade) {
    if (new Date(trade.closedAt).getTime() < since) return sum;
    return sum + (Number(trade.pnlSol) || 0);
  }, 0);
}

function skipSummary(rejections) {
  const counts = {};
  for (const line of rejections || []) {
    const raw = String(line);
    const match = raw.match(/:\s*([a-zA-Z0-9]+)\s+[-\d.]+\s+not\s+([<>]=?)\s+([-\d.]+)/);
    const key = match ? match[1] + ' not ' + match[2] + ' ' + match[3] : raw.split(':').slice(1).join(':').trim().slice(0, 60);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 4).map(function (key) {
    return counts[key] + ' missed: ' + key;
  });
}

function canOpen() {
  if (equity() < config.fullStopBalance) { state.blockReason = 'equity under 2.5'; return false; }
  if ((state.openPositions || []).length >= config.maxOpen) { state.blockReason = 'slots full'; return false; }
  if (state.coolUntil && Date.now() < state.coolUntil) { state.blockReason = 'cooldown'; return false; }
  if (sessionPnl() <= -config.dailyLossLimitSol) {
    state.coolUntil = Date.now() + 15 * 60 * 1000;
    state.riskResetAt = state.coolUntil;
    state.blockReason = 'cooldown 15m after -0.2';
    return false;
  }
  state.blockReason = '';
  return true;
}

// Slot reserve: strategies without a reserve may not take the slots reserved for others
// (config.slotReserve, e.g. { 'dip-hold': 1 }); the global config.maxOpen cap is unchanged.
function slotFree(strategyId) {
  const reserve = config.slotReserve || {};
  const open = state.openPositions || [];
  let held = 0;
  for (const [id, n] of Object.entries(reserve)) {
    if (id === strategyId) continue;
    held += Math.max(0, n - open.filter(function (p) { return p.strategyId === id; }).length);
  }
  if (open.length + 1 + held > config.maxOpen) {
    state.decisions.unshift(logDecision('SKIP', '-', 'slot reserved for ' + Object.keys(reserve).join(',')));
    return false;
  }
  return true;
}

// Entry pool check (PR8, fail closed): the entry price (fresh stored-pool price) vs the token's main
// pool (highest liquidity). Unverified -> skip; more than config.maxPoolDivergencePct (5%) off -> skip.
function poolChecks() {
  if (!state.poolChecks || state.poolChecks.v !== 2) state.poolChecks = { v: 2, since: new Date().toISOString(), checked: 0, verified: 0, divergenceSkips: 0, unverifiedSkips: 0, noPriceSkips: 0, lastSkips: [], lastVerified: [] };
  return state.poolChecks;
}
function recordSkip(st, row) {
  st.lastSkips = st.lastSkips.concat([Object.assign({ at: new Date().toISOString() }, row)]).slice(-20);
}
function poolGate(sig, entryPrice, pairs) {
  const st = poolChecks();
  st.checked += 1;
  const main = sig.mint ? poolPrice.mainPoolFor(sig.mint, pairs) : { pool: null, verified: false };
  if (!main.verified || !main.pool) {
    st.unverifiedSkips += 1;
    recordSkip(st, { reason: 'unverified', symbol: sig.symbol, strategyId: sig.strategyId, pairAddress: sig.pairAddress, mint: sig.mint || null });
    state.decisions.unshift(logDecision('SKIP', sig.symbol, 'main pool unverified'));
    return { ok: false, reason: 'unverified' };
  }
  const gap = main.pool.pairAddress === sig.pairAddress && main.source === 'scan' ? 0 : poolPrice.divergencePct(entryPrice, main.pool.priceUsd);
  const max = config.maxPoolDivergencePct || 5;
  if (gap == null || gap > max) {
    st.divergenceSkips += 1;
    recordSkip(st, { reason: 'divergence', symbol: sig.symbol, strategyId: sig.strategyId, pairAddress: sig.pairAddress, mainPool: main.pool.pairAddress, mainSource: main.source, price: entryPrice, mainPrice: main.pool.priceUsd, gapPct: gap == null ? null : +gap.toFixed(2) });
    state.decisions.unshift(logDecision('SKIP', sig.symbol, 'pool price ' + (gap == null ? '?' : gap.toFixed(1)) + '% off main pool'));
    addActivity('SKIP ' + sig.symbol + ' pool price ' + (gap == null ? '?' : gap.toFixed(1)) + '% off main pool ' + String(main.pool.pairAddress).slice(0, 6));
    return { ok: false, reason: 'divergence', gap };
  }
  st.verified += 1;
  st.lastVerified = st.lastVerified.concat([{ symbol: sig.symbol, pairAddress: sig.pairAddress, mainPool: main.pool.pairAddress, mainSource: main.source, gapPct: +gap.toFixed(2), at: new Date().toISOString() }]).slice(-10);
  return { ok: true, gap };
}

let ticking = false;
async function tick() {
  if (ticking) return; // a slow (backed-off) pass must not overlap the next one
  ticking = true;
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
    for (const p of pairs) if (p && p.pairAddress) byAddr[p.pairAddress] = p;
    // PR7 stored-pool pricing: every mark, exit check and close fill comes ONLY from the pool stored
    // on the position (pos.pairAddress). Pools not in this scan are fetched by address; if the stored
    // pool has no price this tick the position holds (only time exits may fire) and retries next tick.
    const storedPools = await poolPrice.storedPoolPrices(state.openPositions.map(function (p) { return p.pairAddress; }), pairs);
    const stillOpen = [];
    for (const pos of state.openPositions) {
      let pair = null;
      if (pos.pairAddress) pair = storedPools[pos.pairAddress] || null;
      else if (!pos.noPoolLogged) {
        pos.noPoolLogged = true;
        addActivity('PRICE ' + pos.symbol + ': no stored pool on this position, kept old pricing (entry price)');
      }
      const fresh = !!(pair && pair.priceUsd > 0);
      if (fresh && !pos.storedPoolPriced) {
        // First tick on stored-pool pricing: re-mark from the stored pool and drop marks taken elsewhere.
        const before = pos.lastPrice;
        pos.storedPoolPriced = new Date().toISOString();
        pos.highest = Math.max(Number(pos.entryPrice) || 0, pair.priceUsd);
        if (pos.judgedHigh != null) delete pos.judgedHigh;
        state.remarks = (state.remarks || []).concat([{ symbol: pos.symbol, pairAddress: pos.pairAddress, before: before == null ? null : before, after: pair.priceUsd, at: pos.storedPoolPriced }]).slice(-20);
        addActivity('PRICE re-mark ' + pos.symbol + ' from stored pool ' + String(pos.pairAddress).slice(0, 6) + ': ' + (before == null ? 'n/a' : Number(before).toPrecision(5)) + ' -> ' + Number(pair.priceUsd).toPrecision(5));
      }
      if (fresh) { pos.lastPrice = pair.priceUsd; pos.lastPricedAt = new Date().toISOString(); pos.priceStale = false; }
      else if (pos.pairAddress) {
        if (!pos.priceStale) addActivity('PRICE ' + pos.symbol + ': stored pool price unavailable, holding (retry next tick)');
        pos.priceStale = true;
      }
      const price = fresh ? pair.priceUsd : (pos.pairAddress ? (Number(pos.lastPrice) || pos.entryPrice) : pos.entryPrice);
      if (fresh && price > (pos.highest || 0)) pos.highest = price;
      const exit = shouldExit(pos, price, fresh || !pos.pairAddress);
      if (exit) {
        const pnl = computePnl(pos, exit.fillPrice);
        state.balance += pos.sizeSol + pnl;
        const trade = Object.assign({}, pos, { exitReason: exit.reason, exitPrice: exit.fillPrice, pnlSol: pnl, closedAt: new Date().toISOString() });
        state.trades.unshift(trade);
        if (state.trades.length > 100) state.trades.pop();
        logTrade(trade);
        reentry.recordExit(state, trade, config);
        state.decisions.unshift(logDecision('EXIT', pos.symbol, exit.reason, { pnl: pnl.toFixed(4) }));
        addActivity('EXIT ' + pos.symbol + ' ' + exit.reason + ' pnl=' + pnl.toFixed(4));
      } else stillOpen.push(pos);
    }
    state.openPositions = stillOpen;
    reentry.prune(state);
    const labNotes = labStep(state, pairs);
    for (const note of labNotes) addActivity(note);
    const result = generateSignals(pairs) || { signals: [], rejections: [] };
    state.skips = skipSummary(result.rejections);
    if (canOpen()) {
      let opened = 0;
      // Cooled-down tokens are skipped before the 3-per-pass cut so they don't use up the pass.
      const candidates = (result.signals || []).filter(function (sig) {
        const cool = reentry.blocked(state, sig);
        if (cool) state.decisions.unshift(logDecision('SKIP', sig.symbol, 're-entry cooldown ' + cool.minsLeft + 'm (' + cool.key.split(':')[0] + ')'));
        return !cool;
      });
      // Reserved strategies (dip-hold) are served first so the unpaused books can't crowd them out.
      const reserve = config.slotReserve || {};
      candidates.sort(function (a, b) { return (reserve[b.strategyId] ? 1 : 0) - (reserve[a.strategyId] ? 1 : 0); });
      // one candidate per pool per pass (several strategies can signal the same pool)
      const seenPool = {};
      const unique = candidates.filter(function (sig) { if (seenPool[sig.pairAddress]) return false; seenPool[sig.pairAddress] = true; return true; });
      const batch = unique.slice(0, 3);
      // Slow main-pool path (own limiter + cache), then fresh stored-pool prices for the entry fills.
      await poolPrice.prefetchMain(batch.map(function (s) { return s.mint; }));
      const entryPx = await poolPrice.storedPoolPrices(batch.map(function (s) { return s.pairAddress; }), pairs);
      const gateSeen = {};
      for (let sig of batch) {
        if (!canOpen()) break;
        if (state.openPositions.some(function (p) { return p.symbol === sig.symbol; })) continue;
        if ((state.pausedIds || []).includes(sig.strategyId)) continue;
        if (!slotFree(sig.strategyId)) continue;
        // Entry fill from the SAME stored-pool source as the marks (fresh scan row or /pools/multi).
        const px = entryPx[sig.pairAddress];
        if (!px) {
          poolChecks().noPriceSkips += 1;
          state.decisions.unshift(logDecision('SKIP', sig.symbol, 'no fresh stored-pool price'));
          continue;
        }
        const gate = gateSeen[sig.pairAddress] || (gateSeen[sig.pairAddress] = poolGate(sig, px.priceUsd, pairs));
        if (!gate.ok) continue;
        sig = Object.assign({}, sig, { price: px.priceUsd });
        const check = rugCheck(sig.pair || pairs.find(function (p) { return p.pairAddress === sig.pairAddress; }));
        if (!check.pass) {
          state.decisions.unshift(logDecision('SKIP', sig.symbol, 'rug check: ' + check.reason));
          continue;
        }
        const size = sizeFor(sizePosition(state.balance), state, config, sig.strategyId);
        const exec = executeEntry(sig, size, state.balance);
        if (exec.ok) {
          opened += 1;
          // The first mark is the entry price from the same source (no phantom gap on the next tick).
          exec.position.lastPrice = px.priceUsd;
          exec.position.lastPricedAt = new Date().toISOString();
          exec.position.storedPoolPriced = exec.position.lastPricedAt;
          exec.position.entryPriceSource = px.source;
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
  state.fetchStats = Object.assign({}, httpBackoff.stats);
  try { saveState(state); } finally { ticking = false; }
}

app.get('/', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(render(state, config));
});

app.get('/api/trades', function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({
    count: (state.trades || []).length,
    balance: state.balance,
    equity: equity(),
    openPositions: state.openPositions,
    pausedIds: state.pausedIds || [],
    stratSizeMult: state.stratSizeMult || {},
    reentryCooldowns: state.reentryCooldowns || {},
    fetchStats: state.fetchStats || null,
    poolChecks: state.poolChecks || null,
    mainPoolLookups: Object.assign({}, poolPrice.mainStats, { limiter: Object.assign({}, poolPrice.mainLimiter.stats) }),
    remarks: state.remarks || [],
    trades: state.trades || []
  });
});

if (require.main === module) app.listen(config.port, function () {
  console.log('Dashboard running on port ' + config.port);
  tick();
  setInterval(tick, config.pollIntervalMs);
});

module.exports = { app, tick, getState: function () { return state; } };
