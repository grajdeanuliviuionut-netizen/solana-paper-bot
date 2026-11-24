require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  stateFile: process.env.STATE_FILE || './data/state.json',
  tradesFile: process.env.TRADES_FILE || './data/trades.jsonl',
  startingSol: parseFloat(process.env.STARTING_SOL || '4'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '45000', 10),
  positionSizeSol: 0.15,
  maxOpen: 4,                   // PR7: 3 -> 4 with the four books unpaused; 1 slot reserved for dip-hold
  slotReserve: {},              // t83u: dip-hold paused -> no reserved legacy slot (was { 'dip-hold': 1 })
  maxPoolDivergencePct: 5,      // skip a buy when the chosen pool is >5% off the token's main pool
  dailyLossLimitSol: 0.2,
  fullStopBalance: 2.5,
  pauseAfterTrades: 8,          // manager: a strategy net negative after this many trades trades at half size (never paused)
  minPositionSol: 0.02,         // size floor after manager cuts
  reentryCooldownMin: 45,       // no re-entry on the same token (mint / pool) for 45 min after any exit
  costRoundtripPct: 1.1,
  brokenGapPct: 15,
  // t85u (Liviu 22 Nov 09:30, explicit): truly one strategy. Only these ids may open (books AND legacy), on top
  // of the paused flags. Leftover positions of every other strategy are closed at a Jupiter sell quote before
  // the runner-v2 board starts (books.epochCloseout).
  onlyStrategies: ['runner-hunter', 'social-spike'],   // t117u (Liviu 24 Nov): + the social-spike paper book, runner-hunter unchanged
  // t86u (Liviu 22 Nov 12:12): the Manager reviews every 10 closed runner-hunter trades, applies ONE bounded
  // change (src/improver.js BOUNDS/RULES) as a new version, logs what and why, and reports every 30 trades.
  // Paper only: it never touches size, wallets, keys or LIVE_TRADING.
  manager: { enabled: true, reviewEvery: 10, reportEvery: 30, applyChanges: false },   // t100u: reviews/reports only, no new variants
  // t89u (Liviu 22 Nov 13:18): Manager hard halt. Marked equity -5% from its high within any rolling 24 h
  // (equity.jsonl, all epochs) -> all new trading stops, persisted, never auto-cleared (src/halt.js).
  halt: { enabled: true, windowHours: 24, dropPct: 5 },

  // PR11 (Liviu t64u, 21 Nov): four aggressive PAPER books, side by side, same size, own capacity.
  // Fills and marks come only from Jupiter quotes (read-only quote API, never a swap).
  books: {
    // t96u (Liviu): escalating exit slippage ladder for ALL exits: sell quote at 2%, then 3%, 10%, 25% when a quote
    // fails or is older than 2 s. The trigger uses that fresh quote; the paper fill = quote minus the slippage used.
    exitLadder: { bps: [200, 300, 1000, 2500], maxQuoteAgeMs: 2000 },
    epoch: 'runner-v6',           // t93u: Trend Following board (runner-v5 archived).           // t90u: fresh runner-hunter v5 board (runner-v4 archived, kept in scoreboardHistory). t89u: fresh runner-hunter v4 board (runner-v3 archived, kept in scoreboardHistory). t86u: fresh runner-hunter v3 board (runner-v2 archived, kept in scoreboardHistory; t85u: runner-v2, books-v1 before)
    epochCloseout: true,          // t85u: close non-onlyStrategies leftovers (paper, Jupiter sell quote) before the board starts
    sizeSol: 0.05,                // SAME size per trade for every book (manager never cuts the books)
    maxOpenPerBook: 2,            // own capacity per book, separate from the legacy maxOpen 4
    targetTrades: 30,             // report each book after 30 trades
    maxPriceAgeSec: 30,           // never act on a scan row or a quote older than 30 s
    exitLoopMs: 5000,             // PR14 target period of the exit loop (ALL open trades, legacy + books)
    exitQuotesPerMin: 52,         // PR14 Jupiter quotes/min the exit loop may use (bucket max ~55, limiter-enforced); more opens -> longer period
    maxExitQuoteAgeSec: 10,       // PR14 exit decisions only on a Jupiter sell quote <= 10 s old
    noRouteConsecutive: 5,        // PR14 no-route total loss needs 5 consecutive no-route answers AND noRouteTotalLossMin
    maxEntriesPerTick: 4,
    maxRoundTripLossPct: 10,      // skip a buy whose immediate Jupiter buy->sell round trip loses more
    maxQuoteGapPct: 15,           // skip a buy whose Jupiter fill is >15% worse than the DexScreener price
    noRouteTotalLossMin: 10,      // no sell route for 10 min -> book a total loss (never the last/entry price)
    noQuoteAfterMaxHoldMin: 10,   // no usable sell quote 10 min past max hold -> total loss
    list: [
      {
        // v2 (Liviu t76u): v1 lost ~100% three times (whale-held tokens dumped; LP was burned). v2 adds, fail
        // closed: LP >= 90% locked/burned + holder concentration (RugCheck report), pool age >= 3 min,
        // Jupiter round trip <= 8% loss and sell impact <= 5%; exits confirm a >= 50% one-check drop (or
        // > 50% impact) with a second quote 4 s later before booking. Core rules unchanged.
        // t83u (Liviu 22 Nov 06:46, explicit override of never-pause): only runner-hunter enters. paused = no new
        // entries; open positions are still marked and exited by the exit loop.
        id: 'graduation-sniper', name: 'Graduation sniper', version: 2, paused: true,
        entry: { pumpOrigin: true, minPoolAgeMin: 3, maxPoolAgeMin: 15, m5BuysGtSells: true, minLiquidityUsd: 30000,
          lpLockedMinPct: 90, maxTop10Pct: 30, maxSingleHolderPct: 10, maxCreatorPct: 5, maxRoundTripLossPct: 8, maxSellImpactPct: 5 },
        exit: { stopLossPct: 10, takeProfitPct: 40, trailAfterPct: 15, trailPct: 10, maxHoldMinutes: 60,
          confirmDropPct: 50, confirmImpactPct: 50, confirmDelayMs: 4000, confirmProbeFrac: 0.1 }
      },
      {
        // v2 (Liviu t85u, 22 Nov 09:30): at a 28% win rate a -12% stop with a +10% target cannot make money.
        // Entry unchanged. Exits on Jupiter sell quotes in the exit loop (5 s): stop -6%, sell 1/3 at +8%, trail
        // the remaining 2/3 8% below the highest mark since entry, max hold 4 h. 1.1% round trip pro rata per leg.
        // v3 (Liviu t86u, 22 Nov 12:12, copied from the Phantom bot): pool liquidity $100k-$900k, top-10 holders
        // <= 30% (Solana RPC largest accounts, pool/AMM/burn excluded, fail closed), 24 h volume >= 0.1x liquidity,
        // rising on m5 AND m15 (own 15-min price history, else GeckoTerminal 1m candles, fail closed), h1 <= 25%.
        // No re-buy of a coin for 24 h after a stop-out. 4 losses in a row -> no new entries for 30 min. Exits = v2.
        // v4 (Liviu t89u, 22 Nov 13:18): v3 entry filters kept, plus the Rug Check agent (hard, fail closed,
        // blacklist for the epoch on a fail: liquidity > $30k, mint + freeze authority revoked, top-10 <= 15%) and
        // the Executor's 150 bps slippage limit (entries abort; exits sell and flag). Strategist exits: -6% stop,
        // at +4% stop to entry and a 3% trail below the peak, not +4% within 15 min -> exit, 30 min max hold.
        // Paper fills: Jupiter quote - U(0.5-2.0%) per side, -3% more on stop-loss exits, 0.5% fee per side,
        // priority fee per side (replaces the 1.1% round trip). Guardrail: 3 losses in a row -> no scanning or
        // entries for 1 h. The 5%/24 h halt is config.halt.
        // v6 "Trend Following" (Liviu t93u, 22 Nov 14:53): buy only pools with liquidity > $50k whose price is above
        // its 50-period SMA of 1-minute closes (own ~45 s price history resampled to 1 min when it covers >= 50 min,
        // else GeckoTerminal 1m OHLCV: >= 50 candles, newest <= 3 min old; no data -> no entry). Rug gates kept
        // (liq > $30k, mint+freeze revoked, top-10 <= 15% via RugCheck, blacklist), 24 h no re-buy after a stop,
        // 150 bps entry slippage abort. Exits: -4% stop, +8% take profit (full), measured on the Jupiter sell-quote
        // price move since entry, checked every ~5 s with feed protection; 240 min safety cap (not in the order).
        // Paper cost model: flat 2% adverse slippage on every fill (buy and sell) + priority fee; no extra fee or
        // stop penalty. Boss Rules risk: 2 losses -> 30 min pause, no entries 02:00-06:00 UTC, 5%/24 h equity halt.
        // Size 5% of marked equity.
        // v6.02 "filter-on" (Liviu t100u, 22 Nov 20:49): the MA filter-on runner is the only variant (Manager changes
        // frozen: books.manager.applyChanges false). Entry unchanged from v6.01 (liq > $50k, price >= 1% above a rising
        // SMA50 of 1-min closes, rug gates, Boss Rules, 2 open, 5% sizing). Exits on the price move since entry: -4% stop;
        // at +8% sell half (1:2 risk/reward), the other half runs with a 4% trailing stop from its peak and a floor at the
        // entry price (exit 'breakeven'); 240 min safety cap. Fresh Jupiter quotes every ~5 s via the exit slippage ladder.
        // v6.01 kept below (it had: price >= 1% above a rising MA50, full exit at +8%).
        // t115u (Liviu 24 Nov): v6.03 = v6.02 with the stop trigger pulled in to -2.5% move (stop fills overshot ~1-2 pts,
        // so realised moves land near -4%), entry liquidity floor $100k (thin pools gapped worst), half still at +8%.
        id: 'runner-hunter', name: 'Trend Following', version: 6.03,
        entry: { minLiquidityUsd: 100000, trend: { maPeriod: 50, candleSec: 60, maxCandleAgeSec: 180, minAbovePct: 1, requireMaRising: true, risingLookbackCandles: 5, maCacheSec: 120 },
          maxTop10Pct: 15, maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          stopCooldownHours: 24, lossStreakPause: { losses: 2, minutes: 30, pauseScanning: true }, nightSkip: { startHourUtc: 2, endHourUtc: 6 }, sizing: { pctOfEquity: 5 } },
        exit: { stopLossPct: 2.5, partial: { atPct: 8, sellPct: 50 }, trailAfterPartial: true, trailPct: 4, breakevenAfterPartial: true, maxHoldMinutes: 240, priceBasis: 'entryQuote', feedStaleSec: 60,
          costModel: { flatSlipPct: 2, simSlipMinPct: 2, simSlipMaxPct: 2, stopPenaltyPct: 0, feePctPerSide: 0, priorityFee: true, cuLimit: 200000 } },
        previousVersions: [
          { version: 6.02, until: '2026-11-24T16:45', name: 'Trend Following', entry: { minLiquidityUsd: 50000, trend: { maPeriod: 50, candleSec: 60, maxCandleAgeSec: 180, minAbovePct: 1, requireMaRising: true, risingLookbackCandles: 5, maCacheSec: 120 },
          maxTop10Pct: 15, maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          stopCooldownHours: 24, lossStreakPause: { losses: 2, minutes: 30, pauseScanning: true }, nightSkip: { startHourUtc: 2, endHourUtc: 6 }, sizing: { pctOfEquity: 5 } },
        exit: { stopLossPct: 4, partial: { atPct: 8, sellPct: 50 }, trailAfterPartial: true, trailPct: 4, breakevenAfterPartial: true, maxHoldMinutes: 240, priceBasis: 'entryQuote', feedStaleSec: 60,
          costModel: { flatSlipPct: 2, simSlipMinPct: 2, simSlipMaxPct: 2, stopPenaltyPct: 0, feePctPerSide: 0, priorityFee: true, cuLimit: 200000 } } },
          { version: 6.01, until: '2026-11-22T20:49', name: 'Trend Following', entry: { minLiquidityUsd: 50000, trend: { maPeriod: 50, candleSec: 60, maxCandleAgeSec: 180, minAbovePct: 1, requireMaRising: true, risingLookbackCandles: 5, maCacheSec: 120 },
          maxTop10Pct: 15, maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          stopCooldownHours: 24, lossStreakPause: { losses: 2, minutes: 30, pauseScanning: true }, nightSkip: { startHourUtc: 2, endHourUtc: 6 }, sizing: { pctOfEquity: 5 } },
            exit: { stopLossPct: 4, takeProfitPct: 8, maxHoldMinutes: 240, priceBasis: 'entryQuote', feedStaleSec: 60,
          costModel: { flatSlipPct: 2, simSlipMinPct: 2, simSlipMaxPct: 2, stopPenaltyPct: 0, feePctPerSide: 0, priorityFee: true, cuLimit: 200000 } } },
          { version: 6, until: '2026-11-22T16:00', name: 'Trend Following', entry: { minLiquidityUsd: 50000, trend: { maPeriod: 50, candleSec: 60, maxCandleAgeSec: 180, minAbovePct: 0, maCacheSec: 120 },
          maxTop10Pct: 15, maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          stopCooldownHours: 24, lossStreakPause: { losses: 2, minutes: 30, pauseScanning: true }, nightSkip: { startHourUtc: 2, endHourUtc: 6 }, sizing: { pctOfEquity: 5 } },
            exit: { stopLossPct: 4, takeProfitPct: 8, maxHoldMinutes: 240, priceBasis: 'entryQuote', feedStaleSec: 60,
          costModel: { flatSlipPct: 2, simSlipMinPct: 2, simSlipMaxPct: 2, stopPenaltyPct: 0, feePctPerSide: 0, priorityFee: true, cuLimit: 200000 } } },
          { version: 5, until: '2026-11-22T14:53', name: 'Runner hunter (Boss Rules breakout)', entry: { minLiquidityUsd: 100000, maxLiquidityUsd: 900000, minVolumeToLiquidityH24: 0.1, minM5: 0, minM15: 0, maxH1: 25, maxTop10Pct: 15,
          maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          breakout: { minVolSpike: 3, lookbackMin: 45, excludeMin: 5, minCoverMin: 30, minBreakPct: 0 },
          stopCooldownHours: 24, lossStreakPause: { losses: 2, minutes: 30, pauseScanning: true }, nightSkip: { startHourUtc: 2, endHourUtc: 6 }, sizing: { pctOfEquity: 5 } },
            exit: { stopLossPct: 6, takeProfit: { strong: { pct: 4, minVolSpike: 6, minM5: 3 }, moderate: { pct: 3, minVolSpike: 4, minM5: 1.5 }, weak: { pct: 2 } },
          maxHoldMinutes: 25, feedStaleSec: 60,
          costModel: { simSlipMinPct: 0.5, simSlipMaxPct: 2.0, stopPenaltyPct: 3, feePctPerSide: 0.5, priorityFee: true, cuLimit: 200000 } } },
          { version: 4, until: '2026-11-22T13:56', entry: { minLiquidityUsd: 100000, maxLiquidityUsd: 900000, minVolumeToLiquidityH24: 0.1, minM5: 0, minM15: 0, maxH1: 25, maxTop10Pct: 15,
          maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          stopCooldownHours: 24, lossStreakPause: { losses: 3, minutes: 60, pauseScanning: true } },
            exit: { stopLossPct: 6, breakevenAtPct: 4, trailAfterPct: 4, trailPct: 3, momentum: { minPct: 4, withinMinutes: 15 }, maxHoldMinutes: 30,
          costModel: { simSlipMinPct: 0.5, simSlipMaxPct: 2.0, stopPenaltyPct: 3, feePctPerSide: 0.5, priorityFee: true, cuLimit: 200000 } } },
          { version: 3, until: '2026-11-22T13:18', entry: { minLiquidityUsd: 100000, maxLiquidityUsd: 900000, minVolumeToLiquidityH24: 0.1, minM5: 0, minM15: 0, maxH1: 25, maxTop10Pct: 30,
            stopCooldownHours: 24, lossStreakPause: { losses: 4, minutes: 30 } },
            exit: { stopLossPct: 6, partial: { atPct: 8, sellPct: 33.3333 }, trailAfterPartial: true, trailPct: 8, maxHoldMinutes: 240 } },
          { version: 2, until: '2026-11-22T12:12', entry: { minVolumeToLiquidityH1: 0.10, minLiquidityUsd: 15000, minH1: 0, minM5: 0 },
            exit: { stopLossPct: 6, partial: { atPct: 8, sellPct: 33.3333 }, trailAfterPartial: true, trailPct: 8, maxHoldMinutes: 240 } },
          { version: 1, until: '2026-11-22', entry: { minVolumeToLiquidityH1: 0.10, minLiquidityUsd: 15000, minH1: 0, minM5: 0 },
            exit: { stopLossPct: 12, partial: { atPct: 10, sellPct: 20 }, trailAfterPartial: true, trailPct: 15, maxHoldMinutes: 240 } }
        ]
      },
      {
        // t117u + t121u (Liviu 24 Nov): Social Sentiment Engine. Buy a top-3 Solana memecoin whose activity jumped >= +50%
        // (DexScreener primary: max(txns, USD volume) last 60 min vs the mean hour of the 5 h before, within DexScreener boosts
        // + GeckoTerminal trending; X counts confirmation only with env SOCIAL_X_BEARER_TOKEN; src/books/social.js) when the
        // pool liquidity is >= $100k AND a simulated ~$500 sell (Jupiter quotes: $500 -> SOL at the SOL/USD price, buy-quote
        // that SOL, sell-quote the tokens back) loses < 1.5% (max of Jupiter sell price impact and the sell vs the DexScreener
        // mid value). Pass -> BUY signal to the paper engine. Exits on the price move since entry (Jupiter sell quotes ~5 s):
        // hard stop -10%; at +25% sell half, the other half trails 10% below its peak, +50% takes the rest; 240 min cap.
        // Kept from runner-hunter: rug gates + top-10 <= 15%, 150 bps entry slippage abort, 24 h no re-buy after a stop,
        // 2 losses -> 30 min pause, no entries 02:00-06:00 UTC, the 24 h drawdown auto size cut (src/halt.js), 5% sizing,
        // max 2 open (books.maxOpenPerBook), 2% paper slip per fill. Off with env SOCIAL_SPIKE_ENABLED=0.
        id: 'social-spike', name: 'Social Sentiment', version: 1, paused: /^(0|false|off|no)$/i.test(String(process.env.SOCIAL_SPIKE_ENABLED || '').trim()),
        entry: { minLiquidityUsd: 100000, social: { minSpikePct: 50, topN: 3, baselineHours: 5, windowMin: 60, minMentions1h: 20, minTxns1h: 300, refreshMin: 5, maxAgeMin: 12 },
          sellGate: { usd: 500, maxSlipPct: 1.5 },
          maxTop10Pct: 15, maxSlippageBps: 150, rugCheck: { minLiquidityUsd: 30000, mintRevoked: true, freezeRevoked: true, maxTop10Pct: 15, blacklist: 'epoch' },
          stopCooldownHours: 24, lossStreakPause: { losses: 2, minutes: 30, pauseScanning: true }, nightSkip: { startHourUtc: 2, endHourUtc: 6 }, sizing: { pctOfEquity: 5 } },
        exit: { stopLossPct: 10, partial: { atPct: 25, sellPct: 50 }, trailAfterPartial: true, trailPct: 10, takeProfitPct: 50, maxHoldMinutes: 240, priceBasis: 'entryQuote', feedStaleSec: 60,
          costModel: { flatSlipPct: 2, simSlipMinPct: 2, simSlipMaxPct: 2, stopPenaltyPct: 0, feePctPerSide: 0, priorityFee: true, cuLimit: 200000 } }
      },
      {
        id: 'volume-explosion', name: 'Volume explosion', version: 1, paused: true,   // t83u
        entry: { minM5VolumeVsHourAvg: 10, minVolumeM5Usd: 3000, minM5: 0, maxM5: 30, minPoolAgeMin: 60, minLiquidityUsd: 10000 },
        exit: { stopLossPct: 8, trailAfterPct: 10, trailPct: 6, maxHoldMinutes: 60 }
      },
      {
        id: 'trending-pullback', name: 'Trending pullback', version: 1, paused: true,   // t83u
        entry: { minH24: 100, minDropFromHighPct: 20, maxDropFromHighPct: 30, volumeRising: true, minLiquidityUsd: 20000 },
        exit: { stopLossPct: 10, takeProfitPct: 25, trailAfterPct: 15, trailPct: 5, maxHoldMinutes: 180 }
      }
    ]
  },
  strategies: [
    {
      id: 'aggressive-flow',
      name: 'Aggressive flow scalp',
      paused: true,             // PR13 (Liviu t68u, explicit override of never-pause for THIS book only): no new entries; open AF positions exit normally
      sizeMult: 0.25,           // PR9 (Liviu 17:56): quarter size (was 0.5 from PR7)
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
      paused: true,             // t83u (Liviu 22 Nov 06:46): only runner-hunter enters; open trades still exit
      sizeMult: 0.5,            // PR7 (Liviu 17:10): unpaused at half size
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
      paused: true,             // t83u: only runner-hunter enters
      sizeMult: 0.5,            // PR7 (Liviu 17:10): unpaused at half size
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
      paused: true,             // t83u: only runner-hunter enters; open trades still exit
      sizeMult: 0.5,            // PR7 (Liviu 17:10): unpaused at half size
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
      paused: true,             // t83u: only runner-hunter enters; open trades still exit
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
