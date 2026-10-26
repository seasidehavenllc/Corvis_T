# Corvis Trading — dev-wallet transfer policy build

This is a complete runnable Express dashboard/backend foundation. It is **not a fully working live token-sniping bot**: a vetted token-discovery + swap execution adapter and trusted realized-P&L integration are not present, so automated live trading remains disabled.

## Destination and policy
- The configured dev wallet is `8ooeEAN637seumjXGMed7KXGv9fQBDoniDgtEBsYpbku`.
- The profit fee is 10% of **positive realized profit only**, not 10% of trade notional and not 10% of returned principal.
- The per-trade fee is paid in SOL. If a swap produces profit in another token, production settlement code must first calculate realized profit in a trusted common denomination and convert/route the fee appropriately. This build deliberately does not guess token prices.
- An explicit bot stop/delete sweep can transfer remaining SOL and standard SPL token balances to the dev wallet when `ENABLE_LIVE_SWEEP=true`.
- Both transfer mechanisms are disabled by default. The dashboard and API expose the configured destination, but do not initiate live transfers unless the environment flags are deliberately enabled.

## Install/run
1. Use Node.js 20 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` locally or enter values in your hosting provider's environment settings.
4. Set `WALLET_ENCRYPTION_KEY` to 64 hex characters (`openssl rand -hex 32`) and `ADMIN_API_TOKEN` to a long random secret.
5. Start on devnet: `SOLANA_NETWORK=devnet`, `SOLANA_RPC_URL=https://api.devnet.solana.com`, then `npm start`.
6. Run `npm test` and `npm run check`.

Never commit `.env`, private keys, or admin tokens. The JSON database is ephemeral on some hosts unless persistent storage is configured; back it up securely. Losing the encryption key can make bot wallets unrecoverable.

## Transfer API
- `GET /api/config` shows transfer policy and destination (never secrets).
- `POST /api/bots/:id/realized-profit-fee` requires admin bearer token and `{ "realizedProfitSol": 0.1, "confirm": true }`. It transfers 10% of that positive SOL profit to the dev wallet only if `ENABLE_DEV_FEE_TRANSFERS=true`. **Only trusted server-side swap settlement code should call this endpoint**; do not expose it to untrusted clients as a way to report arbitrary profits.
- `POST /api/bots/:id/sweep` requires admin bearer token and `{ "confirm": true }`. When `ENABLE_LIVE_SWEEP=true`, transfers the bot wallet's SOL (minus a fee reserve) and standard SPL token balances to the dev wallet. It does not close positions or sell tokens; it transfers holdings as-is.
- `DELETE /api/bots/:id` never silently sweeps. A separate explicit sweep call is required first.

## Live trading status
`/api/status` reports `liveTradingEnabled: false`. This is intentional. Transfer plumbing is not a swap/trading engine; enabling automatic buys/sells without a vetted execution adapter, risk limits, token checks, idempotency, and devnet tests could lose funds. Do not set the dashboard to claim live trading works until that integration exists and is verified.
