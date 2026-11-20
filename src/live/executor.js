// Live execution path. OFF by default: only constructed by initLive() when LIVE_TRADING=true and
// every check passes. Swaps use the same Jupiter quote module as paper shadow quotes.
const axios = require('axios');
const jupDefault = require('../jupiterQuote');
const liveConfig = require('./liveConfig');
const { loadKeypair } = require('./wallet');
const { redact } = require('./redact');

const SOL_MINT = jupDefault.SOL_MINT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayKey = () => new Date().toISOString().slice(0, 10);

class LiveExecutor {
  constructor({ cfg, keypair, connection, http = axios, jup = jupDefault, web3 = null, liveState, onTx = null, sleepFn = sleep }) {
    this.cfg = cfg;
    this.keypair = keypair;
    this.publicKey = keypair.publicKey.toBase58();
    this.connection = connection;
    this.http = http;
    this.jup = jup;
    this.web3 = web3 || require('@solana/web3.js');
    this.s = liveState; // persisted: { day, dayPnlSol, consecLosses, killed, killReason, killedAt, txLog: [] }
    this.onTx = onTx;
    this.sleep = sleepFn;
    this.active = true;
  }

  rollDay() {
    if (this.s.day !== dayKey()) { this.s.day = dayKey(); this.s.dayPnlSol = 0; if (this.s.killReason === 'daily-loss') { this.s.killed = false; this.s.killReason = null; } }
  }

  kill(reason) {
    if (!this.s.killed) console.error(`[live] KILL SWITCH: ${reason}. No new live entries.`);
    this.s.killed = true;
    this.s.killReason = reason;
    this.s.killedAt = new Date().toISOString();
  }

  // Returns null if a new live entry is allowed, else the blocking reason.
  entryBlock(openLiveCount, strategyId) {
    this.rollDay();
    if (!this.active) return 'live-inactive';
    if (String(process.env.KILL_SWITCH || '').toLowerCase() === 'true') return 'KILL_SWITCH env';
    if (this.s.killed) return `killed:${this.s.killReason}`;
    if (!this.cfg.liveStrategies.includes(strategyId)) return 'strategy-not-live';
    if (openLiveCount >= this.cfg.maxOpenPositions) return 'MAX_OPEN_POSITIONS';
    if (this.s.dayPnlSol <= -this.cfg.maxDailyLossSol) return 'MAX_DAILY_LOSS_SOL';
    return null;
  }

  recordResult(pnlSol) {
    this.rollDay();
    this.s.dayPnlSol += pnlSol;
    this.s.consecLosses = pnlSol < 0 ? (this.s.consecLosses || 0) + 1 : 0;
    if (this.s.dayPnlSol <= -this.cfg.maxDailyLossSol) this.kill('daily-loss');
    if (this.s.consecLosses >= this.cfg.maxConsecutiveLosses) this.kill(`consecutive-losses ${this.s.consecLosses}`);
  }

  logTx(entry) {
    const row = { time: new Date().toISOString(), priorityFeeLamports: this.cfg.priorityFeeLamports, jitoTipLamports: this.cfg.jitoTipLamports, ...entry };
    this.s.txLog = this.s.txLog || [];
    this.s.txLog.unshift(row);
    if (this.s.txLog.length > 200) this.s.txLog.pop();
    console.log(`[live-tx] ${redact(row)}`);
    if (this.onTx) this.onTx(row);
  }

  prioritization() {
    // Jupiter accepts either a Jito tip or a capped priority fee. Both values are logged on every tx.
    if (this.cfg.jitoTipLamports > 0) return { jitoTipLamports: Math.round(this.cfg.jitoTipLamports) };
    return { priorityLevelWithMaxLamports: { maxLamports: Math.round(this.cfg.priorityFeeLamports), priorityLevel: 'veryHigh' } };
  }

