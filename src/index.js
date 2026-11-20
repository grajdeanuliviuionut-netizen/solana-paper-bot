const express = require('express');
const config = require('./config');
const { loadState, saveState, logTrade, readTrades } = require('./logger');
const { getCandidatePairs, getPairsByAddress } = require('./dataFetcher');
const { generateSignals } = require('./buyAgent');
const { shouldExit, computePnl } = require('./sellAgent');

// Never let one bad promise or exception kill the process / scan loop.
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.stack || err));
process.on('uncaughtException', err => { console.error('[uncaughtException] exiting so Railway restarts', err && err.stack || err); process.exit(1); });

// Persisted across restarts (Railway volume at /app/data); resets only when buildId changes.
let state = loadState(config.startingSol, config.buildId);
saveState(state);
console.log(`Boot build=${config.buildId} balance=${state.balance.toFixed(4)} open=${state.openPositions.length}`);

const app = express();
let lastScanSummary = 'none yet';
let tickRunning = false;
let tickCount = 0;

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortAddr(a) {
  return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
}

function addActivity(msg) {
  state.activity.unshift({ time: new Date().toISOString(), msg });
  if (state.activity.length > 50) state.activity.pop();
}

function canOpen() {
  if (state.balance < config.fullStopBalance) return false;
  if (state.openPositions.length >= config.maxOpen) return false;
  return true;
}

async function processExits() {
  if (!state.openPositions.length) return 0;
  // Exit pricing always uses the pair pinned at entry, quoted directly by pairAddress.
  let quotes = {};
  try {
    quotes = await getPairsByAddress(state.openPositions.map(p => p.pairAddress));
  } catch (e) {
    console.error('[exit] quote fetch failed', e.message);
  }
  let exits = 0;
  const stillOpen = [];
  for (const pos of state.openPositions) {
    try {
      const q = quotes[pos.pairAddress];
      const fresh = !!(q && q.mint === pos.mint && q.priceUsd > 0);
      if (fresh) {
        pos.lastPrice = q.priceUsd;
        pos.lastPriceAt = new Date().toISOString();
        if (q.priceUsd > (pos.highest || 0)) pos.highest = q.priceUsd;
      }
      const price = fresh ? q.priceUsd : (pos.lastPrice || pos.entryPrice);
      const exit = shouldExit(pos, price, fresh);
      if (!exit) { stillOpen.push(pos); continue; }
      const pnl = computePnl(pos, exit.fillPrice);
      state.balance += pos.sizeSol + pnl;
      const trade = {
        id: pos.id,
        build: config.buildId,
        strategyId: pos.strategyId,
        strategyName: pos.strategyName,
        symbol: pos.symbol,
        mint: pos.mint,
        pairAddress: pos.pairAddress,
        dexId: pos.dexId || null,
        sizeSol: pos.sizeSol,
        entryPrice: pos.entryPrice,
        entryTime: pos.entryTime,
        entryLiquidityUsd: pos.entryLiquidityUsd || null,
        exitPrice: exit.fillPrice,
        exitTime: new Date().toISOString(),
        closedAt: new Date().toISOString(),
        exitReason: exit.reason,
        priceFreshAtExit: fresh,
        highest: pos.highest,
        pnlPct: ((exit.fillPrice - pos.entryPrice) / pos.entryPrice) * 100 - config.costRoundtripPct,
        pnlSol: pnl,
        costRoundtripPct: config.costRoundtripPct
      };
      state.trades.unshift(trade);
      if (state.trades.length > 100) state.trades.pop();
      logTrade(trade);
      if (!state.cooldowns) state.cooldowns = {};
      state.cooldowns[pos.mint] = Date.now() + config.reentryCooldownMinutes * 60000;
      exits++;
      const line = `EXIT ${pos.symbol} ${pos.mint} (${pos.strategyId}) ${exit.reason} pnl=${pnl.toFixed(4)} SOL`;
      addActivity(line);
      console.log(`[trade] ${line}`);
    } catch (e) {
      console.error('[exit] position error', pos && pos.mint, e.message);
      stillOpen.push(pos);
    }
  }
  state.openPositions = stillOpen;
  return exits;
}

