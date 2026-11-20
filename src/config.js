require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.1,
  maxOpen: 6,
  dailyLossLimitSol: 0.3,
  fullStopBalance: 2.0,
  costRoundtripPct: 1.1,
  brokenGapPct: 15,
  strategies: [
    {
      id: 'buyer-dominance-breakout-v1',
      name: 'Buyer dominance breakout',
      universe: { minAgeDays: 0.5, maxAgeDays: 10, minLiquidityUsd: 60000, maxLiquidityUsd: 600000 },
      entry: [
        { field: 'buySellRatioH1', op: '>=', value: 1.5 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.5 },
        { field: 'm5', op: '>=', value: 1 },
        { field: 'h1', op: '>=', value: 3 },
        { field: 'h1', op: '<=', value: 25 },
        { field: 'liqChange60mPct', op: '>=', value: 0 }
      ],
      exit: { takeProfitPct: 18, stopLossPct: 5, trailAfterPct: 6, trailPct: 3, maxHoldMinutes: 20 }
    },
    {
      id: 'dip-reclaim-v1',
      name: 'Dip reclaim',
      universe: { minAgeDays: 2, maxAgeDays: 120, minLiquidityUsd: 80000, maxLiquidityUsd: 2000000 },
      entry: [
        { field: 'dropFromHigh60m', op: '>=', value: 15 },
        { field: 'dropFromHigh60m', op: '<=', value: 40 },
        { field: 'riseFromLow60m', op: '>=', value: 3 },
        { field: 'm5', op: '>', value: 0 },
        { field: 'buySellRatioH1', op: '>=', value: 1.1 },
        { field: 'liqChange60mPct', op: '>=', value: -5 }
      ],
      exit: { takeProfitPct: 12, stopLossPct: 7, trailAfterPct: 6, trailPct: 3, maxHoldMinutes: 45 }
    },
    {
      id: 'slow-trend-continuation-v1',
      name: 'Slow trend continuation',
      universe: { minAgeDays: 7, maxAgeDays: 365, minLiquidityUsd: 150000, maxLiquidityUsd: 5000000 },
      entry: [
        { field: 'h24', op: '>=', value: 10 },
        { field: 'h6', op: '>=', value: 4 },
        { field: 'h1', op: '>=', value: 0 },
        { field: 'h1', op: '<=', value: 6 },
        { field: 'buySellRatioH1', op: '>=', value: 1.15 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.2 },
        { field: 'liqChange60mPct', op: '>=', value: 0 }
      ],
      exit: { takeProfitPct: 15, stopLossPct: 6, trailAfterPct: 7, trailPct: 3.5, maxHoldMinutes: 120 }
    },
    {
      id: 'momentum-tight',
      name: 'Momentum tight',
      universe: { minAgeDays: 1, maxAgeDays: 14, minLiquidityUsd: 40000 },
      entry: [
        { field: 'h1', op: '>=', value: 3 },
        { field: 'm5', op: '>=', value: 1 },
        { field: 'buySellRatioH1', op: '>=', value: 1.2 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 4, maxHoldMinutes: 20 }
    }
  ]
};
