require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  positionSizeSol: 0.32,
  maxOpen: 3,
  dailyLossLimitSol: 0.2,
  fullStopBalance: 3,
  costRoundtripPct: 1.1,
  strategies: [
    {
      id: 'brs-wide',
      name: 'Buy-ratio spike wide',
      universe: { minAgeDays: 4, maxAgeDays: 45, minLiquidityUsd: 35000, maxLiquidityUsd: 200000 },
      entry: [
        { field: 'h1', op: '<=', value: -3 },
        { field: 'h1', op: '>=', value: -9 },
        { field: 'buySellRatioH1', op: '>=', value: 1.6 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.07 },
        { field: 'liqChange60mPct', op: '>=', value: -8 }
      ],
      exit: { takeProfitPct: 9, stopLossPct: 7.5, maxHoldMinutes: 150 }
    },
    {
      id: 'fresh-breakout',
      name: 'Fresh breakout runner',
      universe: { minAgeDays: 0, maxAgeDays: 3, minLiquidityUsd: 40000, maxLiquidityUsd: 600000 },
      entry: [
        { field: 'm5', op: '>=', value: 4 },
        { field: 'h1', op: '>=', value: 15 },
        { field: 'buySellRatioH1', op: '>=', value: 1.4 },
        { field: 'volumeToLiquidity', op: '>=', value: 1.5 },
        { field: 'liqChange60mPct', op: '>=', value: 0 }
      ],
      exit: { takeProfitPct: 25, stopLossPct: 9, trailAfterPct: 12, trailPct: 8, maxHoldMinutes: 120 }
    },
    {
      id: 'flush-reclaim',
      name: 'Panic flush reclaim',
      universe: { minAgeDays: 0, maxAgeDays: 14, minLiquidityUsd: 60000 },
      entry: [
        { field: 'dropFromHigh60m', op: '>=', value: 25 },
        { field: 'm5', op: '>=', value: 3 },
        { field: 'buySellRatioH1', op: '>=', value: 1.0 },
        { field: 'liqChange60mPct', op: '>=', value: -5 }
      ],
      exit: { takeProfitPct: 18, stopLossPct: 10, maxHoldMinutes: 90 }
    }
  ]
};
