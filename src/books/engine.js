// PR11: four aggressive PAPER books (Liviu t64u). Paper only: Jupiter is used through the read-only
// quote API (no swap is ever built, signed or sent); no wallet, no key, LIVE_TRADING untouched.
//
// Every book: same size (config.books.sizeSol), own capacity (maxOpenPerBook), own name + version on
// every trade. Entry gates (in order): book rules on a FRESH (<= 30 s) DexScreener scan row -> stock /
// stablecoin / wrapped-major block -> 45-min re-entry cooldown -> book capacity -> independent main-pool
// check (PR9 poolGate, fail closed) -> mint + freeze authority revoked (Solana RPC) -> Jupiter buy quote
// SOL->token at the trade size -> Jupiter sell quote token->SOL for the tokens received (a sell route
// must exist; round trip and quote-vs-DexScreener gap capped) -> open.
// Fill = the buy quote's outAmount. Marks / exits = a Jupiter sell quote for the tokens still held,
// re-quoted every exit pass (a few seconds apart). A decision never uses a quote older than 30 s.
// pnlSol per leg = solOut - basis - 1.1% x basis (the round-trip cost stays inside pnlSol).
const { classifyBlocked } = require('./blocklist');
const stopFills = require('../stopFills');
const { heldMint, REASON: REASON_SAME_MINT } = require('./sameMint');
const m15Mod = require('./m15');

const MIN = 60000;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const label = b => b.id + ' v' + b.version;

// ---------- entry rules (pure) ----------
function isPumpOrigin(row) {
  return /pump$/i.test(String(row.mint || '')) || ['pumpswap', 'pumpfun', 'pump.fun'].includes(String(row.dexId || '').toLowerCase());
}
function poolAgeMin(row, now) { return row.pairCreatedAt ? (now - row.pairCreatedAt) / MIN : null; }
// Hour-average 5-min volume = the PREVIOUS 55 minutes of the h1 window, per 5 min: (h1 - m5) / 11.
function m5VolumeVsHourAvg(row) {
  const base = (num(row.volumeH1) - num(row.volumeM5)) / 11;
  return base > 0 ? num(row.volumeM5) / base : null;
}
// 24 h high estimate (approximate, a LOWER bound of the true high): the highest of the current price,
// the prices implied 5 min / 1 h / 6 h / 24 h ago by DexScreener's priceChange (price / (1 + chg)),
// and every snapshot we stored for this mint in the last 24 h (one per 5 min, kept on the volume).
function high24Estimate(row, snaps, now) {
  const p = num(row.priceUsd);
  if (!(p > 0)) return null;
  let hi = p;
  for (const k of ['m5', 'h1', 'h6', 'h24']) {
    const c = num(row.priceChange && row.priceChange[k]);
    if (c > -100) hi = Math.max(hi, p / (1 + c / 100));
  }
  for (const s of snaps || []) if (now - s[0] <= 24 * 3600000 && s[1] > hi) hi = s[1];
  return hi;
}
function dropFromHighPct(row, snaps, now) {
  const hi = high24Estimate(row, snaps, now);
  return hi ? ((hi - num(row.priceUsd)) / hi) * 100 : null;
}

// Returns null (passes) or the first failed rule as a short reason.
function entryFails(book, row, ctx) {
  const e = book.entry, now = ctx.now, pc = row.priceChange || {};
  if (e.minLiquidityUsd && num(row.liquidityUsd) < e.minLiquidityUsd) return (e.maxLiquidityUsd != null ? 'liquidityMin: < ' : 'liquidity < ') + e.minLiquidityUsd;
  if (book.id === 'graduation-sniper') {
    if (e.pumpOrigin && !isPumpOrigin(row)) return 'not pump.fun origin';
    const age = poolAgeMin(row, now);
    if (age == null) return 'no pairCreatedAt';
    if (age > e.maxPoolAgeMin || age < 0) return 'pool older than ' + e.maxPoolAgeMin + 'm';
    if (e.minPoolAgeMin && age < e.minPoolAgeMin) return 'pool younger than ' + e.minPoolAgeMin + 'm';
    const t = row.txnsM5 || {};
    if (e.m5BuysGtSells && !(num(t.buys) > num(t.sells))) return 'm5 buys <= sells';
    return null;
  }
  if (book.id === 'runner-hunter' && e.maxLiquidityUsd != null) {
    // t86u v3 (Liviu): liquidity $100k-$900k, 24 h volume >= 0.1x liquidity, h1 <= 25, rising on m5 AND m15.
    // (top-10 holders <= 30% and the 24 h stop cooldown are checked in runEntries; m15 without own history too.)
    const liq = num(row.liquidityUsd);
    if (liq > e.maxLiquidityUsd) return 'liquidityMax: > ' + e.maxLiquidityUsd;
    const v24 = num(row.volumeH24) / (liq || 1);
    if (v24 < e.minVolumeToLiquidityH24) return 'vol24Liq: < ' + e.minVolumeToLiquidityH24;
    if (num(pc.h1) > e.maxH1) return 'h1Max: > ' + e.maxH1;
    if (!(num(pc.m5) > e.minM5)) return 'm5: <= ' + e.minM5;
    const m = m15Mod.m15FromTicks(ctx.ticks && ctx.ticks[row.pairAddress], num(row.priceUsd), now);
    if (m && !(m.pct > e.minM15)) return 'm15: <= ' + e.minM15;
    return null;
  }
  if (book.id === 'runner-hunter') {
    const vl = num(row.volumeH1) / (num(row.liquidityUsd) || 1);
    if (vl < e.minVolumeToLiquidityH1) return 'h1 vol/liq < ' + e.minVolumeToLiquidityH1;
    if (num(pc.h1) < e.minH1) return 'h1 < ' + e.minH1;
    if (num(pc.m5) < e.minM5) return 'm5 < ' + e.minM5;
    return null;
  }
  if (book.id === 'volume-explosion') {
    const age = poolAgeMin(row, now);
    if (age == null || age < e.minPoolAgeMin) return 'pool younger than ' + e.minPoolAgeMin + 'm';
    if (num(row.volumeM5) < e.minVolumeM5Usd) return 'm5 volume < ' + e.minVolumeM5Usd;
    const x = m5VolumeVsHourAvg(row);
    if (x == null || x < e.minM5VolumeVsHourAvg) return 'm5 vol < ' + e.minM5VolumeVsHourAvg + 'x hour avg';
    if (num(pc.m5) <= e.minM5) return 'm5 <= ' + e.minM5;
    if (num(pc.m5) > e.maxM5) return 'm5 > ' + e.maxM5;
    return null;
  }
  if (book.id === 'trending-pullback') {
    if (num(pc.h24) < e.minH24) return 'h24 < ' + e.minH24;
    const d = dropFromHighPct(row, ctx.snaps && ctx.snaps[row.mint], now);
    if (d == null || d < e.minDropFromHighPct || d > e.maxDropFromHighPct) return 'drop from high not ' + e.minDropFromHighPct + '-' + e.maxDropFromHighPct + '%';
    if (e.volumeRising && !(num(row.volumeH1) > num(row.volumeH6) / 6)) return 'volume not rising (h1 <= h6/6)';
    return null;
  }
  return 'unknown book';
}
function signalFields(book, row, ctx) {
  const pc = row.priceChange || {};
  const f = { liquidityUsd: row.liquidityUsd, volumeH1: row.volumeH1, m5: pc.m5, h1: pc.h1, h24: pc.h24, dexId: row.dexId };
  if (book.id === 'graduation-sniper') Object.assign(f, { poolAgeMin: +num(poolAgeMin(row, ctx.now)).toFixed(1), txnsM5: row.txnsM5, pumpOrigin: isPumpOrigin(row) });
  if (book.id === 'runner-hunter') f.volumeToLiquidityH1 = +(num(row.volumeH1) / (num(row.liquidityUsd) || 1)).toFixed(3);
  if (book.id === 'runner-hunter' && book.entry && book.entry.maxLiquidityUsd != null) {
    const m = m15Mod.m15FromTicks(ctx.ticks && ctx.ticks[row.pairAddress], num(row.priceUsd), ctx.now);
    Object.assign(f, { volumeH24: row.volumeH24, volumeToLiquidityH24: +(num(row.volumeH24) / (num(row.liquidityUsd) || 1)).toFixed(3), m15: m ? +m.pct.toFixed(3) : null, m15Source: m ? m.source : null, m15FromAgeMin: m ? m.fromAgeMin : null });
  }
  if (book.id === 'volume-explosion') Object.assign(f, { volumeM5: row.volumeM5, m5VolumeVsHourAvg: +num(m5VolumeVsHourAvg(row)).toFixed(2) });
  if (book.id === 'trending-pullback') Object.assign(f, { volumeH6: row.volumeH6, high24Est: high24Estimate(row, ctx.snaps && ctx.snaps[row.mint], ctx.now), dropFromHighPct: +num(dropFromHighPct(row, ctx.snaps && ctx.snaps[row.mint], ctx.now)).toFixed(2) });
  return f;
}

