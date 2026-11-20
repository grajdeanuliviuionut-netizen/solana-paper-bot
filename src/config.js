require('dotenv').config();

// Token mints that must never be traded (established coins that just bleed to costs,
// plus SOL/stables that can show up as the base token of reversed pairs).
const EXCLUDED_MINTS = {
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'Bonk',
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT'
};

module.exports = {
  // Bump this when a change must reset paper balance/positions (trade log is kept).
  buildId: 'pr1-mint-keyed-2026-11-20',
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
  // Global liquidity floor applied to every scanned pair, on top of per-strategy universes.
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '50000'),
  maxPairsPerScan: parseInt(process.env.MAX_PAIRS_PER_SCAN || '200', 10),
  defaultMaxHoldMinutes: 30,
  reentryCooldownMinutes: 15,
  excludedMints: EXCLUDED_MINTS,
  strategies: [
    {
      id: 'aggressive-flow',
      name: 'Aggressive flow scalp',
      universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 50000, maxLiquidityUsd: 1000000 },
      entry: [
        { field: 'buySellRatioM5', op: '>=', value: 0.8 },
        { field: 'volumeToLiquidity', op: '>=', value: 0.03 },
        { field: 'm5', op: '>=', value: -2 }
      ],
      exit: { takeProfitPct: 6, stopLossPct: 5, trailAfterPct: 3, trailPct: 2, maxHoldMinutes: 25 }
    },
    {
      id: 'momentum-entry',
      name: 'Momentum entry',
      universe: { minAgeDays: 0, maxAgeDays: 14, minLiquidityUsd: 50000 },
      entry: [
        { field: 'h1', op: '>=', value: 2 },
        { field: 'm5', op: '>=', value: 0.5 }
      ],
      exit: { takeProfitPct: 10, stopLossPct: 6, maxHoldMinutes: 40 }
    }
  ]
};
