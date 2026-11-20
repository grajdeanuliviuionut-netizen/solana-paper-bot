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

Strategies currently included: `aggressive-flow`, `momentum-entry` (see `src/config.js`).

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

All paper. Live trading stays locked until you explicitly enable it.
