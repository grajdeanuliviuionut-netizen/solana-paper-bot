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

Strategies currently included (aggressive set):
- buy-ratio-spike-wide (benchmark)
- fresh-breakout-runner
- flush-reclaim-bounce
- volume-ignition-small-cap

All paper. Live trading stays locked until you explicitly enable it.
