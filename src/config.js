require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  positionSizeSol: 0.32,
  maxOpen: 5,
  dailyLossLimitSol: 0.2,
  fullStopBalance: 3,
  costRoundtripPct: 1.1,
  strategies: [
    {
      id: 'flow-only-scalp',
      name: 'Buy-flow only scalp',
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 20000 },
      entry: [
        { field: 'buySellRatioH1', op: '>=', value: 1.05 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.2 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 6, trailAfterPct: 4, trailPct: 3, maxHoldMinutes: 45 }
    },
    {
      id: 'fresh-breakout-v2',
      name: 'Fresh breakout v2',
      universe: { minAgeDays: 0, maxAgeDays: 7, minLiquidityUsd: 25000 },
      entry: [
        { field: 'h1', op: '>=', value: 2 },
        { field: 'buySellRatioH1', op: '>=', value: 1.1 }
      ],
      exit: { takeProfitPct: 20, stopLossPct: 10, maxHoldMinutes: 120 }
    },
    {
      id: 'flush-reclaim-v2',
      name: 'Flush reclaim v2',
      universe: { minAgeDays: 0, maxAgeDays: 30, minLiquidityUsd: 30000 },
      entry: [
        { field: 'dropFromHigh60m', op: '>=', value: 8 },
        { field: 'm5', op: '>=', value: 0 }
      ],
      exit: { takeProfitPct: 10, stopLossPct: 8, maxHoldMinutes: 60 }
    }
  ]
};
