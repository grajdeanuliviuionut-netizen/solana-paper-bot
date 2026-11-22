// t89u (Liviu 22 Nov 13:18): Executor agent, PAPER PATH ONLY. Nothing here builds, signs or sends a
// transaction; Jupiter and the Solana RPC are used read-only (quotes, getRecentPrioritizationFees).
//
// 1. Slippage limit (maxSlippageBps, 150 = 1.5%):
//    entry slippage = max(Jupiter buy priceImpactPct, Jupiter fill vs DexScreener reference price gap).
//    Over the limit -> the ENTRY is aborted ('Slippage Abort', counted).
//    EXITS are never aborted (a stop must always sell): exit slippage = Jupiter sell priceImpactPct; over the
//    limit -> the leg is booked anyway with slippageExceeded: true (counted), so a position can never get stuck.
// 2. Paper fill realism (exit.costModel on the position, so open positions keep the model they were bought with):
//    buy : tokens credited = Jupiter quote outAmount x (1 - simSlip), simSlip uniform 0.5-2.0%
//          + fee 0.5% of the SOL spent + priority fee (SOL)
//    sell: SOL received   = Jupiter quote outAmount x (1 - simSlip) x (1 - 3% if a stop-loss exit: sl / breakeven)
//          - fee 0.5% of the SOL received - priority fee (SOL)
//    This REPLACES the flat 1.1% round-trip cost for these positions (never both).
// 3. Priority fee: median microLamports/CU from getRecentPrioritizationFees for the traded POOL account (fees of
//    transactions that write-lock that pool, last ~150 slots; slots with 0 = no such tx are dropped - the global
//    call returns per-slot minimums that are all 0 on the public RPC), cached 45 s per pool, own limiter bucket. Charged per side as (baseFee 5000 lamports + microLamports x 200,000 CU / 1e6)
//    lamports. Assumed CU limit 200,000 (a typical Jupiter swap uses 100-300k CU). No non-zero fee / no answer /
//    RPC error -> a fallback of 50,000 microLamports/CU (documented, flagged fallback: true).
// 4. Send path: an interface with a paper sender (records only) and a Jito bundle stub (disabled, no-op) so
//    bundles can be added later. There is no live sender in this module.
const MICRO = 1e6;

function median(a) {
  const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function makePriorityFee(limiter, opts = {}) {
  const url = opts.url || process.env.BOOKS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const ttlMs = opts.ttlMs || 45000;
  const cuLimit = opts.cuLimit || 200000;
  const baseFeeLamports = opts.baseFeeLamports == null ? 5000 : opts.baseFeeLamports;
  const fallbackMicroLamports = opts.fallbackMicroLamports == null ? 50000 : opts.fallbackMicroLamports;
  const cache = new Map(), inFlight = new Map();   // key: pool account ('' = global)
  const stats = { calls: 0, ok: 0, errors: 0, lastError: null,
    method: 'getRecentPrioritizationFees([pool account]) - fees of txs that write-lock the traded pool, last ~150 slots; median of the non-zero slots (0 = slot without such a tx); none -> fallback; cached ' + Math.round(ttlMs / 1000) + ' s per pool',
    cuLimit, baseFeeLamports, fallbackMicroLamports, source: process.env.BOOKS_RPC_URL ? 'BOOKS_RPC_URL' : 'public mainnet-beta', last: null };
  async function refresh(account, now = Date.now()) {
    const key = account || '';
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      stats.calls++;
      try {
        const res = await limiter.post(opts.bucket || 'feerpc', url, { jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: key ? [[key]] : [] });
        const list = res && res.data && res.data.result;
        if (!Array.isArray(list) || !list.length) throw new Error('no result');
        const all = list.map(x => Number(x.prioritizationFee)).filter(Number.isFinite);
        const nz = all.filter(x => x > 0);
        const v = { at: new Date(now).toISOString(), atMs: now, account: key || 'global', slots: all.length, nonZeroSlots: nz.length, medianAllMicroLamports: median(all), medianNonZeroMicroLamports: nz.length ? median(nz) : null };
        cache.set(key, v); stats.ok++; stats.last = v;
        if (cache.size > 500) cache.delete(cache.keys().next().value);
      } catch (e) { stats.errors++; stats.lastError = String(e.message || e).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 80); }
      finally { inFlight.delete(key); }
      return cache.get(key) || null;
    })();
    inFlight.set(key, p);
    return p;
  }
  function view(v) {
    const fb = !v || v.medianNonZeroMicroLamports == null;
    const micro = fb ? fallbackMicroLamports : v.medianNonZeroMicroLamports;
    const lamports = baseFeeLamports + (micro * cuLimit) / MICRO;
    return { microLamports: micro, fallback: fb, fallbackReason: !v ? 'no answer yet' : fb ? 'no non-zero fee in the last ' + v.slots + ' slots' : null, account: v ? v.account : null, at: v ? v.at : null,
      medianAllMicroLamports: v ? v.medianAllMicroLamports : null, slots: v ? v.slots : 0, nonZeroSlots: v ? v.nonZeroSlots : 0, cuLimit, baseFeeLamports, lamports: Math.round(lamports), sol: +(lamports / 1e9).toFixed(9) };
  }
  // Never blocks: cached value (refreshed in the background when stale).
  function current(now = Date.now(), account) {
    const key = account || '';
    const v = cache.get(key);
    if (!v || now - v.atMs > ttlMs) refresh(key, now).catch(() => {});
    return view(v);
  }
  // Entries may wait for the pool's fee (rate-limited; errors -> cached/fallback).
  async function forAccount(account, now = Date.now()) {
    const key = account || '';
    const v = cache.get(key);
    if (!v || now - v.atMs > ttlMs) await refresh(key, now).catch(() => {});
    return current(now, key);
  }
  return { refresh, current, forAccount, stats };
}

