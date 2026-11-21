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
  pauseAfterTrades: 8,          // manager: a strategy net negative after this many trades trades at half size (never paused)
  minPositionSol: 0.02,         // size floor after manager cuts
  reentryCooldownMin: 45,       // no re-entry on the same token (mint / pool) for 45 min after any exit
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
      exit: { takeProfitPct: 5, stopLossPct: 4, maxHoldMinutes: 20, earlyFailAfterMin: 0 }
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
      exit: { takeProfitPct: 8, stopLossPct: 6, maxHoldMinutes: 25, earlyFailAfterMin: 0 }
    },
    {
      id: 'dip-buyers',
      name: 'Dip then buyers',
      paused: true,
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
      paused: true,
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
