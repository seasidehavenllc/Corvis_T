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
- **Persistent storage:** bot keys (AES-256-GCM encrypted) live in `DATA_DIR`. On Render this must be a persistent disk, which `render.yaml` sets up. On Render the server refuses to create wallets if `DATA_DIR` isn't set.
- **Encryption key:** `WALLET_ENCRYPTION_KEY` decrypts every bot wallet. Store a copy somewhere safe, such as a password manager.
- **Withdraw any time:** open a bot, then *Stats & wallet → Move funds out*, and send SOL to your own wallet.
- **Export key:** *Stats & wallet → Export private key* gives a base58 key you can import into Phantom or Solflare. This is your backup if the server ever goes away.
- **Delete is blocked** while a wallet still holds SOL or tokens, or has open positions, because deleting would destroy the only copy of the key.
- **Live trading needs two switches:** `ENABLE_LIVE_TRADING=true` and `SOLANA_NETWORK=mainnet-beta`. Each bot must also be set to live mode and funded. Start with a small position size.

## Render setup
1. Render dashboard → **New → Blueprint** → pick this repo. It reads `render.yaml`, which creates the web service, a 1 GB disk at `/var/data`, and the env vars. Disks need a paid plan (Starter).
   *If you already made the service by hand:* go to Service → **Disks** → add a disk at `/var/data`, then **Environment** → add `DATA_DIR=/var/data`.
2. Set `WALLET_ENCRYPTION_KEY` to the output of `openssl rand -hex 32` and save a copy.
3. `ADMIN_API_TOKEN` is generated automatically. Copy it from the Environment tab and use it to unlock the dashboard.
4. Deploy, open the site, unlock, create a bot, and press **Start**. It runs in paper mode.
5. To go live: set `SOLANA_NETWORK=mainnet-beta`, set `SOLANA_RPC_URL` to a paid RPC (Helius, QuickNode or Triton; the public one rate-limits), and set `ENABLE_LIVE_TRADING=true`. Then edit a bot to live mode, send SOL to its wallet address, and start it.

## Local run
Node 20+. `npm install`, copy `.env.example` to `.env`, fill in the keys, then run `npm start`, `npm test` and `npm run check`.

## API (admin calls need `Authorization: Bearer <ADMIN_API_TOKEN>`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | Bots with balances and performance, totals, open positions, recent trades, engine health |
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
