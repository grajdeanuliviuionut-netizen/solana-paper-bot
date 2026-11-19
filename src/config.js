require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  positionSizeSol: 0.25,
  maxOpen: 5,
  dailyLossLimitSol: 0.2,
  fullStopBalance: 3,
  costRoundtripPct: 1.1,
  strategies: [
    {
      id: 'smallcap-flow-scalp',
      name: 'Small-cap buy-flow scalp',
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 20000, maxLiquidityUsd: 800000 },
      entry: [
        { field: 'buySellRatioH1', op: '>=', value: 1.2 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.8 },
        { field: 'm5', op: '>=', value: 0.3 }
      ],
      exit: { takeProfitPct: 7, stopLossPct: 4.5, trailAfterPct: 3, trailPct: 2, maxHoldMinutes: 30 }
    },
    {
      id: 'fresh-breakout-v2',
      name: 'Fresh breakout v2',
      universe: { minAgeDays: 0, maxAgeDays: 7, minLiquidityUsd: 25000 },
      entry: [
        { field: 'h1', op: '>=', value: 4 },
        { field: 'm5', op: '>=', value: 1 },
        { field: 'buySellRatioH1', op: '>=', value: 1.2 }
      ],
      exit: { takeProfitPct: 18, stopLossPct: 9, maxHoldMinutes: 90 }
    }
  ]
};
