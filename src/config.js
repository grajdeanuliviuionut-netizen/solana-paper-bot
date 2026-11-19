require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  positionSizeSol: 0.32,
  maxOpen: 4,
  dailyLossLimitSol: 0.2,
  fullStopBalance: 3,
  costRoundtripPct: 1.1,
  strategies: [
    {
      id: 'fresh-breakout-v2',
      name: 'Fresh breakout v2 (loose)',
      universe: { minAgeDays: 0, maxAgeDays: 7, minLiquidityUsd: 25000, maxLiquidityUsd: null },
      entry: [
        { field: 'h1', op: '>=', value: 8 },
        { field: 'm5', op: '>=', value: 1 },
        { field: 'dropFromHigh60m', op: '<=', value: 8 },
        { field: 'buySellRatioH1', op: '>=', value: 1.15 },
        { field: 'liqChange60mPct', op: '>=', value: -3 }
      ],
      exit: { takeProfitPct: 35, stopLossPct: 10, trailAfterPct: 10, trailPct: 8, maxHoldMinutes: 120 }
    },
    {
      id: 'flush-reclaim-v2',
      name: 'Flush reclaim v2 (loose)',
      universe: { minAgeDays: 0, maxAgeDays: 30, minLiquidityUsd: 40000 },
      entry: [
        { field: 'dropFromHigh60m', op: '>=', value: 15 },
        { field: 'm5', op: '>=', value: 1.5 },
        { field: 'liqChange60mPct', op: '>=', value: -8 },
        { field: 'volumeH1Usd', op: '>=', value: 20000 }
      ],
      exit: { takeProfitPct: 12, stopLossPct: 9, trailAfterPct: 7, trailPct: 5, maxHoldMinutes: 60 }
    },
    {
      id: 'hot-flow-scalp',
      name: 'Hot buy-flow scalp',
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 30000, maxLiquidityUsd: 1500000 },
      entry: [
        { field: 'volumeToLiquidity', op: '>=', value: 1 },
        { field: 'buySellRatioH1', op: '>=', value: 1.3 },
        { field: 'm5', op: '>=', value: 0.5 },
        { field: 'h1', op: '>=', value: 2 },
        { field: 'h1', op: '<=', value: 40 }
      ],
      exit: { takeProfitPct: 9, stopLossPct: 6, trailAfterPct: 5, trailPct: 3.5, maxHoldMinutes: 45 }
    },
    {
      id: 'brs-wide',
      name: 'Buy-ratio spike wide',
      universe: { minAgeDays: 4, maxAgeDays: 45, minLiquidityUsd: 35000, maxLiquidityUsd: 200000 },
      entry: [
        { field: 'h1', op: '<=', value: -3 },
        { field: 'h1', op: '>=', value: -9 },
        { field: 'buySellRatioH1', op: '>=', value: 1.4 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.05 },
        { field: 'liqChange60mPct', op: '>=', value: -10 }
      ],
      exit: { takeProfitPct: 9, stopLossPct: 7.5, maxHoldMinutes: 150 }
    }
  ]
};