async function tick() {
  if (tickRunning) {
    console.log('[scan] previous cycle still running, skipping');
    return;
  }
  tickRunning = true;
  tickCount++;
  const t0 = Date.now();
  let pairsCount = 0, discovered = 0, signalsCount = 0, entries = 0, exits = 0;
  let gateLine = '';
  try {
    exits = await processExits();

    const { pairs, discoveredMints } = await getCandidatePairs();
    pairsCount = pairs.length;
    discovered = discoveredMints;
    addActivity(`Scanned ${pairs.length} pairs (${discoveredMints} mints discovered, liq >= $${config.minLiquidityUsd})`);

    const { signals, rejections, gateStats } = generateSignals(pairs);
    signalsCount = signals.length;
    gateLine = Object.entries(gateStats).map(([id, st]) => {
      const fails = Object.entries(st.fails).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(',');
      return `${id} pass=${st.passed}/${st.scanned} fails{${fails}}`;
    }).join(' | ');
    if (rejections.length) addActivity(`Rejections: ${rejections.slice(0, 2).join(' | ')}`);

    const openMints = new Set(state.openPositions.map(p => p.mint));
    const cooldowns = state.cooldowns || (state.cooldowns = {});
    for (const [m, until] of Object.entries(cooldowns)) if (until <= Date.now()) delete cooldowns[m];
    // One position per mint across ALL strategies (first matching strategy wins).
    const picked = [];
    for (const sig of signals) {
      if (!sig.mint || openMints.has(sig.mint) || cooldowns[sig.mint]) continue;
      openMints.add(sig.mint);
      picked.push(sig);
    }
    const slots = Math.max(0, Math.min(5, config.maxOpen - state.openPositions.length));
    const toOpen = canOpen() ? picked.slice(0, slots) : [];
    // Entry price comes from a fresh quote of the exact pair we pin (same source as exits).
    const entryQuotes = toOpen.length ? await getPairsByAddress(toOpen.map(s => s.pairAddress)) : {};
    for (const sig of toOpen) {
      if (!canOpen()) break;
      const q = entryQuotes[sig.pairAddress];
      if (!q || q.mint !== sig.mint || !(q.priceUsd > 0) || q.liquidityUsd < config.minLiquidityUsd) continue;
      sig.price = q.priceUsd;
      sig.liquidityUsd = q.liquidityUsd;
      const pos = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        build: config.buildId,
        strategyId: sig.strategyId,
        strategyName: sig.strategyName,
        symbol: sig.symbol,
        mint: sig.mint,
        pairAddress: sig.pairAddress,
        dexId: sig.dexId,
        entryLiquidityUsd: sig.liquidityUsd,
        entryPrice: sig.price,
        sizeSol: config.positionSizeSol,
        entryTime: new Date().toISOString(),
        exit: sig.exit,
        highest: sig.price,
        lastPrice: sig.price
      };
      state.openPositions.push(pos);
      state.balance -= config.positionSizeSol;
      entries++;
      const line = `ENTRY ${sig.symbol} ${sig.mint} pair=${sig.pairAddress} (${sig.strategyId}) @ ${sig.price}`;
      addActivity(line);
      console.log(`[trade] ${line}`);
    }
  } catch (e) {
    addActivity(`Tick error: ${e.message}`);
    console.error('[scan] tick error', e && e.stack || e);
  } finally {
    lastScanSummary = `${new Date().toISOString()} pairs=${pairsCount} signals=${signalsCount} entries=${entries} exits=${exits}`;
    console.log(`[scan] #${tickCount} ${Date.now() - t0}ms mints=${discovered} pairs=${pairsCount} signals=${signalsCount} entries=${entries} exits=${exits} open=${state.openPositions.length} bal=${state.balance.toFixed(4)} || ${gateLine}`);
    try { saveState(state); } catch (e) { console.error('[scan] save error', e.message); }
    tickRunning = false;
  }
}

function summarize(trades) {
  const byStrategy = {};
  for (const t of trades) {
    const s = byStrategy[t.strategyId] || (byStrategy[t.strategyId] = { trades: 0, wins: 0, pnlSol: 0, best: -Infinity });
    s.trades++;
    if (t.pnlSol > 0) s.wins++;
    s.pnlSol += t.pnlSol;
    s.best = Math.max(s.best, t.pnlSol);
  }
  for (const s of Object.values(byStrategy)) {
    s.winRate = s.trades ? s.wins / s.trades : 0;
    s.pnlExBestSol = s.trades ? s.pnlSol - s.best : 0;
  }
  return byStrategy;
}

// GET /api/trades            -> closed trades from the current build (newest first)
// GET /api/trades?all=1      -> every trade in the log, including older builds
app.get('/api/trades', (req, res) => {
  try {
    const all = readTrades().reverse();
    const trades = req.query.all ? all : all.filter(t => t.build === config.buildId);
    res.json({
      build: config.buildId,
      since: state.startedAt || null,
      balance: state.balance,
      count: trades.length,
      summary: summarize(trades.filter(t => t.build === config.buildId)),
      openPositions: state.openPositions,
      lastScan: lastScanSummary,
      trades
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, build: config.buildId, ticks: tickCount, lastScan: lastScanSummary, lastUpdate: state.lastUpdate });
});

app.get('/', (req, res) => {
  const open = state.openPositions.map(p => `
    <tr>
      <td>${esc(p.symbol)} <a href="https://dexscreener.com/solana/${esc(p.pairAddress)}" style="color:#64748b">${shortAddr(p.mint)}</a></td>
      <td>${esc(p.strategyName)}</td>
      <td>${Number(p.entryPrice).toPrecision(6)}</td>
      <td>${p.sizeSol}</td>
      <td>${new Date(p.entryTime).toLocaleTimeString()}</td>
    </tr>`).join('');

  const closed = state.trades.slice(0, 20).map(t => `
    <tr class="${t.pnlSol >= 0 ? 'win' : 'loss'}">
      <td>${esc(t.symbol)} <a href="https://dexscreener.com/solana/${esc(t.pairAddress)}" style="color:#64748b">${shortAddr(t.mint)}</a></td>
      <td>${esc(t.strategyName)}</td>
      <td>${esc(t.exitReason)}</td>
      <td>${Number(t.pnlSol).toFixed(4)}</td>
      <td>${new Date(t.closedAt).toLocaleTimeString()}</td>
    </tr>`).join('');

  const activityHtml = (state.activity || []).slice(0, 30).map(a => `
    <div class="log-line">${new Date(a.time).toLocaleTimeString()} — ${esc(a.msg)}</div>`).join('');

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
      <div class="balance">Balance: ${state.balance.toFixed(4)} SOL</div>
      <p>Open positions: ${state.openPositions.length} / ${config.maxOpen} | Last update: ${new Date(state.lastUpdate).toLocaleString()}</p>
      <p style="color:#64748b">Build ${esc(config.buildId)} | since ${new Date(state.startedAt || state.lastUpdate).toLocaleString()} | last scan: ${esc(lastScanSummary)} | <a href="/api/trades" style="color:#38bdf8">/api/trades</a></p>
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
  setInterval(() => { tick().catch(e => console.error('[scan] interval error', e)); }, config.pollIntervalMs);
});
