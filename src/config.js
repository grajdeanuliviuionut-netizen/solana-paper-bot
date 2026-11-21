require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.15,
  maxOpen: 3,
  dailyLossLimitSol: 0.2,
  fullStopBalance: 2.5,
  pauseAfterTrades: 8,
  costRoundtripPct: 1.1,
  brokenGapPct: 15,
  strategies: [
    {
      id: 'aggressive-flow',
      name: 'Aggressive flow scalp',
      paused: true,
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 8000, maxLiquidityUsd: 2000000 },
      entry: [
        { field: 'buySellRatioH1', op: '>=', value: 0.9 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.08 },
        { field: 'm5', op: '>=', value: -3 }
      ],
      exit: { takeProfitPct: 5, stopLossPct: 4, trailAfterPct: 2, trailPct: 1.5, maxHoldMinutes: 20 }
    },
    {
      id: 'momentum-entry',
      name: 'Momentum entry',
      paused: true,
      universe: { minAgeDays: 0, maxAgeDays: 30, minLiquidityUsd: 15000 },
      entry: [
        { field: 'h1', op: '>=', value: 2 },
        { field: 'm5', op: '>=', value: 0 },
        { field: 'buySellRatioH1', op: '>=', value: 1.2 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.08 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 6, maxHoldMinutes: 25, earlyFailAfterMin: 8, earlyFailMinPeakPct: 1.5 }
    },
    {
      id: 'dip-buyers',
      name: 'Dip then buyers',
      universe: { minAgeDays: 1, maxAgeDays: 45, minLiquidityUsd: 20000, maxLiquidityUsd: 400000 },
      entry: [
        { field: 'h1', op: '<=', value: -4 },
        { field: 'h1', op: '>=', value: -12 },
        { field: 'm5', op: '>=', value: 0 },
        { field: 'buySellRatioH1', op: '>=', value: 1.4 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.06 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 6, maxHoldMinutes: 20, earlyFailAfterMin: 8, earlyFailMinPeakPct: 1.5 }
    },
    {
      id: 'buyer-turn',
      name: 'Buyers in control',
      universe: { minAgeDays: 0.05, maxAgeDays: 60, minLiquidityUsd: 20000, maxLiquidityUsd: 800000 },
      entry: [
        { field: 'h1', op: '>=', value: -15 },
        { field: 'h1', op: '<=', value: 12 },
        { field: 'm5', op: '>=', value: -1 },
        { field: 'buySellRatioH1', op: '>=', value: 1.3 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.05 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 6, maxHoldMinutes: 20, earlyFailAfterMin: 8, earlyFailMinPeakPct: 1.5 }
    }
  ]
};
