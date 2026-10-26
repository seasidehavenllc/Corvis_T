# Corvis Trading — starter kit

Standalone project; not connected to Corvis AI.

## What is included
- Mobile-friendly dashboard
- Express backend API
- Create bot profiles and set venue, public wallet address, take-profit, stop-loss, and max position
- Pause/start controls that only toggle a paper-mode profile
- Health endpoint at `/health`
- Venue-adapter plan for Jupiter, Raydium, Orca, and pump.fun

## Important limitations
This is a **paper-mode starter**, not a live sniper bot. It does not listen for new launches, fetch live token prices, connect Phantom, sign transactions, or buy/sell tokens. The Start button only changes the demo profile status. Bot profiles and activity events live in memory and reset when the server restarts/redeploys.

The 1.45x take-profit setting means a target price 45% above entry before network fees, priority fees, trading fees, slippage, failed transactions, and other costs. It does not guarantee a profitable exit.

## Run locally
1. Install Node.js 20 or newer.
2. Extract this ZIP.
3. In this folder run `npm install`.
4. Copy `.env.example` to `.env` if desired; leave `APP_MODE=paper`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Easy hosting: Railway
Railway is a straightforward option for the backend because it supports long-running services and environment variables.
1. Create a GitHub repository for this project and upload the extracted files. Keep `.env`, private keys, seed phrases, and API secrets out of GitHub.
2. In Railway, create a project and deploy from that GitHub repository.
3. Railway should detect `package.json` and run `npm start`. Set `APP_MODE=paper` in the service Variables.
4. Generate a public domain for the service and open it. The dashboard and API are served by the same Node service.
5. Keep the service running; use Railway's usage/pricing page to check current costs before deploying. This is not guaranteed to be free.
6. Add a database before relying on saved profiles. This starter uses in-memory data and resets on restart/deploy.

## GitHub Pages?
GitHub Pages can host only the static dashboard files; it cannot run this Node backend or keep a trading worker alive. For the easiest first deployment, serve both the dashboard and backend from Railway. Later, the frontend can be moved to GitHub Pages while the API/worker remains on an always-on host.

## Before any live trading is added
- Add user authentication and API authorization.
- Persist bot configuration and trade/event records in a database.
- Use a dedicated low-balance wallet, transaction simulation, position-size caps, daily loss limits, slippage/priority-fee caps, duplicate-order protection, and a global kill switch.
- Keep signer material in a server-side secret manager or use a wallet-signing service; never put seed phrases/private keys in HTML, frontend JavaScript, public repositories, logs, or chat.
- Confirm the selected wallet-signing workflow supports unattended trading. A public Phantom address alone cannot authorize transactions.
- Add real monitoring, alerts, RPC failover, retries with limits, and venue-specific adapter tests.
- Review current platform terms and API documentation. Do not bypass anti-bot controls.

## Documentation
- Railway deploy: https://docs.railway.com/build-deploy
- Railway variables: https://docs.railway.com/variables
- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Jupiter Swap API: https://developers.jup.ag/docs/swap
- pump.fun API terms: https://docs.pump.fun/terms/
