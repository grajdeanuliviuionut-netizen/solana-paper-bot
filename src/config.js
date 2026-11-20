require('dotenv').config();
const crypto = require('crypto');

const num = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? parseFloat(process.env[name]) : def);

// Entry grace (aggressive-flow, momentum-entry): all % triggers are measured from the actual entry
// fill (sell-quote PnL net of costs). For the first graceSec after entry only a hard stop at
// -hardStopPct can fire, so the entry spread/impact can't trip the normal SL or trail (iAgent was
// stopped 9s after entry at -5.9%). Normal SL / trail / TP start after the grace period.
const entryGrace = { graceSec: num('ENTRY_GRACE_SEC', 60), hardStopPct: num('ENTRY_HARD_STOP_PCT', 15) };

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Token mints that must never be traded.
const EXCLUDED_MINTS = {
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'Bonk',
  [SOL_MINT]: 'SOL',
  [USDC_MINT]: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT'
};

// Canonical mints of major tokens. Any other mint using one of these symbols is a clone.
// (Offline backstop; the rug gate also checks Jupiter's verified token list.)
const MAJOR_TOKENS = {
  wif: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  sol: SOL_MINT,
  wsol: SOL_MINT,
  usdc: USDC_MINT,
  usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  popcat: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  trump: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
  pengu: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
  fartcoin: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'
};

// ---- Execution cost / fill model (paper) ----
const fills = {
  dexFeePctPerSide: num('DEX_FEE_PCT', 0.25),     // pool LP fee each side
  baseSlippagePct: num('BASE_SLIPPAGE_PCT', 0.3), // latency/noise slippage each side
  stopSlippageMult: num('STOP_SLIPPAGE_MULT', 2.5), // stop-outs: 2-3x entry slippage
  stopDelayBlocks: num('STOP_DELAY_BLOCKS', 2),     // 1-2 block delay on stops
  failedExitRate: num('FAILED_EXIT_RATE', 0.075),   // 5-10% of exits fail first
  failedExitDelayBlocks: num('FAILED_EXIT_DELAY_BLOCKS', 2),
  useWorseOfQuote: process.env.USE_WORSE_OF_QUOTE !== 'false', // fill = worse of depth model and Jupiter quote
  blocksPer5m: 750,                                 // ~400ms slots
  minBlockVolPct: 0.05,                             // floor for per-block volatility
  // Flat per-transaction costs in SOL.
  baseFeeSol: num('BASE_FEE_SOL', 0.000005),
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0001),
  jitoTipSol: num('JITO_TIP_SOL', 0.0001)
};

// ---- Hard rug gate (fails closed) ----
const rugGate = {
  enabled: process.env.RUG_GATE !== 'off',
  cacheMs: 5 * 60 * 1000,
  requireMintRevoked: true,
  requireFreezeRevoked: true,
  minLpLockedPct: 90,
  top10MaxPct: 25,
  singleHolderMaxPct: 5,
  rejectRugged: true
};

