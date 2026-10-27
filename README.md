# Corvis Trading

A Solana sniper bot dashboard. Each bot has its own encrypted wallet, scans newly listed tokens, filters out unsafe ones, buys, and exits on take profit, stop loss or a time limit. Bots run in **paper** mode (simulated trades on live market prices) or **live** mode (real swaps through Jupiter).

## How a bot trades
Every `ENGINE_TICK_MS` (15 s by default) the engine:
1. **Manages open positions** for every bot, including paused ones. It prices each one from DexScreener and sells on take profit (×), stop loss (%) or max hold time.
2. **Checks the daily loss limit**. A bot whose realized P&L today is at or below `-maxDailyLossSol` is stopped.
3. **Finds new tokens** from DexScreener's latest token profiles and boosts on Solana, using the most liquid SOL pair for each.
4. **Filters** them with each bot's settings: minimum USD liquidity, maximum pair age, and minimum buys in the last 5 minutes. A token is also skipped unless its **mint authority and freeze authority are both revoked**, so the creator can't mint more supply or freeze your tokens. A bot never buys the same token twice.
5. **Buys** `maxPositionSol`, up to `maxOpenPositions` at once.
   - Paper: simulated at the DexScreener price, with a 1% cost on each side for slippage and fees, against the bot's 1 SOL paper balance.
   - Live: quoted and swapped through Jupiter, signed with the bot wallet. P&L is measured from the wallet's real SOL balance change, so fees are included.

The dashboard shows each bot's balance, P&L curve, trades, win rate, average and best/worst trade, average hold time, and open positions. Each position has a "Sell now" button.

## Keeping your money safe
- **Wallets can't be lost:** every bot wallet is derived from `WALLET_ENCRYPTION_KEY` plus a wallet number. If the database is wiped (Render's free plan does this whenever it sleeps or redeploys), the server checks the blockchain on startup and re-adds every bot wallet that still holds SOL or tokens, as "Recovered wallet #N". Back up `WALLET_ENCRYPTION_KEY`: it is the master key for all bot wallets.
- **History:** trade history and bot settings live in `DATA_DIR`. On the free plan they reset when the instance sleeps, so use **Download backup** in the dashboard and **Restore** after a restart. A paid plan with a disk at `DATA_DIR` keeps them automatically.
- **Withdraw any time:** *Stats & wallet → Move funds out* sends SOL to your own wallet.
- **Export key:** *Stats & wallet → Export private key* gives a base58 key you can import into Phantom or Solflare.
- **Delete is blocked** while a wallet holds SOL or tokens, or has open positions.
- **Live trading needs two switches:** `ENABLE_LIVE_TRADING=true` and `SOLANA_NETWORK=mainnet-beta`. Each bot must also be set to live mode and funded. Start small.

## Render setup
Works on the **free plan**. The bots only run while the server is awake, and an open dashboard keeps it awake because it polls every 10 seconds. A free instance sleeps about 15 minutes after you close the tab, and the bots stop until you open it again. Positions left open while it sleeps are managed again when it wakes.
1. Set `WALLET_ENCRYPTION_KEY` to the output of `openssl rand -hex 32` and save a copy somewhere safe.
2. Set `ADMIN_API_TOKEN` to a long random password. You use it to unlock the dashboard.
3. Optional: `NODE_VERSION=22`, `SOLANA_NETWORK=devnet`, `SOLANA_RPC_URL=https://api.devnet.solana.com`.
4. Deploy, open the site, unlock, create a bot, and press **Start**. It runs in paper mode.
5. To go live: set `SOLANA_NETWORK=mainnet-beta`, set `SOLANA_RPC_URL` to a paid RPC (Helius, QuickNode or Triton), and set `ENABLE_LIVE_TRADING=true`. Then edit a bot to live mode, send SOL to its wallet address, and start it.
6. Optional, for history that survives restarts: switch to a paid plan, add a disk at `/var/data`, and set `DATA_DIR=/var/data`.

## Local run
Node 20+. `npm install`, copy `.env.example` to `.env`, fill in the keys, then run `npm start`, `npm test` and `npm run check`.

## API (admin calls need `Authorization: Bearer <ADMIN_API_TOKEN>`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | Bots with balances and performance, totals, open positions, recent trades, engine health |
| GET | `/api/backup` | Download settings and trade history (admin) |
| POST | `/api/restore` | Restore a backup file (admin) |
| GET | `/api/bots/:id/stats` | One bot's full stats, positions and trade history |
| POST | `/api/bots` | Create a bot (admin) |
| PATCH | `/api/bots/:id` | Edit settings, or `{ "enabled": true/false }` to start or pause (admin) |
| POST | `/api/bots/:id/positions/:pid/close` | Sell a position now (admin) |
| POST | `/api/bots/:id/withdraw` | `{ to, amountSol \| all: true, confirm: true }` (admin) |
| POST | `/api/bots/:id/export-key` | `{ confirm: true }` returns the base58 private key (admin) |
| DELETE | `/api/bots/:id` | Only when the wallet is empty (admin) |
| POST | `/api/wallet/withdraw` | Treasury withdrawal (admin) |

### Dev wallet fee and sweep (off by default)
- `POST /api/bots/:id/realized-profit-fee` with `{ "realizedProfitSol": 0.1, "settlementId": "<unique trade id>", "confirm": true }` sends `DEV_FEE_PERCENT`% of positive profit to `DEV_WALLET_ADDRESS`, but only if `ENABLE_DEV_FEE_TRANSFERS=true`. A repeated `settlementId` is rejected, so the same profit is never charged twice. The engine does not call this automatically.
- `POST /api/bots/:id/sweep` with `{ "confirm": true }` sends the bot wallet's SOL and SPL tokens to the dev wallet, but only if `ENABLE_LIVE_SWEEP=true`.

## Risks
New Solana tokens are extremely volatile, and many are scams. The safety checks block the common mint and freeze traps, but they can't stop liquidity pulls, honeypot taxes or sudden dumps. Paper-trade first, keep position sizes small, and only fund bots with money you can afford to lose.