// ---------- exit rules (pure) ----------
// pct / peakPct: Jupiter sell-quote value of the tokens still held vs their cost basis, in % (gross of
// the 1.1% cost, which is charged inside pnlSol). Returns null | { action: 'close'|'partial', reason, sellPct }.
function decideExit(pos, ex, pct, peakPct, minsOpen) {
  if (pct <= -ex.stopLossPct) return { action: 'close', reason: 'sl' };
  if (ex.takeProfitPct != null && pct >= ex.takeProfitPct) return { action: 'close', reason: 'tp' };
  if (ex.partial && !pos.partialDone && pct >= ex.partial.atPct) return { action: 'partial', reason: 'partial-tp', sellPct: ex.partial.sellPct };
  const armed = ex.trailAfterPartial ? !!pos.partialDone : (ex.trailAfterPct != null && peakPct >= ex.trailAfterPct);
  if (armed && ex.trailPct && (1 + pct / 100) <= (1 + peakPct / 100) * (1 - ex.trailPct / 100)) return { action: 'close', reason: 'trail' };
  if (minsOpen >= ex.maxHoldMinutes) return { action: 'close', reason: 'time' };
  return null;
}
function quoteFresh(q, now, maxAgeSec) { return !!(q && q.ok && q.at && now - q.at <= maxAgeSec * 1000 && now >= q.at - 1000); }

// ---------- scoreboard ----------
function bookStats(trades, open, target) {
  const n = trades.length;
  const pnl = trades.map(t => num(t.pnlSol));
  const net = pnl.reduce((a, b) => a + b, 0);
  const best = n ? Math.max(...pnl) : 0;
  const pcts = trades.map(t => num(t.pnlPct));
  const wins = pnl.filter(x => x > 0).length;
  return {
    trades: n, wins, losses: n - wins, winRatePct: n ? +((100 * wins) / n).toFixed(1) : null,
    netSol: +net.toFixed(6), profitPerTradeSol: n ? +(net / n).toFixed(6) : null,
    profitPerTradePct: n ? +(pcts.reduce((a, b) => a + b, 0) / n).toFixed(3) : null,
    netWithoutBestSol: n ? +(net - best).toFixed(6) : null,
    profitPerTradeWithoutBestSol: n > 1 ? +((net - best) / (n - 1)).toFixed(6) : null,
    bestTradeSol: n ? +best.toFixed(6) : null,
    worstLossPct: n ? +Math.min(0, ...pcts).toFixed(3) : null,
    openPositions: open.length, progress: Math.min(n, target) + '/' + target, targetReached: n >= target
  };
}