const strategies = [
  {
    id: 'aggressive-flow',
    name: 'Aggressive flow scalp',
    type: 'simple',
    universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 50000, maxLiquidityUsd: 1000000 },
    entry: [
      { field: 'buySellRatioM5', op: '>=', value: 0.8 },
      // Batch2 (13:57, RA freeze exception): AF was 2/16, -0.061 SOL since 12:32. Only the top half of
      // passes by volume/liquidity: 0.52 = median volumeH1/liquidityUsd of the 16 AF entries since 12:32
      // (/api/trades?all=1 entryGates; was 0.03).
      // 14:05 RA follow-up: 0.52 -> 0.15 (median of the live AF-pass snapshot at 13:58, n=16).
      { field: 'volumeToLiquidity', op: '>=', value: 0.15 },
      { field: 'm5', op: '>=', value: -2 },
      // m5 buys > sells (DEX Screener txns.m5; missing data fails closed). h1 > 0 removed 16:04 (RA:
      // zero entries since 15:00; h1>0 was the top AF filter reject).
      { field: 'buysGtSellsM5', op: '>=', value: 1 }
    ],
    // PR5: same 2-scan up-tick confirmation as momentum.
    entryConfirm: { upTicks: 2 },
    // Batch1 (post-6pm): since 12:32 at 0.1 SOL, TP6 was never reached (best MFE +5.1% mid), trails armed at
    // +3 exited ~0%, and stop-outs had MFE <= 0 and bled for 13-17 min before -5.7%. Lower TP, tighter
    // trail, and a stall exit for trades that never went green.
    exit: { takeProfitPct: 4, stopLossPct: 5, trailAfterPct: 2.5, trailPct: 1.25, maxHoldMinutes: 25, judgeOn: 'sell-quote',
      stallAfterMin: 6, stallMaxPeakPct: 1, stallLossPct: 2.5, ...entryGrace },
    quoteSanity: { maxQuoteGapPct: 3 }, // batch1: observed entry gaps since 12:32 within -2.1..+1.4%; 3% cap (+ global 3% round trip)
    sizeSol: 0.02, // PR5 16:52: 0.05 -> 0.02 (SL 18 at avg -13%, held 42s). batch2: 0.1 -> 0.05
    maxOpen: 6
  },
  {
    id: 'momentum-entry',
    name: 'Momentum entry',
    type: 'simple',
    universe: { minAgeDays: 0, maxAgeDays: 14, minLiquidityUsd: 50000 },
    entry: [
      // 16:04 RA (zero entries since 15:00): h1 2 -> 1.5, m5 0.5 -> 0.3.
      { field: 'h1', op: '>=', value: 1.5 },
      { field: 'm5', op: '>=', value: 0.3 },
      // PR5 (16:52 loser-cut spec): m5 buys > sells (missing data fails closed).
      { field: 'buysGtSellsM5', op: '>=', value: 1 }
    ],
    // PR5: price must have risen on 2 consecutive scans before entry (src/entryConfirm.js).
    entryConfirm: { upTicks: 2 },
    // Time stop at maxHoldMinutes exits only when the position is under water (mid PnL < 0%);
    // otherwise a timeTrailPct trailing stop arms at max hold (high-water mark from that moment).
    // judgeOn 'sell-quote': TP/SL/trail/time triggers use the Jupiter sell quote at position size, net of tx costs.
    // From branch commit 98074ad (merged 15:07, RA lifted the momentum freeze): 10 of 25 session trades
    // hit the 40-min time exit at avg -3.3% while every TP came within 21 min -> max hold 25. Huss fell
    // through the 6% stop during the 60s grace (-9.05% at 69s) -> grace 30s with a 10% hard stop.
    // PR5 (16:52 loser-cut spec; 109 trades: SL avg -7.9% with MFE +0.7%, time exits avg -2.6% over
    // 21.7m, TPs avg +9.1% in 11.6m, 9 of 26 losers were up 3%+ first): max hold 25 -> 12; breakeven
    // lock (net peak +3% -> exit at +0.5%); early-failure exit (not +2% net by 6 min -> exit).
    exit: { takeProfitPct: 10, stopLossPct: 6, maxHoldMinutes: 12, timeStopOnlyIfLoss: true, timeTrailPct: 5, judgeOn: 'sell-quote', ...entryGrace,
      graceSec: num('MOMENTUM_GRACE_SEC', 30), hardStopPct: num('MOMENTUM_HARD_STOP_PCT', 10),
      breakevenArmPct: 3, breakevenLockPct: 0.5, earlyFailAfterMin: 6, earlyFailMinPeakPct: 2 },
    quoteSanity: { maxQuoteGapPct: 5 }, // entry |Jupiter vs model| cap for this strategy (global default 15)
    sizeSol: 0.2,
    maxOpen: 6
  },
  // New Coin Scout spec: /workspace/specs/ncs_fresh_momentum_v1.json
  {
    id: 'ncs_fresh_momentum_v1',
    name: 'NCS fresh momentum',
    type: 'ncs',
    universe: {
      pairAgeMinMin: 5, pairAgeMaxMin: 240, excludeBondingCurve: true,
      tokenFirstSeenMaxHours: 6, // spec universe.token_first_seen_max_hours (token creation time from Jupiter)
      tiers: {
        A: { minLiquidityUsd: 15000, sizeMult: 1.0 },
        B: { maxPairAgeMin: 60, minLiquidityUsd: 8000, sizeMult: 0.5 }
      }
    },
    entry: {
      m5Min: 3, m5Max: 40, h1Max: 300,
      minVolumeM5Usd: { A: 5000, B: 3000 },
      maxLiqDropVsPrevPct: 10,
      requirePrevLiqPoll: true, // spec: "liquidity.usd not down > 10% vs previous poll" needs a previous poll
      maxH1VolToLiq: 12, maxM5VolToLiq: 3,
      honeypot: { minTxnsM5: 20, minSellsM5: 3, maxBuySellRatioM5: 4 }
    },
    extraRug: {
      top10MaxPct: 30, singleHolderMaxPct: 10, // spec values; global gate is stricter and wins
      rejectDangerRisks: true, graphInsidersMax: 50,
      maxRugcheckToDexLiqRatioMin: 0.5,
      rejectCreatorRugHistory: true, // spec anti_rug_hard.creator_rug_history: reject
      // Spec names; matched as prefixes so RugCheck keys like confidentialTransferMint / pausableConfig hit too.
      token2022RejectExtensions: ['transferFeeConfig', 'transferHook', 'permanentDelegate', 'defaultAccountState',
        'nonTransferable', 'confidentialTransfer', 'pausable', 'mintCloseAuthority', 'scaledUiAmount', 'interestBearing']
    },
    exit: {
      stopLossPct: 12,
      // Batch1 (post-6pm): 3 of 6 NCS stop-outs were up >= +8.5% (mid) before collapsing to -32..-42%;
      // TP1 at +25% was reached once in 8. Lock profits from +8% net, take TP1 at +15%, trail 10% after.
      // (Deviates from specs/ncs_fresh_momentum_v1.json: TP1 25 -> 15, trail 15 -> 10, adds the lock.)
      takeProfits: [{ atPct: 15, sellPct: 50 }, { atPct: 60, sellPct: 100 }],
      trailAfterTp1Pct: 10, breakevenAfterTp1: true,
      lockAfterPct: 8, lockAtPct: 1,
      timeStop: { ifNotAbovePct: 5, afterMin: 15 },
      maxHoldMinutes: 30,
      emergency: { liqDropFromEntryPct: 30, zeroSellsMinBuysM5: 10 },
      judgeOn: 'sell-quote', // SL/TP1/TP2/trail/breakeven/time judged on the Jupiter sell quote, net of tx costs
      // Batch2 (13:57): 0/3 on 519d1125 with stops at 9-27s. Stop measured from the actual paper fill
      // (judged sell-quote PnL vs entryFillPrice) and, as for AF, the first 60s only a -15% hard stop
      // (emergency rug/liquidity exits stay active).
      stopFrom: 'fill', ...entryGrace
    },
    quoteSanity: { maxQuoteGapPct: 8 },
    // Tier A = base size (2% of equity), tier B = half of that (universe.tiers.*.sizeMult).
    // PR5 16:52 (SL 11 at avg -21.6%, held 66s): fixed 0.02 SOL for tier A and tier B (fixedSol overrides
    // the %-of-equity size and the tier sizeMult); entry only if the price is higher >= 20s after the
    // signal (delayed re-check, booked at that price).
    sizing: { basePctOfEquity: 2.0, maxPctOfPoolLiquidity: 1.0, maxTotalExposurePct: 10, fixedSol: 0.02 },
    entryConfirm: { delaySec: 20 },
    maxOpen: 5,
    reentryCooldownMinutes: 30,
    riskGuards: { dailyLossHaltPct: 8, consecutiveLosses: 5, pauseMinutes: 30 }
  }
];

