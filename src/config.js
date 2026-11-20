require('dotenv').config();
const crypto = require('crypto');

const num = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? parseFloat(process.env[name]) : def);

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Token mints that must never be traded.
const EXCLUDED_MINTS = {
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'Bonk',
  [SOL_MINT]: 'SOL',
  [USDC_MINT]: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT'
};

// Canonical mints of major tokens. Any other mint using one of these symbols is a clone.
// (Offline backstop; the rug gate also checks Jupiter's verified token list.)
const MAJOR_TOKENS = {
  wif: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  sol: SOL_MINT,
  wsol: SOL_MINT,
  usdc: USDC_MINT,
  usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  popcat: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  trump: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
  pengu: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
  fartcoin: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'
};

// ---- Execution cost / fill model (paper) ----
const fills = {
  dexFeePctPerSide: num('DEX_FEE_PCT', 0.25),     // pool LP fee each side
  baseSlippagePct: num('BASE_SLIPPAGE_PCT', 0.3), // latency/noise slippage each side
  stopSlippageMult: num('STOP_SLIPPAGE_MULT', 2.5), // stop-outs: 2-3x entry slippage
  stopDelayBlocks: num('STOP_DELAY_BLOCKS', 2),     // 1-2 block delay on stops
  failedExitRate: num('FAILED_EXIT_RATE', 0.075),   // 5-10% of exits fail first
  failedExitDelayBlocks: num('FAILED_EXIT_DELAY_BLOCKS', 2),
  useWorseOfQuote: process.env.USE_WORSE_OF_QUOTE !== 'false', // fill = worse of depth model and Jupiter quote
  blocksPer5m: 750,                                 // ~400ms slots
  minBlockVolPct: 0.05,                             // floor for per-block volatility
  // Flat per-transaction costs in SOL.
  baseFeeSol: num('BASE_FEE_SOL', 0.000005),
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0001),
  jitoTipSol: num('JITO_TIP_SOL', 0.0001)
};

// ---- Hard rug gate (fails closed) ----
const rugGate = {
  enabled: process.env.RUG_GATE !== 'off',
  cacheMs: 5 * 60 * 1000,
  requireMintRevoked: true,
  requireFreezeRevoked: true,
  minLpLockedPct: 90,
  top10MaxPct: 25,
  singleHolderMaxPct: 5,
  rejectRugged: true
};

