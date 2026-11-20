# Solana Paper Trading Bot with Live Dashboard

Paper-only. No wallet or private key required.

## Deploy on Railway (new project)

1. Create a new GitHub repo and push these files.
2. In Railway: New Project → Deploy from GitHub repo.
3. Add a Volume mounted at `/app/data` (so results survive restarts).
4. Set environment variables (or leave defaults):
   - `PORT=3000`
   - `STARTING_SOL=4`
5. Deploy. Railway will give you a public URL.
6. Open the URL in your browser to see the live dashboard.

The bot polls every 60 seconds, paper-trades the strategies, and the dashboard updates when you refresh.

Strategies currently included: `aggressive-flow`, `momentum-entry`, `ncs_fresh_momentum_v1`
(New Coin Scout spec, tiers down to $8k liquidity). See `src/config.js`.

How it works:
- Candidates come from DEX Screener boosts/profiles + GeckoTerminal trending/new pools, resolved
  to one deepest-liquidity pool per token mint. Liquidity floor $50k (`MIN_LIQUIDITY_USD`).
- Positions are keyed by token mint + pairAddress (never by symbol). The pair is pinned at entry
  and quoted directly for entry and exit prices. One open position per mint across all strategies.
- JUP, Bonk, SOL, USDC, USDT are excluded by mint.
- Every closed trade is appended to `data/trades.jsonl` (mint, pairAddress, symbol, strategy,
  entry/exit price and time, exit reason, PnL). `GET /api/trades` returns the current build's
  trades plus a per-strategy summary (`?all=1` for every build). `GET /api/health` shows the build.
- One `[scan]` log line per cycle with pairs scanned, per-gate rejections, entries and exits.
- Bump `buildId` in `src/config.js` to reset paper balance/positions on the next deploy.

Fills, gates and logs (PR2):
- Fills: depth model (constant-product impact on the pinned pool + slippage + DEX fee). Stop-outs
  pay 2.5x slippage plus a 2-block delay drift; ~7.5% of exits "fail" and fill 2 blocks later.
  Flat per-tx cost (base fee + priority fee + Jito tip). Every entry/exit also takes a shadow
  Jupiter quote at the exact size (`src/jupiterQuote.js`, shared with the live path); the paper
  fill is the WORSE of the model and the quote. Quoted vs modelled price, impact, no-route are logged.
- Hard rug gate (`src/rugGate.js`, fails closed): RugCheck report - mint + freeze authority revoked,
  pinned pool LP >= 90% burned/locked, top-10 holders ex-pool < 25%, no wallet > 5%, clone check by
  mint (major-token list + Jupiter verified tokens). NCS adds its spec's extra checks.
- Every trade carries `strategyId` and `configHash`; the 50-trade go-live count per strategy only
  counts trades with the current hash.
- `GET /api/rejections`: hourly per-gate rejection counts + recent near-misses (failed exactly one
  gate, also appended to `data/nearmiss.jsonl`). Exit-quote failures, failed exits and liquidity
  drops > 50% go to `data/events.jsonl` and the logs.
- `npm test` runs offline unit tests.

All paper. Live trading stays locked until you explicitly enable it.

## Live path (PR3) - OFF by default
Paper is always the default. Live mode only starts when ALL of these hold at startup; otherwise
the bot logs `[live] LIVE MODE REFUSED ...` and keeps paper trading:
- `LIVE_TRADING=true` and `KILL_SWITCH` not `true`
- `WALLET_PRIVATE_KEY` (base58 secret key, e.g. Solflare export; set it only as a Railway secret,
  never commit it; it is redacted from every log line)
- `KILL_TOKEN` (>= 16 chars)
- valid limits; code defaults: `LIVE_STRATEGIES=momentum-entry`, `MAX_SOL_PER_TRADE=0.1` (<= 1),
  `MAX_DAILY_LOSS_SOL=0.5`, `MAX_OPEN_POSITIONS=3`, `MAX_CONSECUTIVE_LOSSES=5`, `PRIORITY_FEE=100000`
  lamports, `JITO_TIP=0`
- wallet balance >= `MAX_SOL_PER_TRADE` + `MIN_WALLET_RESERVE_SOL` (default 0.05), read via `RPC_URL`

Every live swap re-quotes Jupiter (same `src/jupiterQuote.js`) and must pass the same quote sanity
rules as paper (`src/quoteSanity.js`): buys need impact <= 5%, the strategy's gap cap, a reverse route
with impact <= 3% and a round trip loss <= 3%; sells are refused when the quote is insane. Refused
swaps are not sent (logged `refused-quoteSanity`). Emergency sells (rug/liquidity/no-sells) proceed
and log `emergency-sell-sanity-override`. Swaps retry with exponential backoff, and every attempt is
logged with priority fee and Jito tip (`GET /api/live`). Daily loss and losing-streak limits trip a
persistent kill switch (`data/live-state.json`). `POST /api/kill` with
`Authorization: Bearer <KILL_TOKEN>` stops all new live entries (paper unaffected; open live
positions are still managed/sold); without a configured KILL_TOKEN it always returns 403. Live
trades are logged with `mode: "live"` and on-chain signatures and kept out of the paper summary.
