require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.15,
  maxOpen: 4,                   // PR7: 3 -> 4 with the four books unpaused; 1 slot reserved for dip-hold
  slotReserve: {},              // t83u: dip-hold paused -> no reserved legacy slot (was { 'dip-hold': 1 })
  maxPoolDivergencePct: 5,      // skip a buy when the chosen pool is >5% off the token's main pool
  dailyLossLimitSol: 0.2,
  fullStopBalance: 2.5,
  pauseAfterTrades: 8,          // manager: a strategy net negative after this many trades trades at half size (never paused)
  minPositionSol: 0.02,         // size floor after manager cuts
  reentryCooldownMin: 45,       // no re-entry on the same token (mint / pool) for 45 min after any exit
  costRoundtripPct: 1.1,
  brokenGapPct: 15,
  // t85u (Liviu 22 Nov 09:30, explicit): truly one strategy. Only these ids may open (books AND legacy), on top
  // of the paused flags. Leftover positions of every other strategy are closed at a Jupiter sell quote before
  // the runner-v2 board starts (books.epochCloseout).
  onlyStrategies: ['runner-hunter'],

  // PR11 (Liviu t64u, 21 Nov): four aggressive PAPER books, side by side, same size, own capacity.
  // Fills and marks come only from Jupiter quotes (read-only quote API, never a swap).
  books: {
    epoch: 'runner-v2',           // t85u: fresh runner-hunter board (books-v1 since 21 Nov 18:42 London archived, kept in scoreboardHistory)
    epochCloseout: true,          // t85u: close non-onlyStrategies leftovers (paper, Jupiter sell quote) before the board starts
    sizeSol: 0.05,                // SAME size per trade for every book (manager never cuts the books)
    maxOpenPerBook: 2,            // own capacity per book, separate from the legacy maxOpen 4
    targetTrades: 30,             // report each book after 30 trades
    maxPriceAgeSec: 30,           // never act on a scan row or a quote older than 30 s
    exitLoopMs: 5000,             // PR14 target period of the exit loop (ALL open trades, legacy + books)
    exitQuotesPerMin: 52,         // PR14 Jupiter quotes/min the exit loop may use (bucket max ~55, limiter-enforced); more opens -> longer period
    maxExitQuoteAgeSec: 10,       // PR14 exit decisions only on a Jupiter sell quote <= 10 s old
    noRouteConsecutive: 5,        // PR14 no-route total loss needs 5 consecutive no-route answers AND noRouteTotalLossMin
    maxEntriesPerTick: 4,
    maxRoundTripLossPct: 10,      // skip a buy whose immediate Jupiter buy->sell round trip loses more
    maxQuoteGapPct: 15,           // skip a buy whose Jupiter fill is >15% worse than the DexScreener price
    noRouteTotalLossMin: 10,      // no sell route for 10 min -> book a total loss (never the last/entry price)
    noQuoteAfterMaxHoldMin: 10,   // no usable sell quote 10 min past max hold -> total loss
    list: [
      {
        // v2 (Liviu t76u): v1 lost ~100% three times (whale-held tokens dumped; LP was burned). v2 adds, fail
        // closed: LP >= 90% locked/burned + holder concentration (RugCheck report), pool age >= 3 min,
        // Jupiter round trip <= 8% loss and sell impact <= 5%; exits confirm a >= 50% one-check drop (or
        // > 50% impact) with a second quote 4 s later before booking. Core rules unchanged.
        // t83u (Liviu 22 Nov 06:46, explicit override of never-pause): only runner-hunter enters. paused = no new
        // entries; open positions are still marked and exited by the exit loop.
        id: 'graduation-sniper', name: 'Graduation sniper', version: 2, paused: true,
        entry: { pumpOrigin: true, minPoolAgeMin: 3, maxPoolAgeMin: 15, m5BuysGtSells: true, minLiquidityUsd: 30000,
          lpLockedMinPct: 90, maxTop10Pct: 30, maxSingleHolderPct: 10, maxCreatorPct: 5, maxRoundTripLossPct: 8, maxSellImpactPct: 5 },
        exit: { stopLossPct: 10, takeProfitPct: 40, trailAfterPct: 15, trailPct: 10, maxHoldMinutes: 60,
          confirmDropPct: 50, confirmImpactPct: 50, confirmDelayMs: 4000, confirmProbeFrac: 0.1 }
      },
      {
        // v2 (Liviu t85u, 22 Nov 09:30): at a 28% win rate a -12% stop with a +10% target cannot make money.
        // Entry unchanged. Exits on Jupiter sell quotes in the exit loop (5 s): stop -6%, sell 1/3 at +8%, trail
        // the remaining 2/3 8% below the highest mark since entry, max hold 4 h. 1.1% round trip pro rata per leg.
        id: 'runner-hunter', name: 'Runner hunter', version: 2,
        entry: { minVolumeToLiquidityH1: 0.10, minLiquidityUsd: 15000, minH1: 0, minM5: 0 },
        exit: { stopLossPct: 6, partial: { atPct: 8, sellPct: 33.3333 }, trailAfterPartial: true, trailPct: 8, maxHoldMinutes: 240 },
        previousVersions: [
          { version: 1, until: '2026-11-22', entry: { minVolumeToLiquidityH1: 0.10, minLiquidityUsd: 15000, minH1: 0, minM5: 0 },
            exit: { stopLossPct: 12, partial: { atPct: 10, sellPct: 20 }, trailAfterPartial: true, trailPct: 15, maxHoldMinutes: 240 } }
        ]
      },
      {
        id: 'volume-explosion', name: 'Volume explosion', version: 1, paused: true,   // t83u
        entry: { minM5VolumeVsHourAvg: 10, minVolumeM5Usd: 3000, minM5: 0, maxM5: 30, minPoolAgeMin: 60, minLiquidityUsd: 10000 },
        exit: { stopLossPct: 8, trailAfterPct: 10, trailPct: 6, maxHoldMinutes: 60 }
      },
      {
        id: 'trending-pullback', name: 'Trending pullback', version: 1, paused: true,   // t83u
        entry: { minH24: 100, minDropFromHighPct: 20, maxDropFromHighPct: 30, volumeRising: true, minLiquidityUsd: 20000 },
        exit: { stopLossPct: 10, takeProfitPct: 25, trailAfterPct: 15, trailPct: 5, maxHoldMinutes: 180 }
      }
    ]
  },
  strategies: [
    {
      id: 'aggressive-flow',
      name: 'Aggressive flow scalp',
      paused: true,             // PR13 (Liviu t68u, explicit override of never-pause for THIS book only): no new entries; open AF positions exit normally
      sizeMult: 0.25,           // PR9 (Liviu 17:56): quarter size (was 0.5 from PR7)
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 8000, maxLiquidityUsd: 2000000 },
      entry: [
        { field: 'buySellRatioH1', op: '>=', value: 0.9 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.08 },
        { field: 'm5', op: '>=', value: -3 }
      ],
      exit: { takeProfitPct: 5, stopLossPct: 4, maxHoldMinutes: 20, earlyFailAfterMin: 0 }
    },
    {
      id: 'momentum-entry',
      name: 'Momentum entry',
      paused: true,             // t83u (Liviu 22 Nov 06:46): only runner-hunter enters; open trades still exit
      sizeMult: 0.5,            // PR7 (Liviu 17:10): unpaused at half size
      universe: { minAgeDays: 0, maxAgeDays: 30, minLiquidityUsd: 15000 },
      entry: [
        { field: 'h1', op: '>=', value: 2 },
        { field: 'm5', op: '>=', value: 0 },
        { field: 'buySellRatioH1', op: '>=', value: 1.2 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.08 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 6, maxHoldMinutes: 25, earlyFailAfterMin: 0 }
    },
    {
      id: 'dip-buyers',
      name: 'Dip then buyers',
      paused: true,             // t83u: only runner-hunter enters
      sizeMult: 0.5,            // PR7 (Liviu 17:10): unpaused at half size
      universe: { minAgeDays: 1, maxAgeDays: 45, minLiquidityUsd: 20000, maxLiquidityUsd: 400000 },
      entry: [
        { field: 'h1', op: '<=', value: -4 },
        { field: 'h1', op: '>=', value: -12 },
        { field: 'm5', op: '>=', value: 0 },
        { field: 'buySellRatioH1', op: '>=', value: 1.4 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.06 }
      ],
      exit: { takeProfitPct: 7, stopLossPct: 6, maxHoldMinutes: 90, timeStopOnlyIfLoss: true, earlyFailAfterMin: 0, breakevenArmPct: 4, breakevenLockPct: 2.2 }
    },
    {
      id: 'buyer-turn',
      name: 'Buyers in control',
      paused: true,             // t83u: only runner-hunter enters; open trades still exit
      sizeMult: 0.5,            // PR7 (Liviu 17:10): unpaused at half size
      universe: { minAgeDays: 0.05, maxAgeDays: 60, minLiquidityUsd: 20000, maxLiquidityUsd: 800000 },
      entry: [
        { field: 'h1', op: '>=', value: -15 },
        { field: 'h1', op: '<=', value: 12 },
        { field: 'm5', op: '>=', value: -1 },
        { field: 'buySellRatioH1', op: '>=', value: 1.3 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.05 }
      ],
      exit: { takeProfitPct: 7, stopLossPct: 6, maxHoldMinutes: 90, earlyFailAfterMin: 0 }
    },
    {
      id: 'dip-hold',
      name: 'Dip and hold',
      paused: true,             // t83u: only runner-hunter enters; open trades still exit
      universe: { minAgeDays: 0.5, maxAgeDays: 60, minLiquidityUsd: 20000, maxLiquidityUsd: 500000 },
      entry: [
        { field: 'h1', op: '<=', value: -3 },
        { field: 'h1', op: '>=', value: -18 },
        { field: 'm5', op: '>=', value: 0 },
        { field: 'buySellRatioH1', op: '>=', value: 1.35 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.05 }
      ],
      exit: { takeProfitPct: 12, stopLossPct: 5, maxHoldMinutes: 90, timeStopOnlyIfLoss: true, earlyFailAfterMin: 0, breakevenArmPct: 6, breakevenLockPct: 4, trailAfterPct: 6, trailPct: 2.5 }
    }
  ]
};
