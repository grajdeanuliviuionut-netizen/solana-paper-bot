require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.15,
  maxOpen: 4,                   // PR7: 3 -> 4 with the four books unpaused; 1 slot reserved for dip-hold
  slotReserve: { 'dip-hold': 1 },
  maxPoolDivergencePct: 5,      // skip a buy when the chosen pool is >5% off the token's main pool
  dailyLossLimitSol: 0.2,
  fullStopBalance: 2.5,
  pauseAfterTrades: 8,          // manager: a strategy net negative after this many trades trades at half size (never paused)
  minPositionSol: 0.02,         // size floor after manager cuts
  reentryCooldownMin: 45,       // no re-entry on the same token (mint / pool) for 45 min after any exit
  costRoundtripPct: 1.1,
  brokenGapPct: 15,

  // PR11 (Liviu t64u, 21 Nov): four aggressive PAPER books, side by side, same size, own capacity.
  // Fills and marks come only from Jupiter quotes (read-only quote API, never a swap).
  books: {
    epoch: 'books-v1',            // scoreboard epoch: old trades archived on the volume, fresh board from here
    sizeSol: 0.05,                // SAME size per trade for every book (manager never cuts the books)
    maxOpenPerBook: 2,            // own capacity per book, separate from the legacy maxOpen 4
    targetTrades: 30,             // report each book after 30 trades
    maxPriceAgeSec: 30,           // never act on a scan row or a quote older than 30 s
    exitLoopMs: 5000,             // pause between exit passes (each pass re-quotes every open book position)
    maxEntriesPerTick: 4,
    maxRoundTripLossPct: 10,      // skip a buy whose immediate Jupiter buy->sell round trip loses more
    maxQuoteGapPct: 15,           // skip a buy whose Jupiter fill is >15% worse than the DexScreener price
    noRouteTotalLossMin: 10,      // no sell route for 10 min -> book a total loss (never the last/entry price)
    noQuoteAfterMaxHoldMin: 10,   // no usable sell quote 10 min past max hold -> total loss
    list: [
      {
        id: 'graduation-sniper', name: 'Graduation sniper', version: 1,
        entry: { pumpOrigin: true, maxPoolAgeMin: 15, m5BuysGtSells: true, minLiquidityUsd: 30000 },
        exit: { stopLossPct: 10, takeProfitPct: 40, trailAfterPct: 15, trailPct: 10, maxHoldMinutes: 60 }
      },
      {
        id: 'runner-hunter', name: 'Runner hunter', version: 1,
        entry: { minVolumeToLiquidityH1: 0.10, minLiquidityUsd: 15000, minH1: 0, minM5: 0 },
        exit: { stopLossPct: 12, partial: { atPct: 10, sellPct: 20 }, trailAfterPartial: true, trailPct: 15, maxHoldMinutes: 240 }
      },
      {
        id: 'volume-explosion', name: 'Volume explosion', version: 1,
        entry: { minM5VolumeVsHourAvg: 10, minVolumeM5Usd: 3000, minM5: 0, maxM5: 30, minPoolAgeMin: 60, minLiquidityUsd: 10000 },
        exit: { stopLossPct: 8, trailAfterPct: 10, trailPct: 6, maxHoldMinutes: 60 }
      },
      {
        id: 'trending-pullback', name: 'Trending pullback', version: 1,
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
      paused: false,
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
      paused: false,
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
      paused: false,
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
