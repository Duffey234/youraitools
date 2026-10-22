# TASignal: technical indicators, risk metrics, position sizing and backtests for crypto trading agents (x402 API + MCP)

One pay-per-call API for the chart work a trading agent does before it acts:

- **Indicators** on closed 15m / 1h / 4h / 1d candles: RSI 14, MACD 12/26/9 (with cross), EMA 20/50/200, SMA 20, Bollinger Bands 20/2
  (%b, bandwidth), ATR 14 and ATR %, ADX 14 (+DI/-DI), stochastic %K, annualized realized volatility, volume vs 20-bar average,
  plus a descriptive technical bias score (-100..100) with components, trend and regime.
- **Risk and sizing**: historical VaR / CVaR 95/99 (per bar and per day), volatility, max and current drawdown, Sharpe / Sortino,
  ATR(14) stop or your stop, units, USD notional, implied leverage, 2R / 3R levels.
- **Backtests**: `sma_cross`, `ema_cross`, `rsi_reversion`, `breakout` (Donchian), `macd_cross` on up to 2000 candles, long-only or
  long/short, fees per side, signals on close and fills at the next open. Return vs buy-and-hold, max drawdown, Sharpe, win rate,
  profit factor, exposure, the last 20 trades and an equity curve.

> **Not financial advice. Past performance does not guarantee future results.** Indicators, risk metrics and backtests describe
> historical prices only. TASignal is read-only: it never trades, never holds funds and never asks for keys.

- API: https://api.youraitools.co/tasignal (fallback https://tasignal.agentgate.workers.dev)
- Remote MCP: `https://api.youraitools.co/tasignal/mcp` (tool `ta_bias`, free preview)
- stdio MCP: `npx -y @agentgate-builder/tasignal` (tools `ta_indicators`, `ta_position_size`, `ta_backtest`)
- OpenAPI: `/openapi.json` · x402 manifest: `/.well-known/x402`

## Routes and prices

| Route | Price | Example |
|---|---|---|
| `/v1/lite` | $0.005 | `?symbol=BTC&timeframe=1h` |
| `/v1/risk` | $0.02 | `?symbol=ETH&timeframe=4h&account_usd=10000&risk_pct=1&side=long` |
| `/v1/backtest` | $0.05 | `?symbol=SOL&timeframe=4h&strategy=ema_cross&fast=20&slow=50` |
| `/v1/preview` | free (10/min/IP) | `?symbol=BTC&timeframe=1h` (bias, trend, regime only) |

All paid routes accept POST with the same fields as JSON. Payment: x402 v2 (`PAYMENT-SIGNATURE`; USDC on Base, Polygon,
Arbitrum One or Solana) or v1 (`X-PAYMENT`, Base), or a prepaid YourAITools credits key (`Authorization: Bearer yatc_...`).
Bad input (400), unknown symbols (404) and upstream failures (503) are never charged.

## Data and fail-closed behaviour

Candles come from Hyperliquid (`candleSnapshot`), with the dYdX v4 indexer as fallback; the source is named in every answer.
If Hyperliquid fails, the answer says so in `sources_failed` and confidence drops. If no source answers: HTTP 503
`upstream_unavailable`, not charged. Only closed candles are used. An indicator that needs more history than is available is
`null` with a note, never extrapolated.

## stdio MCP paid mode

Set `TASIGNAL_X402_PRIVATE_KEY` (a Base wallet with a little USDC) and install the optional peers:
`npx -y -p @agentgate-builder/tasignal -p @x402/fetch -p @x402/evm -p viem tasignal`. Spend guard: Base USDC only,
max $0.05 per payment, only to the TASignal payTo.

## Develop

`npm test` (offline mocks) · `npm start` (Node server) · `wrangler deploy` (Cloudflare Worker). MIT.
