# Venue adapters

Jupiter is implemented in `engine.js` (quote → swap → sign → confirm). Possible next adapters:

Recommended integration order:
1. **Jupiter Swap API** for supported routed swaps on Solana. Review current API docs, key/rate limits, transaction signing, slippage, and execution requirements. Verify whether the exact token/market is routable before placing any order.
2. **Raydium** adapter using its supported SDK/API for supported pools.
3. **Orca** adapter using its supported SDK/API for supported Whirlpool pools.
4. **pump.fun** launch/curve monitoring and execution as a separate adapter. Do not assume Jupiter's ordinary swap endpoint supports every bonding-curve launch or every migration state. Confirm current supported integration and platform terms before implementing.

Every adapter should implement:
- `discover()` — find candidate assets from a documented/authorized source
- `quote()` — estimate output, fees, slippage, and route
- `simulate()` — reject unsafe or malformed transactions where simulation is supported
- `execute()` — only after an explicit live-trading safety gate and secure signing
- `status()` — report latency, errors, and source health

Never attempt to bypass a venue's access controls or anti-bot protections. Use documented interfaces, obey rate limits, and handle HTTP 429 responses with bounded backoff.