// ---- Quote sanity (entry hard-reject + exit fallback). Not part of any configHash (like the rug
// gate's fail-closed plumbing / the denylist, it filters broken or drained pools, not strategy edge).
const quoteSanity = {
  maxPriceImpactPct: num('MAX_PRICE_IMPACT_PCT', 5),       // entry: Jupiter priceImpact above this = reject
  maxQuoteGapPct: num('MAX_QUOTE_GAP_PCT', 15),            // entry: |Jupiter vs model| above this = reject
  requireReverseRoute: process.env.QUOTE_REQUIRE_REVERSE !== '0', // entry: token->SOL quote must route
  maxExitPriceImpactPct: num('MAX_EXIT_PRICE_IMPACT_PCT', 50), // exit: above this the quote is "insane" -> model price
  maxExitQuoteGapPct: num('MAX_EXIT_QUOTE_GAP_PCT', 50),
  maxReverseImpactPct: num('MAX_REVERSE_IMPACT_PCT', 3),      // entry: token->SOL quote impact at size above this = reject
  // entry: buy at size then sell exactly those tokens back; losing more than this (fees + impact both
  // ways) = reject as quoteSanity:roundtrip
  maxRoundTripLossPct: num('MAX_ROUNDTRIP_LOSS_PCT', 3)
};
// Per-strategy overrides (strategy.quoteSanity, e.g. maxQuoteGapPct) on top of the global rules.
function quoteSanityFor(strat) {
  return Object.assign({}, quoteSanity, (strat && strat.quoteSanity) || {});
}