// ---------- runtime ----------
function makeBooks({ config, quotes, mintAuth, reentry, log, saveTrade, now: clock, holderCheck, sleep, top10, m15 }) {
  const sleepFn = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  let curV2 = null;   // grad sniper v2: checks gathered for the candidate being evaluated (logged on reject/entry)
  const C = config.books;
  const nowFn = clock || Date.now;
  let chain = Promise.resolve();
  const locked = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  // t85u: config.onlyStrategies (allow-list) blocks every other book at entry, on top of the paused flags.
  const allowed = id => !Array.isArray(config.onlyStrategies) || config.onlyStrategies.includes(id);

  function ensure(state) {
    if (!state.books || typeof state.books !== 'object') state.books = {};
    const b = state.books;
    if (!Array.isArray(b.open)) b.open = [];
    if (!Array.isArray(b.trades)) b.trades = [];
    if (!b.rejects) b.rejects = { byReason: {}, byBook: {}, recent: [] };
    if (!b.stockBlocks) b.stockBlocks = { count: 0, recent: [] };
    if (!b.snaps) b.snaps = {};
    if (!b.entries) b.entries = { attempts: 0, opened: 0 };
    if (!b.ticks) b.ticks = {};
    if (!b.entryFilters) b.entryFilters = {};
    const gb = C.list.find(x => x.id === 'graduation-sniper');
    if (gb && (!b.gradSniper || b.gradSniper.version !== gb.version)) {
      b.gradSniper = { label: label(gb), version: gb.version, since: new Date(nowFn()).toISOString(), candidates: 0, candidateMints: [],
        rejectsByCategory: { lp: 0, holders: 0, age: 0, impact: 0, other: 0 }, rejectedMintsByCategory: { lp: [], holders: [], age: [], impact: [], other: [] },
        rejectsByReason: {}, entries: 0, closes: 0, confirmsTriggered: 0, confirmsConfirmed: 0, confirms: [] };
    }
    return b;
  }
  // t86u: per-filter counters for books with v3-style entries (first failing rule per candidate row per scan).
  function filterStats(state, book) {
    const b = ensure(state);
    const f = b.entryFilters[book.id];
    const ep = state.scoreboard && state.scoreboard.epoch;
    if (!f || f.epoch !== ep) b.entryFilters[book.id] = { epoch: ep || null, since: new Date(nowFn()).toISOString(), evaluated: 0, passedRules: 0, entered: 0, byFilter: {}, lastScan: null };
    return b.entryFilters[book.id];
  }
  const filterKey = reason => String(reason).split(':')[0].trim();
  function countFilter(state, book, reason) {
    if (!(book && book.entry && book.entry.maxLiquidityUsd != null)) return;
    const f = filterStats(state, book), k = filterKey(reason);
    f.byFilter[k] = (f.byFilter[k] || 0) + 1;
    if (f.lastScan) f.lastScan.byFilter[k] = (f.lastScan.byFilter[k] || 0) + 1;
  }
  // t86u guardrail: N consecutive losing closes of a book -> no new entries for M minutes, then auto-resume.
  function guard(state) {
    const b = ensure(state);
    if (!b.guardrail) b.guardrail = { streak: {}, pauses: [], pausedUntil: {} };
    return b.guardrail;
  }
  function lossPaused(state, bookId, t) { const g = guard(state); const u = g.pausedUntil[bookId]; return u && Date.parse(u) > t ? u : null; }
  function stopCooldown(state, row, t) {
    const m = state.stopCooldowns || {};
    for (const k of ['mint:' + row.mint, 'pair:' + row.pairAddress]) if (m[k] && Date.parse(m[k].until) > t) return m[k];
    return null;
  }
  // Same-mint guard counters (books and legacy) in state.books.sameMint.
  function sameMintCount(state, strategyId) {
    const b = ensure(state);
    const m = b.sameMint || (b.sameMint = { blocked: 0, byStrategy: {} });
    m.blocked += 1; m.byStrategy[strategyId] = (m.byStrategy[strategyId] || 0) + 1;
  }
  // Legacy strategies record their same-mint skips in the same rejects store (byReason / byBook / recent).
  function rejectLegacy(state, strategyId, row, reason, extra) {
    const b = ensure(state);
    if (reason === REASON_SAME_MINT) sameMintCount(state, strategyId);
    const key = String(reason).replace(/[-\d.]+%?$/, '').trim();
    b.rejects.byReason[key] = (b.rejects.byReason[key] || 0) + 1;
    const lb = strategyId + ' legacy';
    const bb = b.rejects.byBook[lb] || (b.rejects.byBook[lb] = {});
    bb[key] = (bb[key] || 0) + 1;
    b.rejects.recent = [Object.assign({ at: new Date(nowFn()).toISOString(), book: lb, symbol: row && row.symbol, mint: row && row.mint, reason }, extra || {})].concat(b.rejects.recent).slice(0, 50);
  }
  function reject(state, book, row, reason, extra) {
    const b = ensure(state);
    const key = String(reason).replace(/[-\d.]+%?$/, '').trim();
    b.rejects.byReason[key] = (b.rejects.byReason[key] || 0) + 1;
    const bb = b.rejects.byBook[book ? book.id : 'all'] || (b.rejects.byBook[book ? book.id : 'all'] = {});
    bb[key] = (bb[key] || 0) + 1;
    b.rejects.recent = [Object.assign({ at: new Date(nowFn()).toISOString(), book: book ? label(book) : null, symbol: row && row.symbol, mint: row && row.mint, reason }, extra || {})].concat(b.rejects.recent).slice(0, 50);
    if (log) log('SKIP', row && row.symbol, (book ? label(book) + ' ' : '') + reason);
    if (book && book.id === 'graduation-sniper' && !/^re-entry cooldown/.test(String(reason))) {
      gradCount(state, gradCategory(reason), reason, row && row.mint);
      gradLog(state, Object.assign({ symbol: row && row.symbol, mint: row && row.mint, pairAddress: row && row.pairAddress }, curV2 || {}, extra && extra.holderCheck ? {} : (extra || {}), { result: 'rejected', category: gradCategory(reason), reason }));
    }
  }
  // Graduation sniper v2 counters (by category: lp, holders, age, impact, other; attempts + distinct mints).
  function gradCount(state, category, reason, mint) {
    const g = ensure(state).gradSniper;
    if (!g) return;
    g.rejectsByCategory[category] = (g.rejectsByCategory[category] || 0) + 1;
    const key = String(reason).replace(/[-\d.]+%?$/, '').trim();
    g.rejectsByReason[key] = (g.rejectsByReason[key] || 0) + 1;
    const l = g.rejectedMintsByCategory[category] || (g.rejectedMintsByCategory[category] = []);
    if (mint && !l.includes(mint)) { l.push(mint); if (l.length > 300) l.shift(); }
  }
  function gradLog(state, entry) {
    const g = ensure(state).gradSniper;
    if (!g) return;
    if (!g.candidateLog) g.candidateLog = [];
    g.candidateLog = [Object.assign({ at: new Date(nowFn()).toISOString() }, entry)].concat(g.candidateLog).slice(0, 60);
  }
  function gradCategory(reason) {
    const r = String(reason);
    if (/^lp:/.test(r)) return 'lp';
    if (/^holders:/.test(r)) return 'holders';
    if (/^impact:/.test(r)) return 'impact';
    if (/^pool younger/.test(r)) return 'age';
    return 'other';
  }
  function stockBlock(state, row, where) {
    const why = classifyBlocked({ mint: row.mint, symbol: row.symbol, name: row.name });
    if (!why) return null;
    const b = ensure(state);
    b.stockBlocks.count += 1;
    b.stockBlocks.recent = [{ at: new Date(nowFn()).toISOString(), symbol: row.symbol, mint: row.mint, reason: why, where }].concat(b.stockBlocks.recent).slice(0, 30);
    return why;
  }

  // 24 h price snapshots per mint (one per 5 min) for the pullback book's high estimate.
  function recordSnaps(state, pairs) {
    const b = ensure(state), t = nowFn();
    for (const r of pairs || []) {
      if (!r || r.stale || !r.mint || !(r.priceUsd > 0)) continue;
      const s = b.snaps[r.mint] || (b.snaps[r.mint] = []);
      if (!s.length || t - s[s.length - 1][0] >= 5 * MIN) s.push([t, r.priceUsd]);
      while (s.length && t - s[0][0] > 24 * 3600000) s.shift();
    }
    for (const m of Object.keys(b.snaps)) if (!b.snaps[m].length || t - b.snaps[m][b.snaps[m].length - 1][0] > 24 * 3600000) delete b.snaps[m];
    // t86u: ~45 s pool price ticks (last 20 min) for m15, pools with liquidity >= $50k.
    for (const r of pairs || []) if (r && num(r.liquidityUsd) >= 50000) m15Mod.recordTick(b.ticks, r, t);
    m15Mod.pruneTicks(b.ticks, t);
  }

  // extraByBook: { bookId: rows } extra candidate rows for one book only (PR13: new-pools feed rows
  // go to the graduation sniper only). onExtraPass(book, row) is called for each extra row that passes.
  function signals(state, pairs, extraByBook, onExtraPass) {
    const b = ensure(state), t = nowFn(), out = [];
    const ctx = { now: t, snaps: b.snaps, ticks: b.ticks };
    for (const book of C.list) {
      if (book.paused || !allowed(book.id)) continue;   // t83u/t85u: paused or not allowed -> no new entries (open positions still exit)
      const extra = (extraByBook && extraByBook[book.id]) || [];
      const seen = new Set((pairs || []).map(r => r && r.mint));
      const extraOnly = extra.filter(r => r && !seen.has(r.mint));
      for (const r of extra) if (r && !entryFails(book, r, ctx) && onExtraPass) onExtraPass(book, r);
      const v3 = book.entry && book.entry.maxLiquidityUsd != null;
      if (v3) filterStats(state, book).lastScan = { at: new Date(t).toISOString(), rows: (pairs || []).length, passedRules: 0, byFilter: {} };
      for (const row of (pairs || []).concat(extraOnly)) {
        if (!row || !row.mint) continue;
        const why = entryFails(book, row, ctx);
        if (v3) { const f = filterStats(state, book); f.evaluated++; if (why) countFilter(state, book, why); else { f.passedRules++; f.lastScan.passedRules++; } }
        if (book.id === 'graduation-sniper' && b.gradSniper && (!why || /^pool younger/.test(why))) {
          const g = b.gradSniper;
          if (!g.candidateMints.includes(row.mint)) { g.candidateMints.push(row.mint); if (g.candidateMints.length > 300) g.candidateMints.shift(); g.candidates++; }
          // age: counted once per mint (it is re-seen every scan until it is 3 min old)
          if (why && !(g.rejectedMintsByCategory.age || []).includes(row.mint)) {
            gradCount(state, 'age', why, row.mint);
            gradLog(state, { symbol: row.symbol, mint: row.mint, pairAddress: row.pairAddress, poolAgeMin: +num(poolAgeMin(row, t)).toFixed(2), liquidityUsd: row.liquidityUsd, result: 'rejected', category: 'age', reason: why });
          }
        }
        if (!why) out.push({ book, row, fields: signalFields(book, row, ctx) });
      }
    }
    return out;
  }

  // Entries for one tick. gate(sig) = PR9 main-pool check (async, fail closed).
  function runEntries(state, pairs, gate, extraByBook, onExtraPass) {
    return locked(async () => {
      const b = ensure(state);
      recordSnaps(state, pairs);
      if (state.epochSwitch && state.epochSwitch.pending) { b.lastScan = { at: new Date(nowFn()).toISOString(), pairs: (pairs || []).length, candidatesByBook: {}, note: 'epoch switch pending: leftovers closing, no entries' }; return; }
      const sigs = signals(state, pairs, extraByBook, onExtraPass);
      let gtBudget = C.m15GtPerScan || 6;   // t86u: at most 6 GeckoTerminal m15 lookups per scan (keeps the scan short)
      // PR14 dashboard: candidates per book in the last scan (why an empty book is idle).
      const cand = {};
      for (const bk of C.list) if (!bk.paused && allowed(bk.id)) cand[bk.id] = 0;
      for (const sg of sigs) cand[sg.book.id] = (cand[sg.book.id] || 0) + 1;
      b.lastScan = { at: new Date(nowFn()).toISOString(), pairs: (pairs || []).length, candidatesByBook: cand };
      let tried = 0;
      for (const { book, row, fields } of sigs) {
        if (tried >= C.maxEntriesPerTick) break;
        const t = nowFn();
        curV2 = book.id === 'graduation-sniper' ? { poolAgeMin: +num(poolAgeMin(row, t)).toFixed(2), liquidityUsd: row.liquidityUsd, txnsM5: row.txnsM5 || null } : null;
        const openHere = b.open.filter(p => p.book === book.id);
        if (openHere.length >= C.maxOpenPerBook) continue;                  // capacity: not a reject
        const lp = book.entry && book.entry.lossStreakPause ? lossPaused(state, book.id, t) : null;
        if (lp) { countFilter(state, book, 'lossStreakPause'); continue; }   // t86u guardrail: paused after N losses in a row
        if (book.entry && book.entry.stopCooldownHours) {
          const sc = stopCooldown(state, row, t);
          if (sc) { countFilter(state, book, 'stopCooldown24h'); reject(state, book, row, 'stopCooldown24h', { until: sc.until }); continue; }
        }
        // Cross-strategy same-mint guard: no book opens a mint held by ANY book or legacy strategy (fail closed).
        const held = heldMint(state, row);
        if (held) { sameMintCount(state, book.id); reject(state, book, row, REASON_SAME_MINT, { detail: held.detail, heldBy: held.heldBy }); continue; }
        const stock = stockBlock(state, row, 'books');
        if (stock) { reject(state, book, row, 'stock-block: ' + stock); continue; }
        const cool = reentry.blocked(state, { mint: row.mint, pairAddress: row.pairAddress }, t);
        if (cool) { reject(state, book, row, 're-entry cooldown'); continue; }
        if (row.stale || !row.fetchedAt || t - row.fetchedAt > C.maxPriceAgeSec * 1000) { reject(state, book, row, 'stale scan row (> ' + C.maxPriceAgeSec + 's)'); continue; }
        if (state.balance < C.sizeSol) { reject(state, book, row, 'insufficient balance'); continue; }
        tried++;
        b.entries.attempts++;
        const g = await gate({ symbol: row.symbol, mint: row.mint, pairAddress: row.pairAddress, strategyId: book.id }, row);
        if (!g || !g.ok) { reject(state, book, row, 'main-pool check: ' + ((g && g.reason) || 'failed')); continue; }
        // t86u v3: m15 from GeckoTerminal 1m OHLCV when the bot's own 15-min price history is missing (fail closed).
        if (book.entry && book.entry.minM15 != null && fields.m15 == null) {
          if (gtBudget <= 0) { countFilter(state, book, 'm15Pending'); continue; }   // no data yet this scan: not entered (fail closed)
          gtBudget--;
          const g15 = m15 ? await m15.gt(row.pairAddress, nowFn()) : null;
          if (!g15) { countFilter(state, book, 'm15NoData'); reject(state, book, row, 'm15: no 15-min data (own history + GeckoTerminal)'); continue; }
          Object.assign(fields, { m15: +g15.pct.toFixed(3), m15Source: g15.source, m15FromAgeMin: g15.fromAgeMin });
          if (!(g15.pct > book.entry.minM15)) { countFilter(state, book, 'm15'); reject(state, book, row, 'm15: <= ' + book.entry.minM15 + ' (GeckoTerminal)'); continue; }
        }
        const rug = await mintAuth.check(row.mint);
        const rugCheck = { pass: rug.pass, reason: rug.reason, mintAuthority: rug.mintAuthority === undefined ? null : rug.mintAuthority, freezeAuthority: rug.freezeAuthority === undefined ? null : rug.freezeAuthority, program: rug.program || null, decimals: rug.decimals, checkedAt: rug.checkedAt, source: rug.source };
        if (!rug.pass) { reject(state, book, row, 'rug-check: ' + rug.reason); continue; }
        const E = book.entry || {};
        // t86u v3: top-10 holders (Solana RPC largest accounts, pool/AMM/burn excluded), fail closed.
        if (E.maxTop10Pct != null && E.maxLiquidityUsd != null) {
          const tt = top10 ? await top10.check(row.mint, row.pairAddress, nowFn()) : { ok: false, reason: 'top10: no checker configured' };
          if (!tt.ok) { countFilter(state, book, 'top10Unavailable'); reject(state, book, row, 'top10: unavailable (' + (tt.reason || 'error') + ')'); continue; }
          Object.assign(fields, { top10Pct: tt.top10Pct, top10MaxHolderPct: tt.maxHolderPct, top10ExcludedPct: tt.excludedPct });
          if (tt.top10Pct > E.maxTop10Pct) { countFilter(state, book, 'top10'); reject(state, book, row, 'top10: ' + tt.top10Pct.toFixed(1) + '% > ' + E.maxTop10Pct + '%'); continue; }
        }
        let holder = null;
        if (E.lpLockedMinPct != null) {
          // v2: LP lock/burn + holder concentration (RugCheck), fail closed.
          const hc = holderCheck ? await holderCheck.check(row.mint, row.pairAddress, E, t) : { pass: false, reason: 'lp: no holder check configured' };
          holder = { pass: hc.pass, reason: hc.reason, lpLockedPct: hc.lpLockedPct, top10Pct: hc.top10Pct, maxHolderPct: hc.maxHolderPct, maxHolderOwner: hc.maxHolderOwner, creator: hc.creator, creatorPct: hc.creatorPct, checkedAt: hc.checkedAt, source: hc.source };
          if (curV2) Object.assign(curV2, { lpLockedPct: hc.lpLockedPct == null ? null : hc.lpLockedPct, top10Pct: hc.top10Pct == null ? null : hc.top10Pct, maxHolderPct: hc.maxHolderPct == null ? null : hc.maxHolderPct, creatorPct: hc.creatorPct == null ? null : hc.creatorPct, holderCheckSource: hc.source || null });
          if (!hc.pass) { reject(state, book, row, hc.reason, { holderCheck: holder }); continue; }
        }
        const buy = await quotes.buyQuote(row.mint, C.sizeSol);
        if (!buy.ok) { reject(state, book, row, buy.noRoute ? 'no buy route' : 'buy quote failed', { error: buy.error }); continue; }
        const sell = await quotes.sellQuote(row.mint, buy.outAmount);
        if (!sell.ok) { reject(state, book, row, sell.noRoute ? 'no sell route' : 'sell-route quote failed', { error: sell.error }); continue; }
        const t2 = nowFn();
        if (!quoteFresh(buy, t2, C.maxPriceAgeSec)) { reject(state, book, row, 'stale buy quote (> ' + C.maxPriceAgeSec + 's)'); continue; }
        const lamportsIn = Number(buy.inAmount);
        const roundTripPct = (Number(sell.outAmount) / lamportsIn - 1) * 100;
        if (curV2) Object.assign(curV2, { roundTripPct: +roundTripPct.toFixed(3), buyImpactPct: buy.priceImpactPct, sellImpactPct: sell.priceImpactPct });
        const maxRt = E.maxRoundTripLossPct != null ? E.maxRoundTripLossPct : C.maxRoundTripLossPct;
        if (roundTripPct < -maxRt) { reject(state, book, row, (E.maxRoundTripLossPct != null ? 'impact: ' : '') + 'round trip ' + roundTripPct.toFixed(1) + '%'); continue; }
        if (E.maxSellImpactPct != null && !(Number(sell.priceImpactPct) <= E.maxSellImpactPct)) { reject(state, book, row, 'impact: sell quote impact > ' + E.maxSellImpactPct + '%', { sellImpactPct: sell.priceImpactPct }); continue; }
        const tokensUi = Number(buy.outAmount) / 10 ** rug.decimals;
        const fillSolPerToken = C.sizeSol / tokensUi;
        const quoteGapPct = row.priceNative > 0 ? (fillSolPerToken / row.priceNative - 1) * 100 : null;
        if (quoteGapPct != null && quoteGapPct > C.maxQuoteGapPct) { reject(state, book, row, 'Jupiter fill ' + quoteGapPct.toFixed(1) + '% over DexScreener price'); continue; }
        const at = new Date(t2).toISOString();
        const pos = {
          id: 'bk-' + t2 + '-' + Math.random().toString(36).slice(2, 7),
          book: book.id, bookName: book.name, bookVersion: book.version, strategyId: book.id, strategyName: book.name + ' v' + book.version, strategyVersion: label(book),
          legacy: false, symbol: row.symbol, name: row.name, mint: row.mint, pairAddress: row.pairAddress, dexId: row.dexId,
          entryTime: at, sizeSol: C.sizeSol, decimals: rug.decimals,
          tokensRaw: String(buy.outAmount), tokensRemainingRaw: String(buy.outAmount), remainingFrac: 1, costBasisRemainingSol: C.sizeSol,
          entryPrice: fillSolPerToken, entryPriceUnit: 'SOL/token (Jupiter fill)', entryPriceUsdDexscreener: row.priceUsd, entryQuoteGapPct: quoteGapPct == null ? null : +quoteGapPct.toFixed(3),
          entryQuote: { side: 'buy', inMint: 'SOL', inAmount: buy.inAmount, outAmount: buy.outAmount, priceImpactPct: buy.priceImpactPct, route: buy.route, at: new Date(buy.at).toISOString() },
          entrySellCheck: { inAmount: sell.inAmount, outAmount: sell.outAmount, priceImpactPct: sell.priceImpactPct, roundTripPct: +roundTripPct.toFixed(3), at: new Date(sell.at).toISOString() },
          entrySignal: fields, rugCheck, holderCheck: holder, exit: book.exit,
          markPct: +roundTripPct.toFixed(3), peakPct: +roundTripPct.toFixed(3), markSource: 'jupiter-sell-quote', markAt: new Date(sell.at).toISOString(),
          legs: [], partialDone: false, noRouteSince: null
        };
        // Re-check after the awaits above (quotes): never push a second holding of the same mint.
        const heldLate = heldMint(state, row);
        if (heldLate) { sameMintCount(state, book.id); reject(state, book, row, REASON_SAME_MINT, { detail: heldLate.detail, heldBy: heldLate.heldBy, late: true }); continue; }
        b.open.push(pos);
        state.balance -= C.sizeSol;
        b.entries.opened++;
        if (book.entry && book.entry.maxLiquidityUsd != null) filterStats(state, book).entered++;
        if (book.id === 'graduation-sniper' && b.gradSniper && book.version === b.gradSniper.version) {
          b.gradSniper.entries++;
          pos.v2Checks = Object.assign({}, curV2);
          gradLog(state, Object.assign({ symbol: row.symbol, mint: row.mint, pairAddress: row.pairAddress }, curV2, { result: 'entered', positionId: pos.id }));
        }
        if (log) log('ENTRY', row.symbol, label(book) + ' size ' + C.sizeSol + ' SOL, Jupiter fill, impact ' + buy.priceImpactPct + '%, round trip ' + roundTripPct.toFixed(2) + '%');
      }
    });
  }

  function closeTrade(state, pos, reason, t) {
    const b = ensure(state);
    const pnlSol = pos.legs.reduce((a, l) => a + l.pnlSol, 0);
    const trade = Object.assign({}, pos, {
      exitReason: reason, closedAt: new Date(t).toISOString(), holdMinutes: +((t - Date.parse(pos.entryTime)) / MIN).toFixed(2),
      pnlSol: +pnlSol.toFixed(9), pnlPct: +((pnlSol / pos.sizeSol) * 100).toFixed(3), costPctRoundTrip: config.costRoundtripPct,
      exitQuote: pos.legs.length ? pos.legs[pos.legs.length - 1].quote : null,
      exitPrice: pos.legs.length ? pos.legs[pos.legs.length - 1].fillSolPerToken : 0
    });
    b.open = b.open.filter(p => p.id !== pos.id);
    if (pos.book === 'graduation-sniper' && b.gradSniper && pos.bookVersion === b.gradSniper.version) b.gradSniper.closes++;
    b.trades.unshift(trade);
    if (b.trades.length > 3000) b.trades.length = 3000;
    reentry.recordExit(state, trade, config, t);
    const live = C.list.find(x => x.id === pos.book);
    const LE = (live && live.entry) || {};
    if (LE.stopCooldownHours && stopFills.isStop(reason)) {
      // t86u: no re-buy of a coin for 24 h after it stops out (mint and pool), persisted in state.
      const m = state.stopCooldowns || (state.stopCooldowns = {});
      const until = new Date(t + LE.stopCooldownHours * 3600000).toISOString();
      for (const k of ['mint:' + pos.mint, 'pair:' + pos.pairAddress]) m[k] = { until, symbol: pos.symbol, at: trade.closedAt, reason: 'stopCooldown24h', book: pos.book };
      for (const k of Object.keys(m)) if (Date.parse(m[k].until) <= t) delete m[k];
    }
    if (LE.lossStreakPause) {
      const g = guard(state);
      g.streak[pos.book] = trade.pnlSol < 0 ? (g.streak[pos.book] || 0) + 1 : 0;
      if (g.streak[pos.book] >= LE.lossStreakPause.losses) {
        const until = new Date(t + LE.lossStreakPause.minutes * MIN).toISOString();
        g.pausedUntil[pos.book] = until;
        g.pauses = [{ book: pos.book, at: trade.closedAt, until, streak: g.streak[pos.book], lastSymbol: pos.symbol }].concat(g.pauses).slice(0, 30);
        g.streak[pos.book] = 0;
        if (log) log('PAUSE', pos.symbol, pos.book + ' ' + LE.lossStreakPause.losses + ' losses in a row: no new entries until ' + until);
      }
    }
    if (saveTrade) saveTrade(trade);
    if (log) log('EXIT', pos.symbol, pos.strategyVersion + ' ' + reason + ' pnl ' + trade.pnlSol.toFixed(5) + ' SOL (' + trade.pnlPct.toFixed(2) + '%)');
    return trade;
  }
  // One sell leg at a quote (q null = total loss: nothing comes back).
  function bookLeg(state, pos, reason, tokensRaw, q, t) {
    const frac = Number(BigInt(tokensRaw)) / Number(BigInt(pos.tokensRaw));
    const basis = pos.sizeSol * frac;
    const solOut = q ? Number(q.outAmount) / 1e9 : 0;
    const cost = basis * (config.costRoundtripPct / 100);
    const leg = { reason, at: new Date(t).toISOString(), sellPctOfOriginal: +(frac * 100).toFixed(3), tokensRaw: String(tokensRaw), basisSol: +basis.toFixed(9), solOut: +solOut.toFixed(9), costSol: +cost.toFixed(9),
      pnlSol: +(solOut - basis - cost).toFixed(9), fillSolPerToken: tokensRaw === '0' ? 0 : solOut / (Number(tokensRaw) / 10 ** pos.decimals),
      quote: q ? { side: 'sell', inAmount: q.inAmount, outAmount: q.outAmount, outMint: 'SOL', priceImpactPct: q.priceImpactPct, route: q.route, at: new Date(q.at).toISOString(), ageSec: +((t - q.at) / 1000).toFixed(1) } : { totalLoss: true } };
    pos.legs.push(leg);
    state.balance += solOut - cost;
    const left = BigInt(pos.tokensRemainingRaw) - BigInt(tokensRaw);
    pos.tokensRemainingRaw = String(left > 0n ? left : 0n);
    pos.remainingFrac = Number(BigInt(pos.tokensRemainingRaw)) / Number(BigInt(pos.tokensRaw));
    pos.costBasisRemainingSol = +(pos.sizeSol * pos.remainingFrac).toFixed(9);
    return leg;
  }

  // One exit pass: re-quote every open book position (Jupiter sell quote for the tokens held) and act.
  // One exit pass over the open book positions (no lock: callers hold it). PR14 (Liviu t72u): exit
  // decisions only on a Jupiter sell quote <= maxExitQuoteAgeSec (10 s) old; a missing route books a total
  // loss only after noRouteConsecutive (5) consecutive no-route answers spanning >= noRouteTotalLossMin;
  // every stop exit is logged in state.stopFills (stop level, last check before the trigger, fill, overshoot).
  async function runExitsInner(state, hooks) {
    const b = ensure(state);
    const maxAge = C.maxExitQuoteAgeSec || 10;
    let changed = false;
    for (const pos of b.open.slice()) {
      const ex = pos.exit;
      let q = await quotes.sellQuote(pos.mint, pos.tokensRemainingRaw);
      let t = nowFn();
      const minsOpen = (t - Date.parse(pos.entryTime)) / MIN;
      pos.quoteChecks = (pos.quoteChecks || 0) + 1;
      if (!q.ok) {
        pos.quoteFailures = (pos.quoteFailures || 0) + 1;
        pos.lastQuoteError = String(q.error || '').slice(0, 80);
        if (q.noRoute) {
          pos.noRouteCount = (pos.noRouteCount || 0) + 1;
          if (!pos.noRouteSince) pos.noRouteSince = new Date(t).toISOString();
          if (pos.noRouteCount >= (C.noRouteConsecutive || 5) && t - Date.parse(pos.noRouteSince) >= C.noRouteTotalLossMin * MIN) { bookLeg(state, pos, 'no-route-total-loss', pos.tokensRemainingRaw, null, t); closeTrade(state, pos, 'no-route-total-loss', t); changed = true; }
        } else if (minsOpen >= ex.maxHoldMinutes + C.noQuoteAfterMaxHoldMin) { bookLeg(state, pos, 'no-quote-total-loss', pos.tokensRemainingRaw, null, t); closeTrade(state, pos, 'no-quote-total-loss', t); changed = true; }
        continue;
      }
      pos.noRouteSince = null; pos.noRouteCount = 0;
      if (!quoteFresh(q, t, maxAge)) { pos.staleQuoteRefusals = (pos.staleQuoteRefusals || 0) + 1; continue; }
      // Graduation sniper v2: a >= confirmDropPct drop vs the previous check (or > confirmImpactPct impact) is
      // never booked off one quote. Re-quote the full amount (plus a small probe) confirmDelayMs later and
      // decide/book from that second quote.
      let confirm = null;
      const gcf = pos.book === 'graduation-sniper' ? ((C.list.find(x => x.id === 'graduation-sniper') || {}).exit || {}) : {};
      if (gcf.confirmDropPct) {
        const pct1 = (Number(q.outAmount) / 1e9 / pos.costBasisRemainingSol - 1) * 100;
        const prev = pos.lastCheck;
        const rel = (p0, p1) => ((1 + p1 / 100) / (1 + p0 / 100) - 1) * 100;
        const drop1 = prev ? rel(prev.pct, pct1) : null;
        if ((drop1 != null && drop1 <= -gcf.confirmDropPct) || Number(q.priceImpactPct) > gcf.confirmImpactPct) {
          const g = ensure(state).gradSniper;
          await sleepFn(gcf.confirmDelayMs || 4000);
          const q2 = await quotes.sellQuote(pos.mint, pos.tokensRemainingRaw);
          const probeRaw = (BigInt(pos.tokensRemainingRaw) * BigInt(Math.round((gcf.confirmProbeFrac || 0.1) * 10000))) / 10000n;
          const pq = probeRaw > 0n ? await quotes.sellQuote(pos.mint, String(probeRaw)) : null;
          const t2 = nowFn();
          const ok2 = q2 && q2.ok && quoteFresh(q2, t2, maxAge);
          const pct2 = ok2 ? (Number(q2.outAmount) / 1e9 / pos.costBasisRemainingSol - 1) * 100 : null;
          const drop2 = ok2 && prev ? rel(prev.pct, pct2) : null;
          const probeBasis = pos.costBasisRemainingSol * (Number(probeRaw) / Number(BigInt(pos.tokensRemainingRaw)));
          confirm = {
            at: new Date(t2).toISOString(), symbol: pos.symbol, mint: pos.mint, strategyVersion: pos.strategyVersion, delayMs: gcf.confirmDelayMs || 4000,
            previousCheck: prev ? { at: prev.at, pct: prev.pct } : null,
            firstQuote: { outAmount: q.outAmount, pct: +pct1.toFixed(3), dropVsPrevPct: drop1 == null ? null : +drop1.toFixed(3), priceImpactPct: q.priceImpactPct, at: new Date(q.at).toISOString() },
            confirmQuote: ok2 ? { outAmount: q2.outAmount, pct: +pct2.toFixed(3), dropVsPrevPct: drop2 == null ? null : +drop2.toFixed(3), priceImpactPct: q2.priceImpactPct, at: new Date(q2.at).toISOString() } : { ok: false, error: q2 && q2.error ? String(q2.error).slice(0, 80) : 'stale or failed' },
            probeQuote: pq && pq.ok ? { tokensRaw: String(probeRaw), outAmount: pq.outAmount, pct: probeBasis > 0 ? +((Number(pq.outAmount) / 1e9 / probeBasis - 1) * 100).toFixed(3) : null, priceImpactPct: pq.priceImpactPct } : null,
            confirmed: ok2 ? ((drop2 != null && drop2 <= -gcf.confirmDropPct) || Number(q2.priceImpactPct) > gcf.confirmImpactPct) : false
          };
          if (g) { g.confirmsTriggered++; if (confirm.confirmed) g.confirmsConfirmed++; g.confirms = [confirm].concat(g.confirms).slice(0, 30); }
          pos.lastConfirm = confirm;
          if (log) log('CONFIRM', pos.symbol, pos.strategyVersion + ' large drop re-quoted: first ' + confirm.firstQuote.pct + '%, second ' + (ok2 ? confirm.confirmQuote.pct + '%' : 'failed') + ', confirmed ' + confirm.confirmed);
          if (!ok2) { changed = true; continue; }                           // nothing booked off a single quote
          q = q2; t = t2;
        }
      }
      const pct = (Number(q.outAmount) / 1e9 / pos.costBasisRemainingSol - 1) * 100;
      const tokensUi = Number(pos.tokensRemainingRaw) / 10 ** (pos.decimals || 0);
      const price = tokensUi > 0 ? Number(q.outAmount) / 1e9 / tokensUi : null;
      const prevCheck = pos.lastCheck || null;
      if (hooks && hooks.onCheck) hooks.onCheck(pos, prevCheck, t);
      pos.lastCheck = { at: new Date(t).toISOString(), pct: +pct.toFixed(3), price, quoteAgeSec: +((t - q.at) / 1000).toFixed(2), priceImpactPct: q.priceImpactPct };
      pos.markPct = +pct.toFixed(3);
      pos.peakPct = Math.max(num(pos.peakPct), pos.markPct);
      pos.markAt = new Date(q.at).toISOString();
      pos.markSource = 'jupiter-sell-quote';
      pos.lastQuote = { inAmount: q.inAmount, outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, at: pos.markAt };
      changed = true;
      const d = decideExit(pos, ex, pct, pos.peakPct, minsOpen);
      if (!d) continue;
      if (d.action === 'partial') {
        const part = (BigInt(pos.tokensRaw) * BigInt(Math.round(d.sellPct * 10000))) / 1000000n;
        const pq = part > 0n ? await quotes.sellQuote(pos.mint, String(part)) : null;
        const t3 = nowFn();
        if (!pq || !quoteFresh(pq, t3, maxAge)) continue; // retry next pass
        bookLeg(state, pos, 'partial-tp', String(part), pq, t3);
        pos.partialDone = true;
        if (log) log('PARTIAL', pos.symbol, pos.strategyVersion + ' sold ' + d.sellPct + '% at +' + pct.toFixed(1) + '%');
        continue;
      }
      bookLeg(state, pos, d.reason, pos.tokensRemainingRaw, q, t);
      if (stopFills.isStop(d.reason)) {
        const netPct = (pos.legs.reduce((a, l) => a + l.pnlSol, 0) / pos.sizeSol) * 100;
        pos.stopFill = stopFills.record(state, stopFills.build({ pos, strategyId: pos.book, strategyVersion: pos.strategyVersion, stopLevelPct: ex.stopLossPct, entryPriceSolPerToken: pos.entryPrice,
          prevCheck, fill: { price, pct, quoteAgeSec: (t - q.at) / 1000, priceImpactPct: q.priceImpactPct }, netPnlPct: netPct,
          liquidityUsd: pos.lastLiquidityUsd != null ? pos.lastLiquidityUsd : (pos.entrySignal && pos.entrySignal.liquidityUsd), now: t }));
        if (confirm) Object.assign(pos.stopFill, { firstQuote: confirm.firstQuote, confirmQuote: confirm.confirmQuote, probeQuote: confirm.probeQuote, confirmed: confirm.confirmed });
      }
      if (confirm) pos.exitConfirm = confirm;
      closeTrade(state, pos, d.reason, t);
    }
    return changed;
  }
  // t85u epoch switch: close one open book position now at a fresh Jupiter sell quote (paper close).
  async function closeNowInner(state, pos, reason) {
    const b = ensure(state);
    if (!b.open.includes(pos)) return null;
    const q = await quotes.sellQuote(pos.mint, pos.tokensRemainingRaw);
    const t = nowFn();
    if (!q || !q.ok || !quoteFresh(q, t, C.maxExitQuoteAgeSec || 10)) { pos.closeNowFailures = (pos.closeNowFailures || 0) + 1; return null; }
    pos.markPct = +((Number(q.outAmount) / 1e9 / pos.costBasisRemainingSol - 1) * 100).toFixed(3);
    bookLeg(state, pos, reason, pos.tokensRemainingRaw, q, t);
    return closeTrade(state, pos, reason, t);
  }
  function runExits(state, hooks) { return locked(() => runExitsInner(state, hooks)); }

  function report(state) {
    const b = ensure(state);
    const t = nowFn();
    return C.list.map(book => {
      const all = b.trades.filter(x => x.book === book.id);
      const trades = all.filter(x => (x.bookVersion || 1) === book.version);   // stats per version (v1 kept below)
      const open = b.open.filter(x => x.book === book.id);
      const prevVers = [...new Set(all.map(x => x.bookVersion || 1).filter(v => v !== book.version))].sort();
      const previousVersions = prevVers.map(v => Object.assign({ label: book.id + ' v' + v, version: v }, bookStats(all.filter(x => (x.bookVersion || 1) === v), [], C.targetTrades)));
      return Object.assign({ strategyId: book.id, name: book.name, version: book.version, label: label(book), paused: !!book.paused || !allowed(book.id), status: (book.paused || !allowed(book.id)) ? 'paused' : 'active', sizeSol: C.sizeSol, stratSizeMult: 1, maxOpen: C.maxOpenPerBook, entry: book.entry, exit: book.exit },
        bookStats(trades, open, C.targetTrades),
        { open: open.map(p => ({ symbol: p.symbol, mint: p.mint, entryTime: p.entryTime, markPct: p.markPct, peakPct: p.peakPct, markSource: p.markSource, markAt: p.markAt, markAgeSec: p.markAt ? +((t - Date.parse(p.markAt)) / 1000).toFixed(1) : null, remainingFrac: p.remainingFrac, partialDone: p.partialDone })),
          firstEntries: trades.slice(-3).reverse().map(x => ({ symbol: x.symbol, entryTime: x.entryTime, exitReason: x.exitReason, pnlPct: x.pnlPct })).concat(open.slice(0, 2).map(p => ({ symbol: p.symbol, entryTime: p.entryTime, open: true }))),
          rejects: b.rejects.byBook[book.id] || {}, previousVersions, previousConfigs: book.previousVersions || [], allowed: allowed(book.id),
          epochStats: state.scoreboard && state.scoreboard.since ? bookStats(all.filter(x => Date.parse(x.closedAt) >= Date.parse(state.scoreboard.since)), open, C.targetTrades) : null,
          entryFilters: b.entryFilters[book.id] || null,
          guardrail: book.entry && book.entry.lossStreakPause ? { lossStreak: guard(state).streak[book.id] || 0, losses: book.entry.lossStreakPause.losses, pauseMinutes: book.entry.lossStreakPause.minutes, pausedUntil: lossPaused(state, book.id, t) } : null,
          v2: book.id === 'graduation-sniper' && b.gradSniper ? gradView(b.gradSniper) : undefined });
    });
  }
  function gradView(g) {
    return { label: g.label, since: g.since, candidates: g.candidates, rejectsByCategory: g.rejectsByCategory,
      rejectedMintsByCategory: Object.fromEntries(Object.entries(g.rejectedMintsByCategory).map(([k, v]) => [k, v.length])),
      rejectsByReason: g.rejectsByReason, entries: g.entries, closes: g.closes, confirmsTriggered: g.confirmsTriggered, confirmsConfirmed: g.confirmsConfirmed, confirms: g.confirms.slice(0, 10), candidateLog: (g.candidateLog || []).slice(0, 30) };
  }
  function lockedSol(state) { return ensure(state).open.reduce((a, p) => a + num(p.costBasisRemainingSol), 0); }

  return { ensure, heldMint, rejectLegacy, closeNowInner, allowed, guard, lossPaused, filterStats, runEntries, runExits, runExitsInner, report, lockedSol, stockBlock, recordSnaps, signals, locked, gradView: state => (ensure(state).gradSniper ? gradView(ensure(state).gradSniper) : null) };
}

module.exports = { makeBooks, entryFails, decideExit, quoteFresh, bookStats, high24Estimate, dropFromHighPct, m5VolumeVsHourAvg, isPumpOrigin, label };
