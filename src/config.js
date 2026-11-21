require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.15,
  maxOpen: 5,
  dailyLossLimitSol: 0.2,
  fullStopBalance: 2.5,
  costRoundtripPct: 1.1,
  brokenGapPct: 15,
  strategies: [
    {
      id: 'aggressive-flow',
      name: 'Aggressive flow scalp',
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
      universe: { minAgeDays: 0, maxAgeDays: 30, minLiquidityUsd: 10000 },
      entry: [
        { field: 'h1', op: '>=', value: 1 },
        { field: 'm5', op: '>=', value: -1 }
      ],
      exit: { takeProfitPct: 8, stopLossPct: 5, maxHoldMinutes: 30 }
    }
  ]
};