// Exit judging on Jupiter sell quotes (open positions are quoted on the ~10s exit loop).
const exitQuotes = {
  ttlMs: num('EXIT_QUOTE_TTL_MS', 9000),          // reuse a position's sell quote for this long
  maxPerLoop: num('EXIT_QUOTES_PER_LOOP', 5),     // Jupiter calls per exit loop (oldest quote first)
  maxAgeMs: num('EXIT_QUOTE_MAX_AGE_MS', 30000),  // older than this -> model fallback for judging
  // After a restart (empty quote cache) a position waits up to this long for its first real sell
  // quote before SL/trail/TP/time exits may fire on the model price. Hard stop and emergency
  // (rug/liquidity) exits may still fire on the model meanwhile (logged).
  firstQuoteWaitMs: num('EXIT_FIRST_QUOTE_WAIT_MS', 30000)
};

// ---- Operational per-strategy settings (pause / shadow / slots / priority). Kept OUT of the
// configHash on purpose: they decide whether and how many trades are taken, not the strategy's
// entry/exit/sizing rules, so they must not reset the 50-trade go-live counts.
// Lower priority number = served first for free slots. tierMaxOpen caps a tier inside the strategy.
const strategyOps = {
  // Re-enabled 2026-11-20 12:29 at half size behind the tighter quote filters (was shadow-only 11:40-12:29).
  // Policy: no strategy is paused or shadowed; sizes and filters are tuned while it trades. The shadow
  // code path stays for future use (set enabled:false, shadow:true).
  // 2026-11-20 12:48 slot allocation: aggressive-flow max 4 open, NCS max 2, momentum-entry gets a
  // reserve of 5 slots (allocator below). Over-cap positions are not force-closed; they only block
  // new entries of that strategy.
  'aggressive-flow': { enabled: true, priority: 3, maxOpen: 4 },
  // Batch2: momentum's allocator cap 8 -> 12 (bounded by the global cap): at 13:39-13:40 momentum was skipped
  // at its own 8/8 while the book had 11/12 open. Outside the configHash.
  'momentum-entry': { enabled: true, maxOpen: 12, priority: 1 },
  // NCS: spec sizing.max_concurrent_positions = 5 is kept; free slots go to tier A first (priority),
  // tier B is served after momentum-entry and tier A.
  ncs_fresh_momentum_v1: { enabled: true, tierPriority: { A: 1, B: 2 }, priority: 1, maxOpen: 2 }
};

