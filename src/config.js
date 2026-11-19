require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.2,
  maxOpen: 6,
  dailyLossLimitSol: 0.25,
  fullStopBalance: 2.5,
  costRoundtripPct: 1.1,
  strategies: [
    {
      id: 'aggressive-flow',
      name: 'Aggressive flow scalp',
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 10000, maxLiquidityUsd: 1000000 },
      entry: [
        { field: 'buySellRatioH1', op: '>=', value: 1.0 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.15 },
        { field: 'm5', op: '>=', value: -2 }
      ],
      exit: { takeProfitPct: 6, stopLossPct: 5, trailAfterPct: 3, trailPct: 2, maxHoldMinutes: 25 }
    },
    {
      id: 'momentum-entry',
      name: 'Momentum entry',
      universe: { minAgeDays: 0, maxAgeDays: 14, minLiquidityUsd: 15000 },
      entry: [
        { field: 'h1', op: '>=', value: 2 },
        { field: 'm5', op: '>=', value: 0.5 }
      ],
      exit: { takeProfitPct: 10, stopLossPct: 6, maxHoldMinutes: 40 }
    }
  ]
};
