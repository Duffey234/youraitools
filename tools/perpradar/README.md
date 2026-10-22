# PerpRadar: perp funding rates, open interest and positioning for trading agents (x402 API + MCP)

Perpetual futures funding radar across the onchain perp venues **Hyperliquid, dYdX v4, Paradex and Aevo**. One call returns
funding normalized to **8h % and APR**, open interest, mark/index premium, the cross-venue median, spread, the cheapest venue to
be long or short and a positioning read (crowded long / long bias / neutral / short bias / crowded short). The full tier adds
7-day funding history with z-score and percentile, the funding regime and carry; the scan finds funding extremes and the widest
cross-venue spreads across the whole market.

> **Not financial advice. Past performance does not guarantee future results.** Read-only market analytics from public venue
> data. PerpRadar never trades, never holds funds and never asks for keys.

- API: https://api.youraitools.co/perpradar (fallback https://perpradar.agentgate.workers.dev)
- Remote MCP: `https://api.youraitools.co/perpradar/mcp` (tool `perp_positioning`, free preview)
- stdio MCP: `npx -y @agentgate-builder/perpradar` (tools `perp_funding`, `perp_funding_scan`)
- OpenAPI: `/openapi.json` · x402 manifest: `/.well-known/x402`

## Routes and prices

| Route | Price | Returns |
|---|---|---|
| `GET /v1/lite?symbol=BTC` | $0.005 | per-venue funding (8h %, APR) and OI, median and OI-weighted funding, spread, cheapest venue for longs/shorts, positioning |
| `GET /v1/full?symbol=ETH` | $0.03 | lite + mark/index premium, 24h volume, Hyperliquid 7-day and dYdX 100-hour funding history (mean, min, max, z-score, percentile), regime, carry |
| `GET /v1/scan?universe=all` or `?symbols=BTC,ETH,SOL` | $0.02 | highest / lowest funding, widest cross-venue spreads, market-wide OI-weighted funding |
| `GET /v1/preview?symbol=BTC` | free (10/min/IP) | positioning label, venues, confidence (no rates) |

All paid routes accept POST with the same fields as JSON. Payment: x402 v2 (`PAYMENT-SIGNATURE`; USDC on Base, Polygon,
Arbitrum One or Solana) or v1 (`X-PAYMENT`, Base), or a prepaid YourAITools credits key (`Authorization: Bearer yatc_...`).
Bad input (400), unknown symbols (404) and upstream failures (503) are never charged.

## Fail-closed

A venue that errors or times out is listed in `sources_failed` and left out: never estimated. The cross-venue read needs at
least 2 venues (otherwise `positioning: "unknown"`, confidence low). No venue at all = HTTP 503 `upstream_unavailable`, not charged.

## stdio MCP paid mode

Set `PERPRADAR_X402_PRIVATE_KEY` (a Base wallet with a little USDC) and install the optional peers:
`npx -y -p @agentgate-builder/perpradar -p @x402/fetch -p @x402/evm -p viem perpradar`. Spend guard: Base USDC only,
max $0.03 per payment, only to the PerpRadar payTo.

## Develop

`npm test` (offline mocks) · `npm start` (Node server) · `wrangler deploy` (Cloudflare Worker).

MIT. Data: public market-data APIs of Hyperliquid, dYdX v4 indexer, Paradex and Aevo.