  async tokenBalanceRaw(mint) {
    const { PublicKey } = this.web3;
    const res = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new PublicKey(mint) });
    return (res.value || []).reduce((a, acc) => a + BigInt(acc.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  // One swap with retries + exponential backoff. Re-quotes on every attempt.
  async swap({ inputMint, outputMint, amount, label, mint }) {
    if (!this.active) throw new Error('live mode not active');
    const { VersionedTransaction } = this.web3;
    let lastErr = null;
    for (let attempt = 1; attempt <= this.cfg.maxSwapAttempts; attempt++) {
      const t0 = Date.now();
      try {
        const q = await this.jup.getQuote({ inputMint, outputMint, amount, slippageBps: this.cfg.slippageBps });
        if (!q.ok) throw new Error(`quote failed: ${q.noRoute ? 'no route' : q.error}`);
        const swapRes = await this.http.post(`${this.jup.SWAP_API}/swap`, {
          quoteResponse: q.quoteResponse,
          userPublicKey: this.publicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: this.prioritization()
        }, { timeout: 10000 });
        const b64 = swapRes.data && swapRes.data.swapTransaction;
        if (!b64) throw new Error('swap API returned no transaction');
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
        tx.sign([this.keypair]);
        const raw = tx.serialize();
        const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 2 });
        if (this.cfg.jitoTipLamports > 0) {
          this.http.post(this.cfg.jitoUrl, { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(raw).toString('base64'), { encoding: 'base64' }] }, { timeout: 5000 })
            .catch(e => console.error('[live] jito relay failed', redact(e.message)));
        }
        const conf = await this.connection.confirmTransaction({
          signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swapRes.data.lastValidBlockHeight
        }, 'confirmed');
        if (conf && conf.value && conf.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)}`);
        const fx = await this.actuals(signature, mint);
        const result = { ok: true, label, attempt, signature, inAmount: q.inAmount, quotedOutAmount: q.outAmount, priceImpactPct: q.priceImpactPct, route: q.routeLabels, ms: Date.now() - t0, ...fx };
        this.logTx({ ...result, status: 'confirmed' });
        return result;
      } catch (e) {
        lastErr = e;
        this.logTx({ ok: false, label, attempt, status: 'failed', error: redact(e.message), ms: Date.now() - t0 });
        if (attempt < this.cfg.maxSwapAttempts) await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
    return { ok: false, label, error: redact(lastErr ? lastErr.message : 'unknown') };
  }

  // Actual SOL and token deltas for our wallet from the confirmed transaction.
  async actuals(signature, mint) {
    try {
      const tx = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (!tx || !tx.meta) return {};
      const keys = tx.transaction.message.getAccountKeys ? tx.transaction.message.getAccountKeys().staticAccountKeys : tx.transaction.message.accountKeys;
      const idx = keys.findIndex(k => k.toBase58() === this.publicKey);
      const solDeltaLamports = idx >= 0 ? tx.meta.postBalances[idx] - tx.meta.preBalances[idx] : null;
      const tb = (arr) => (arr || []).filter(b => b.mint === mint && b.owner === this.publicKey).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
      const tokenDeltaRaw = mint ? (tb(tx.meta.postTokenBalances) - tb(tx.meta.preTokenBalances)).toString() : null;
      return { solDeltaLamports, tokenDeltaRaw, feeLamports: tx.meta.fee };
    } catch (e) {
      return { actualsError: redact(e.message) };
    }
  }

  async buy(mint, sizeSol) {
    const lamports = Math.round(Math.min(sizeSol, this.cfg.maxSolPerTrade) * 1e9);
    return this.swap({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, label: 'buy', mint });
  }

  async sell(mint, rawAmount) {
    if (!(BigInt(rawAmount) > 0n)) return { ok: false, error: 'nothing to sell' };
    return this.swap({ inputMint: mint, outputMint: SOL_MINT, amount: BigInt(rawAmount).toString(), label: 'sell', mint });
  }
}

// Decide at startup whether live mode may run. Any problem => paper, with the reason logged.
async function initLive({ liveState, strategyIds = [], env = process.env, deps = {} }) {
  const cfg = liveConfig.read(env);
  const status = { mode: 'paper', reasons: [], config: liveConfig.summary(cfg), publicKey: null, walletSol: null };
  if (!cfg.liveRequested) { status.reasons.push('LIVE_TRADING not enabled (default)'); return { status, executor: null }; }
  const problems = liveConfig.validate(cfg, strategyIds);
  if (problems.length) {
    status.reasons = problems;
    console.error(`[live] LIVE MODE REFUSED, staying in PAPER: ${problems.join('; ')}`);
    return { status, executor: null };
  }
  const kp = (deps.loadKeypair || loadKeypair)(env.WALLET_PRIVATE_KEY);
  if (!kp.ok) {
    status.reasons = [kp.error];
    console.error(`[live] LIVE MODE REFUSED, staying in PAPER: ${kp.error}`);
    return { status, executor: null };
  }
  status.publicKey = kp.publicKey;
  let connection;
  try {
    const web3 = deps.web3 || require('@solana/web3.js');
    connection = deps.connection || new web3.Connection(cfg.rpcUrl, 'confirmed');
    const lamports = await connection.getBalance(kp.keypair.publicKey);
    status.walletSol = lamports / 1e9;
  } catch (e) {
    status.reasons = [`wallet balance unavailable: ${redact(e.message)}`];
    console.error(`[live] LIVE MODE REFUSED, staying in PAPER: ${status.reasons[0]}`);
    return { status, executor: null };
  }
  if (!(status.walletSol >= cfg.maxSolPerTrade + cfg.minWalletReserveSol)) {
    status.reasons = [`wallet balance ${status.walletSol} SOL < MAX_SOL_PER_TRADE + reserve (${cfg.maxSolPerTrade + cfg.minWalletReserveSol})`];
    console.error(`[live] LIVE MODE REFUSED, staying in PAPER: ${status.reasons[0]}`);
    return { status, executor: null };
  }
  const executor = new LiveExecutor({ cfg, keypair: kp.keypair, connection, liveState, http: deps.http, jup: deps.jup, web3: deps.web3 });
  status.mode = 'live';
  console.log(`[live] LIVE MODE ACTIVE wallet=${kp.publicKey} balance=${status.walletSol} SOL strategies=${cfg.liveStrategies.join(',')} maxSolPerTrade=${cfg.maxSolPerTrade} priorityFee=${cfg.priorityFeeLamports} jitoTip=${cfg.jitoTipLamports}`);
  return { status, executor };
}

module.exports = { initLive, LiveExecutor };