const strategies = [
  {
    id: 'aggressive-flow',
    name: 'Aggressive flow scalp',
    type: 'simple',
    universe: { minAgeDays: 0, maxAgeDays: null, minLiquidityUsd: 50000, maxLiquidityUsd: 1000000 },
    entry: [
      { field: 'buySellRatioM5', op: '>=', value: 0.8 },
      { field: 'volumeToLiquidity', op: '>=', value: 0.03 },
      { field: 'm5', op: '>=', value: -2 }
    ],
    exit: { takeProfitPct: 6, stopLossPct: 5, trailAfterPct: 3, trailPct: 2, maxHoldMinutes: 25 },
    sizeSol: 0.2,
    maxOpen: 6
  },
  {
    id: 'momentum-entry',
    name: 'Momentum entry',
    type: 'simple',
    universe: { minAgeDays: 0, maxAgeDays: 14, minLiquidityUsd: 50000 },
    entry: [
      { field: 'h1', op: '>=', value: 2 },
      { field: 'm5', op: '>=', value: 0.5 }
    ],
    exit: { takeProfitPct: 10, stopLossPct: 6, maxHoldMinutes: 40 },
    sizeSol: 0.2,
    maxOpen: 6
  },
  // New Coin Scout spec: /workspace/specs/ncs_fresh_momentum_v1.json
  {
    id: 'ncs_fresh_momentum_v1',
    name: 'NCS fresh momentum',
    type: 'ncs',
    universe: {
      pairAgeMinMin: 5, pairAgeMaxMin: 240, excludeBondingCurve: true,
      tiers: {
        A: { minLiquidityUsd: 15000, sizeMult: 1.0 },
        B: { maxPairAgeMin: 60, minLiquidityUsd: 8000, sizeMult: 0.5 }
      }
    },
    entry: {
      m5Min: 3, m5Max: 40, h1Max: 300,
      minVolumeM5Usd: { A: 5000, B: 3000 },
      maxLiqDropVsPrevPct: 10,
      maxH1VolToLiq: 12, maxM5VolToLiq: 3,
      honeypot: { minTxnsM5: 20, minSellsM5: 3, maxBuySellRatioM5: 4 }
    },
    extraRug: {
      top10MaxPct: 30, singleHolderMaxPct: 10, // spec values; global gate is stricter and wins
      rejectDangerRisks: true, graphInsidersMax: 50,
      maxRugcheckToDexLiqRatioMin: 0.5,
      token2022RejectExtensions: ['transferFeeConfig', 'transferHook', 'permanentDelegate', 'defaultAccountState',
        'nonTransferable', 'confidentialTransferMint', 'pausableConfig', 'mintCloseAuthority', 'scaledUiAmountConfig', 'interestBearingConfig']
    },
    exit: {
      stopLossPct: 12,
      takeProfits: [{ atPct: 25, sellPct: 50 }, { atPct: 60, sellPct: 100 }],
      trailAfterTp1Pct: 15, breakevenAfterTp1: true,
      timeStop: { ifNotAbovePct: 5, afterMin: 15 },
      maxHoldMinutes: 30,
      emergency: { liqDropFromEntryPct: 30, zeroSellsMinBuysM5: 10 }
    },
    sizing: { basePctOfEquity: 2.0, maxPctOfPoolLiquidity: 1.0, maxTotalExposurePct: 10 },
    maxOpen: 5,
    reentryCooldownMinutes: 30,
    riskGuards: { dailyLossHaltPct: 8, consecutiveLosses: 5, pauseMinutes: 30 }
  }
];

const config = {
  // Build label only. Balance and open positions persist across builds (RESET_STATE=1 to start fresh);
  // go-live counts reset per strategy when its configHash changes.
  buildId: 'pr2.1-equity-denylist-2026-11-20',
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: num('STARTING_SOL', 4),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  exitCheckMs: parseInt(process.env.EXIT_CHECK_MS || '15000', 10),
  positionSizeSol: 0.2,
  maxOpen: 10,                 // global cap across strategies
  dailyLossLimitSol: 0.25,
  fullStopBalance: 2.5,
  costRoundtripPct: 1.1,       // legacy flat cost, kept for reference only (depth model is used)
  // Legacy strategies keep a $50k floor via their universe; the scan floor is the lowest tier.
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 50000),
  scanMinLiquidityUsd: num('SCAN_MIN_LIQUIDITY_USD', 8000),
  maxPairsPerScan: parseInt(process.env.MAX_PAIRS_PER_SCAN || '300', 10),
  defaultMaxHoldMinutes: 30,
  reentryCooldownMinutes: 15,
  goLiveTradeTarget: 50,
  liqDropAlertPct: 50,
  solMint: SOL_MINT,
  usdcMint: USDC_MINT,
  excludedMints: EXCLUDED_MINTS,
  majorTokens: MAJOR_TOKENS,
  fills,
  rugGate,
  strategies
};

// Config hash per strategy: strategy definition + everything that changes how its PnL is
// measured. The 50-trade go-live count only counts trades carrying the current hash.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
config.stableStringify = stableStringify;
config.configHashFor = strat => crypto.createHash('sha256')
  .update(stableStringify({ strat, fills, rugGate, minLiquidityUsd: config.minLiquidityUsd }))
  .digest('hex').slice(0, 12);
config.strategyHashes = Object.fromEntries(strategies.map(s => [s.id, config.configHashFor(s)]));

module.exports = config;
