# Corvis Trading

A Solana sniper bot dashboard. Each bot has its own encrypted wallet, scans newly listed tokens, filters out unsafe ones, buys, and exits on take profit, stop loss or a time limit. Bots run in **paper** mode (simulated trades on live market prices) or **live** mode (real swaps through Jupiter).

## How a bot trades
The engine runs two loops:
- **Every 1 s (`ENGINE_MONITOR_MS`)** it checks every open position, including those of paused bots. A position's value is **what selling it right now would return after fees**, from a real Jupiter sell quote (refreshed at least every 15 s, and always re-quoted before a sell). Take profit (×), stop loss (%, measured from the highest value the trade has reached when `stopLossFollowsPrice` is on, the default, so it moves up with the price), trailing stop (% off the peak, which arms once the position is up by that much and never lets an armed winner fall below break-even) and max hold all use that value, so a "take profit" is always a profit. The spot price feed is only used to decide when to look closer. If Jupiter can't quote a sell (no route, or the pool is drained), the position shows "no buyers · retrying" instead of a stale value, and the bot keeps retrying. A bot whose realized loss today reaches `maxDailyLossSol` is stopped.
- **Every 6 s (`ENGINE_SCAN_MS`)** it refreshes a watchlist of up to 120 new tokens from GeckoTerminal's newest pools, plus DexScreener's latest profiles and boosts when DexScreener isn't rate-limiting (it often blocks shared hosting IPs, so it's optional). Prices for open positions come from Jupiter's price API. Every watched token is re-checked on each scan, so a launch that starts quiet can still be bought once it picks up. Newest launches are checked first.

A token is bought only if it passes the bot's filters: minimum USD liquidity, maximum pair age, minimum buys in the last 5 minutes, a buy/sell ratio (momentum), minimum holders and a cap on how much the top 10 wallets hold. Its **mint and freeze authority must also both be revoked**. Right before buying, the bot quotes the buy *and* selling straight back: tokens with no sell route (honeypots), transfer taxes, or a round trip costing more than `maxRoundTripPct` (default 6%) are skipped. A bot never buys the same token twice, and a token that fails a check is left alone for 5 minutes.

**Rug filters** come from Jupiter's token audit: how much the dev wallet still holds (`maxDevHoldingPct`, default 10%), how many tokens the dev has launched before (`maxDevLaunches`, default 20, which screens out serial launchers), Jupiter's suspicious flag (always skipped), and an optional organic-activity score. `minPairAgeMinutes` can skip the first minutes of a launch, when insiders and bundled wallets usually sell.

**Scaling out:** at the first target (`partialTakeProfitMultiplier`, default 1.3×) the bot sells `partialSellPercent` (default 50%) and banks it. From then on the rest of the position may not drag the whole trade below +2%; it sells at the final take profit (default 1.5×, i.e. +50% after fees), the trailing stop, or that floor. This is how most profitable memecoin traders manage exits: small, repeatable wins locked in early, with a free ride on the runners.

**What's working** on the dashboard groups this server's closed trades by what each token looked like at entry (age, liquidity, holders, dev share, organic score, round-trip cost and more), and shows the win rate and P&L for each range. Run bots in paper mode, then tighten the filters toward the green ranges.

**Pause** stops new buys; open positions still sell on their exit rules. **Pause & sell all** sells everything now.

- **Paper:** filled from real Jupiter quotes plus network and priority fees, against the bot's 1 SOL paper balance, so results match what live would have done. Priority fees are charged at the cap you set; on small positions they add up fast (0.0005 SOL each way is 10% of a 0.01 SOL trade), and the bot form shows the fee share as you type.
- **Live:** quoted and swapped through Jupiter with a `veryHigh` priority fee (capped per bot) and dynamic slippage. Transactions skip preflight and are rebroadcast every 2 s until confirmed or expired. Entry price is the price actually paid. P&L comes from the wallet's real SOL change, and emptied token accounts are closed so their ~0.002 SOL rent comes back. One bot's swaps never overlap. A position that keeps failing to sell for 10+ minutes (usually a rug with no liquidity left) is booked as a total loss, and its tokens stay in the wallet.

## Testing it
- `npm test` runs unit tests plus three simulated market sessions. Each checks that live P&L matches the wallet balance exactly, that no token with an active mint authority is ever bought, and that every position gets closed.
- `npm run simulate [hours] [seed]` runs a synthetic memecoin market through the real engine, live code path included, and prints each bot's results. The market model is a test harness, not a profit forecast.
- **System check** in the dashboard (or `SELFTEST_ON_BOOT=true`, which logs `SELFTEST` lines) hits the real feeds, Jupiter and the RPC. It builds a real swap transaction and simulates it on mainnet without spending anything.
- **Test live swap** in a bot's *Stats & wallet* panel appears when live trading is on. It does a real 0.01 SOL → USDC → SOL round trip with the bot's wallet and reports the timings and cost.

## Speed and rate limits (read before going live)
Free market-data APIs rate-limit shared hosting like Render. Testing on Render showed HTTP 429s from DexScreener, GeckoTerminal, Jupiter's free tier and the public Solana RPC. The engine copes: each feed cools down after a 429 and the others carry on, and Jupiter calls run on a budget that always keeps 40% for real quotes and swaps. For fast, reliable live trading, add two free keys:
- **`JUPITER_API_KEY`** from portal.jup.ag. It switches to `api.jup.ag`. The free key allows about 60 requests a minute; on a paid plan set `JUPITER_RPM` to its limit so the bots can quote more often.
- **A private RPC** for `SOLANA_RPC_URL` (and `MARKET_RPC_URL`), for example Helius's free plan. The public RPC rate-limits quickly.

This is a fast polling sniper: it typically buys within seconds to a minute of a pool appearing in the feeds. It does not compete for the first block of a launch, which needs paid streaming (Yellowstone gRPC) and Jito bundles.

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