// ---- Slot allocator (global cap, reserves, bumping). Outside every configHash, like strategyOps.
const allocator = {
  baseMaxOpen: 10,                                       // used when cash can't cover the raised cap
  targetMaxOpen: num('MAX_OPEN_TARGET', 12),             // raised global cap
  cashBufferSol: num('ALLOC_CASH_BUFFER_SOL', 0.5),      // cash left after filling the raised cap at max size
  reserve: { 'momentum-entry': 5 },                      // slots only this strategy may use
  // Book full + valid momentum signal: close the weakest aggressive-flow position at its sell quote
  // (exit reason 'bumped'), never one still inside its entry grace.
  bump: { for: ['momentum-entry'], victims: ['aggressive-flow'], minAgeSec: entryGrace.graceSec, maxPerTick: 2 }
};
// ---- Per-mint guards for ALL strategies (outside every configHash). See src/mintGuard.js.
const mintGuard = {
  stopCooldownMin: num('MINT_STOP_COOLDOWN_MIN', 120),  // no re-entry for 2h after a stop-type exit
  // Exit reasons counted as stop-losses: SL, hard stop (incl. entry-grace hard stop and the
  // awaiting-quote hard stop), stall, and the emergency (rug / liquidity / no-sells) exits.
  stopReasons: ['sl', 'hard-stop', 'stall', 'emergency-liq', 'emergency-nosells', 'emergency-rug'],
  // 16:04 RA: the 2-entries/day cap blocked every candidate after 15:00. Now: at most 2 LOSING trades
  // (net pnlSol after costs < 0) per mint per London day, across strategies; a mint whose last closed
  // trade was a winner may re-enter (still subject to the stop cooldown).
  maxLossesPerDay: num('MINT_MAX_LOSSES_PER_DAY', 2),
  brokenGapPct: 50,                                     // quote vs model gap that marks a broken quote
  // Known broken-quote mints (also found from trades/events/shadow history at startup).
  seedBrokenMints: [
    { mint: 'HmBGdetVsQTRHh2wCa4HykUpKA7NJ1B8S16tUpYiWeaZ', symbol: 'RUDY', reason: '11:29 drained pool: 99.99999% impact, quote 7.97e9% vs model' },
    { mint: 'GjFvarRNRrq5tL6K2qdY7Xv2ZEbVrstqjW1BW4hMpump', symbol: 'RUDY', reason: 'RA 15:07: broken/absurd quote history' }
  ]
};
const config = {
  // Build label only. Balance and open positions persist across builds (RESET_STATE=1 to start fresh);
  // go-live counts reset per strategy when its configHash changes.
  buildId: 'pr5-loser-cut-2026-11-20',
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: num('STARTING_SOL', 4),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  exitCheckMs: parseInt(process.env.EXIT_CHECK_MS || '10000', 10), // open positions re-priced every ~10s
  positionSizeSol: 0.2,
  maxOpen: 10,                 // global cap across strategies
  dailyLossLimitSol: 0.25,
  fullStopBalance: 1.5,         // compared with paper EQUITY (cash + open cost basis), not cash. 2.5 -> 1.5 on 2026-11-20 13:08 (RA freeze exception); outside every configHash
  costRoundtripPct: 1.1,       // legacy flat cost, kept for reference only (depth model is used)
  // Legacy strategies keep a $50k floor via their universe; the scan floor is the lowest tier.
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 50000),
  scanMinLiquidityUsd: num('SCAN_MIN_LIQUIDITY_USD', 8000),
  maxPairsPerScan: parseInt(process.env.MAX_PAIRS_PER_SCAN || '300', 10),
  defaultMaxHoldMinutes: 30,
  reentryCooldownMinutes: 15,
  goLiveTradeTarget: 50,
  liqDropAlertPct: 50,
  solMint: SOL_MINT,
  usdcMint: USDC_MINT,
  excludedMints: EXCLUDED_MINTS,
  majorTokens: MAJOR_TOKENS,
  fills,
  rugGate,
  quoteSanity,
  quoteSanityFor,
  exitQuotes,
  mintGuard,
  allocator,
  entryGrace,
  ncsRealisticStopPct: num('NCS_REALISTIC_STOP_PCT', -25), // /api/trades expectancy: NCS stop-outs re-priced at this
  strategyOps,
  strategies
};

// Config hash per strategy: strategy definition + everything that changes how its PnL is
// measured. The 50-trade go-live count only counts trades carrying the current hash.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
config.stableStringify = stableStringify;
config.configHashFor = strat => crypto.createHash('sha256')
  .update(stableStringify({ strat, fills, rugGate, minLiquidityUsd: config.minLiquidityUsd }))
  .digest('hex').slice(0, 12);
config.opsFor = id => Object.assign({ enabled: true, shadow: false, priority: 5 }, strategyOps[id] || {});
config.strategyHashes = Object.fromEntries(strategies.map(s => [s.id, config.configHashFor(s)]));

module.exports = config;
