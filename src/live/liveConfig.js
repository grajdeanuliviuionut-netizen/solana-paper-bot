// Live-mode settings, all from env. Nothing here is ever logged except the safe summary().
// LIVE_TRADING is false unless explicitly 'true'. Risk limits have conservative code defaults
// (overridable by env); WALLET_PRIVATE_KEY and KILL_TOKEN have no default and live mode refuses to
// start without them.
const DEFAULTS = {
  LIVE_STRATEGIES: 'momentum-entry',
  MAX_SOL_PER_TRADE: 0.1,
  MAX_DAILY_LOSS_SOL: 0.5,
  MAX_OPEN_POSITIONS: 3,
  MAX_CONSECUTIVE_LOSSES: 5,
  PRIORITY_FEE: 100000, // lamports cap (0.0001 SOL), used when JITO_TIP = 0
  JITO_TIP: 0
};
function numOrNull(env, name) {
  const v = env[name];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function read(env = process.env) {
  const n = name => numOrNull(env, name);
  return {
    liveRequested: String(env.LIVE_TRADING || 'false').toLowerCase() === 'true',
    killSwitch: String(env.KILL_SWITCH || 'false').toLowerCase() === 'true',
    hasKey: !!env.WALLET_PRIVATE_KEY,
    hasKillToken: !!(env.KILL_TOKEN && env.KILL_TOKEN.length >= 16),
    maxSolPerTrade: n('MAX_SOL_PER_TRADE') ?? DEFAULTS.MAX_SOL_PER_TRADE,
    maxDailyLossSol: n('MAX_DAILY_LOSS_SOL') ?? DEFAULTS.MAX_DAILY_LOSS_SOL,
    maxOpenPositions: n('MAX_OPEN_POSITIONS') ?? DEFAULTS.MAX_OPEN_POSITIONS,
    maxConsecutiveLosses: n('MAX_CONSECUTIVE_LOSSES') ?? DEFAULTS.MAX_CONSECUTIVE_LOSSES,
    priorityFeeLamports: n('PRIORITY_FEE') ?? DEFAULTS.PRIORITY_FEE,
    jitoTipLamports: n('JITO_TIP') ?? DEFAULTS.JITO_TIP,
    minWalletReserveSol: n('MIN_WALLET_RESERVE_SOL') ?? 0.05,
    slippageBps: n('LIVE_SLIPPAGE_BPS') ?? 300,
    liveStrategies: String(env.LIVE_STRATEGIES === undefined ? DEFAULTS.LIVE_STRATEGIES : env.LIVE_STRATEGIES).split(',').map(s => s.trim()).filter(Boolean),
    rpcUrl: env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    jitoUrl: env.JITO_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
    maxSwapAttempts: n('LIVE_MAX_SWAP_ATTEMPTS') ?? 3
  };
}

// Returns list of problems that must block live mode (empty list = ok to try).
function validate(c, knownStrategyIds = []) {
  const p = [];
  if (!c.liveRequested) p.push('LIVE_TRADING is not true');
  if (c.killSwitch) p.push('KILL_SWITCH is on');
  if (!c.hasKey) p.push('WALLET_PRIVATE_KEY missing');
  if (!c.hasKillToken) p.push('KILL_TOKEN missing or shorter than 16 chars');
  const pos = (v, name) => { if (v == null) p.push(`${name} missing`); else if (!(v > 0)) p.push(`${name} must be > 0`); };
  const nonneg = (v, name) => { if (v == null) p.push(`${name} missing`); else if (!(v >= 0)) p.push(`${name} must be >= 0`); };
  pos(c.maxSolPerTrade, 'MAX_SOL_PER_TRADE');
  pos(c.maxDailyLossSol, 'MAX_DAILY_LOSS_SOL');
  pos(c.maxOpenPositions, 'MAX_OPEN_POSITIONS');
  pos(c.maxConsecutiveLosses, 'MAX_CONSECUTIVE_LOSSES');
  nonneg(c.priorityFeeLamports, 'PRIORITY_FEE');
  nonneg(c.jitoTipLamports, 'JITO_TIP');
  if (c.maxSolPerTrade > 1) p.push('MAX_SOL_PER_TRADE > 1 SOL refused (raise the cap in code deliberately)');
  if (!c.liveStrategies.length) p.push('LIVE_STRATEGIES missing (comma-separated strategy ids)');
  for (const s of c.liveStrategies) if (knownStrategyIds.length && !knownStrategyIds.includes(s)) p.push(`LIVE_STRATEGIES: unknown strategy ${s}`);
  return p;
}

function summary(c) {
  return {
    liveRequested: c.liveRequested, killSwitch: c.killSwitch, hasKey: c.hasKey, hasKillToken: c.hasKillToken,
    maxSolPerTrade: c.maxSolPerTrade, maxDailyLossSol: c.maxDailyLossSol, maxOpenPositions: c.maxOpenPositions,
    maxConsecutiveLosses: c.maxConsecutiveLosses, priorityFeeLamports: c.priorityFeeLamports, jitoTipLamports: c.jitoTipLamports,
    minWalletReserveSol: c.minWalletReserveSol, slippageBps: c.slippageBps, liveStrategies: c.liveStrategies
  };
}

module.exports = { read, validate, summary, DEFAULTS };
