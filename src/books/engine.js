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
  if (e.minLiquidityUsd && num(row.liquidityUsd) < e.minLiquidityUsd) return 'liquidity < ' + e.minLiquidityUsd;
  if (book.id === 'graduation-sniper') {
    if (e.pumpOrigin && !isPumpOrigin(row)) return 'not pump.fun origin';
    const age = poolAgeMin(row, now);
    if (age == null) return 'no pairCreatedAt';
    if (age > e.maxPoolAgeMin || age < 0) return 'pool older than ' + e.maxPoolAgeMin + 'm';
    const t = row.txnsM5 || {};
    if (e.m5BuysGtSells && !(num(t.buys) > num(t.sells))) return 'm5 buys <= sells';
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
function makeBooks({ config, quotes, mintAuth, reentry, log, saveTrade, now: clock }) {
  const C = config.books;
  const nowFn = clock || Date.now;
  let chain = Promise.resolve();
  const locked = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  function ensure(state) {
    if (!state.books || typeof state.books !== 'object') state.books = {};
    const b = state.books;
    if (!Array.isArray(b.open)) b.open = [];
    if (!Array.isArray(b.trades)) b.trades = [];
    if (!b.rejects) b.rejects = { byReason: {}, byBook: {}, recent: [] };
    if (!b.stockBlocks) b.stockBlocks = { count: 0, recent: [] };
    if (!b.snaps) b.snaps = {};
    if (!b.entries) b.entries = { attempts: 0, opened: 0 };
    return b;
  }
  function reject(state, book, row, reason, extra) {
    const b = ensure(state);
    const key = String(reason).replace(/[-\d.]+%?$/, '').trim();
    b.rejects.byReason[key] = (b.rejects.byReason[key] || 0) + 1;
    const bb = b.rejects.byBook[book ? book.id : 'all'] || (b.rejects.byBook[book ? book.id : 'all'] = {});
    bb[key] = (bb[key] || 0) + 1;
    b.rejects.recent = [Object.assign({ at: new Date(nowFn()).toISOString(), book: book ? label(book) : null, symbol: row && row.symbol, mint: row && row.mint, reason }, extra || {})].concat(b.rejects.recent).slice(0, 50);
    if (log) log('SKIP', row && row.symbol, (book ? label(book) + ' ' : '') + reason);
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
  }

  // extraByBook: { bookId: rows } extra candidate rows for one book only (PR13: new-pools feed rows
  // go to the graduation sniper only). onExtraPass(book, row) is called for each extra row that passes.
  function signals(state, pairs, extraByBook, onExtraPass) {
    const b = ensure(state), t = nowFn(), out = [];
    const ctx = { now: t, snaps: b.snaps };
    for (const book of C.list) {
      const extra = (extraByBook && extraByBook[book.id]) || [];
      const seen = new Set((pairs || []).map(r => r && r.mint));
      const extraOnly = extra.filter(r => r && !seen.has(r.mint));
      for (const r of extra) if (r && !entryFails(book, r, ctx) && onExtraPass) onExtraPass(book, r);
      for (const row of (pairs || []).concat(extraOnly)) {
        if (!row || !row.mint) continue;
        if (!entryFails(book, row, ctx)) out.push({ book, row, fields: signalFields(book, row, ctx) });
      }
    }
    return out;
  }

  // Entries for one tick. gate(sig) = PR9 main-pool check (async, fail closed).
  function runEntries(state, pairs, gate, extraByBook, onExtraPass) {
    return locked(async () => {
      const b = ensure(state);
      recordSnaps(state, pairs);
      const sigs = signals(state, pairs, extraByBook, onExtraPass);
      let tried = 0;
      for (const { book, row, fields } of sigs) {
        if (tried >= C.maxEntriesPerTick) break;
        const t = nowFn();
        const openHere = b.open.filter(p => p.book === book.id);
        if (openHere.length >= C.maxOpenPerBook) continue;                  // capacity: not a reject
        if (b.open.some(p => p.mint === row.mint)) continue;               // one book position per mint
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
        const rug = await mintAuth.check(row.mint);
        const rugCheck = { pass: rug.pass, reason: rug.reason, mintAuthority: rug.mintAuthority === undefined ? null : rug.mintAuthority, freezeAuthority: rug.freezeAuthority === undefined ? null : rug.freezeAuthority, program: rug.program || null, decimals: rug.decimals, checkedAt: rug.checkedAt, source: rug.source };
        if (!rug.pass) { reject(state, book, row, 'rug-check: ' + rug.reason); continue; }
        const buy = await quotes.buyQuote(row.mint, C.sizeSol);
        if (!buy.ok) { reject(state, book, row, buy.noRoute ? 'no buy route' : 'buy quote failed', { error: buy.error }); continue; }
        const sell = await quotes.sellQuote(row.mint, buy.outAmount);
        if (!sell.ok) { reject(state, book, row, sell.noRoute ? 'no sell route' : 'sell-route quote failed', { error: sell.error }); continue; }
        const t2 = nowFn();
        if (!quoteFresh(buy, t2, C.maxPriceAgeSec)) { reject(state, book, row, 'stale buy quote (> ' + C.maxPriceAgeSec + 's)'); continue; }
        const lamportsIn = Number(buy.inAmount);
        const roundTripPct = (Number(sell.outAmount) / lamportsIn - 1) * 100;
        if (roundTripPct < -C.maxRoundTripLossPct) { reject(state, book, row, 'round trip ' + roundTripPct.toFixed(1) + '%'); continue; }
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
          entrySignal: fields, rugCheck, exit: book.exit,
          markPct: +roundTripPct.toFixed(3), peakPct: +roundTripPct.toFixed(3), markSource: 'jupiter-sell-quote', markAt: new Date(sell.at).toISOString(),
          legs: [], partialDone: false, noRouteSince: null
        };
        b.open.push(pos);
        state.balance -= C.sizeSol;
        b.entries.opened++;
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
    b.trades.unshift(trade);
    if (b.trades.length > 3000) b.trades.length = 3000;
    reentry.recordExit(state, trade, config, t);
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
      const q = await quotes.sellQuote(pos.mint, pos.tokensRemainingRaw);
      const t = nowFn();
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
        const part = (BigInt(pos.tokensRaw) * BigInt(Math.round(d.sellPct * 100))) / 10000n;
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
      }
      closeTrade(state, pos, d.reason, t);
    }
    return changed;
  }
  function runExits(state, hooks) { return locked(() => runExitsInner(state, hooks)); }

  function report(state) {
    const b = ensure(state);
    const t = nowFn();
    return C.list.map(book => {
      const trades = b.trades.filter(x => x.book === book.id);
      const open = b.open.filter(x => x.book === book.id);
      return Object.assign({ strategyId: book.id, name: book.name, version: book.version, label: label(book), sizeSol: C.sizeSol, stratSizeMult: 1, maxOpen: C.maxOpenPerBook, entry: book.entry, exit: book.exit },
        bookStats(trades, open, C.targetTrades),
        { open: open.map(p => ({ symbol: p.symbol, mint: p.mint, entryTime: p.entryTime, markPct: p.markPct, peakPct: p.peakPct, markSource: p.markSource, markAt: p.markAt, markAgeSec: p.markAt ? +((t - Date.parse(p.markAt)) / 1000).toFixed(1) : null, remainingFrac: p.remainingFrac, partialDone: p.partialDone })),
          firstEntries: trades.slice(-3).reverse().map(x => ({ symbol: x.symbol, entryTime: x.entryTime, exitReason: x.exitReason, pnlPct: x.pnlPct })).concat(open.slice(0, 2).map(p => ({ symbol: p.symbol, entryTime: p.entryTime, open: true }))),
          rejects: b.rejects.byBook[book.id] || {} });
    });
  }
  function lockedSol(state) { return ensure(state).open.reduce((a, p) => a + num(p.costBasisRemainingSol), 0); }

  return { ensure, runEntries, runExits, runExitsInner, report, lockedSol, stockBlock, recordSnaps, signals, locked };
}

module.exports = { makeBooks, entryFails, decideExit, quoteFresh, bookStats, high24Estimate, dropFromHighPct, m5VolumeVsHourAvg, isPumpOrigin, label };