// Uniform simulated adverse slippage in [min, max] %.
function simSlipPct(cm, random) { const r = (random || Math.random)(); return +(cm.simSlipMinPct + r * (cm.simSlipMaxPct - cm.simSlipMinPct)).toFixed(4); }

function entrySlippagePct(buy, quoteGapPct) {
  const imp = Number(buy && buy.priceImpactPct);
  return Math.max(Number.isFinite(imp) ? imp : 0, Number.isFinite(quoteGapPct) ? quoteGapPct : 0);
}

// Paper buy: returns tokens credited and the entry cost components (SOL).
function simBuy({ sizeSol, quoteOutRaw, cm, fee, random }) {
  const slip = simSlipPct(cm, random);
  const credited = (BigInt(quoteOutRaw) * BigInt(Math.round((1 - slip / 100) * 1e6))) / 1000000n;
  const feeSol = sizeSol * (cm.feePctPerSide / 100);
  const prio = cm.priorityFee ? fee : { sol: 0, microLamports: 0, fallback: false };
  return { tokensRaw: String(credited), costs: { side: 'buy', quoteFillRaw: String(quoteOutRaw), simSlipPct: slip, creditedRaw: String(credited), feeSol: +feeSol.toFixed(9),
    priorityFeeSol: prio.sol, priorityMicroLamports: prio.microLamports, priorityFallback: !!prio.fallback } };
}

// Paper sell leg: SOL received after simulated slippage (+ stop penalty) and the costs (fee, priority fee).
function simSell({ quoteOutLamports, cm, isStopLoss, fee, random }) {
  const quoteSol = Number(quoteOutLamports) / 1e9;
  const slip = simSlipPct(cm, random);
  const pen = isStopLoss ? cm.stopPenaltyPct : 0;
  const afterSlip = quoteSol * (1 - slip / 100);
  const solOut = afterSlip * (1 - pen / 100);
  const feeSol = solOut * (cm.feePctPerSide / 100);
  const prio = cm.priorityFee ? fee : { sol: 0, microLamports: 0, fallback: false };
  return { solOut, costs: { side: 'sell', quoteFillSol: +quoteSol.toFixed(9), simSlipPct: slip, simSlipSol: +(quoteSol - afterSlip).toFixed(9), stopPenaltyPct: pen, stopPenaltySol: +(afterSlip - solOut).toFixed(9),
    simFillSol: +solOut.toFixed(9), feeSol: +feeSol.toFixed(9), priorityFeeSol: prio.sol, priorityMicroLamports: prio.microLamports, priorityFallback: !!prio.fallback } };
}

// Send-path interface. Paper only: submit() records the intent and returns; nothing is signed or sent.
function makeSendPath(opts = {}) {
  const jito = { name: 'jito-bundle', enabled: false, note: 'stub: Jito bundles not implemented; disabled; never sends', submit: async () => ({ ok: false, sent: false, reason: 'jito stub disabled' }) };
  const paper = { name: 'paper', enabled: true, note: 'records the order only; no transaction is built, signed or sent', submit: async order => ({ ok: true, sent: false, simulated: true, path: 'paper', side: order && order.side }) };
  const stats = { paperOrders: 0, jitoAttempts: 0 };
  async function submit(order) {
    // Only the paper path exists. Jito stays a disabled stub (opts.jito is ignored on purpose: paper only).
    stats.paperOrders++;
    return paper.submit(order);
  }
  return { submit, paths: { paper, jito }, stats, mode: 'paper' };
}

const COST_MODEL_DOC = 'buy: Jupiter quote fill - simulated adverse slippage U(0.5%,2.0%) on tokens + 0.5% fee + priority fee; sell: Jupiter quote fill - U(0.5%,2.0%) - 3% more on stop-loss exits (sl, breakeven) - 0.5% fee - priority fee. Priority fee per side = (5000 + median microLamports x 200,000 CU / 1e6) lamports. Replaces the flat 1.1% round trip for these positions (leftovers keep 1.1%).';

module.exports = { makePriorityFee, makeSendPath, simBuy, simSell, simSlipPct, entrySlippagePct, median, COST_MODEL_DOC };
