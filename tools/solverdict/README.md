# SolVerdict

**Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it.** SAFE / CAUTION / DANGER verdicts with reasons, paid per call over x402. SAFE is not a guarantee and not financial advice.

- Live: https://api.youraitools.co/solverdict (also https://solverdict.agentgate.workers.dev)
- Paid (USDC on Base or Solana; Polygon and Arbitrum One also accepted; x402 v2 and v1, or a prepaid [YourAITools credits](https://api.youraitools.co/credits/) key via `Authorization: Bearer`):
  - `GET|POST /v1/lite?mint=` **$0.005**: SAFE / CAUTION / DANGER, score 0-100, reasons and key facts
  - `GET|POST /v1/check?mint=` **$0.02**: full report: mint / freeze authority, every Token-2022 extension with its authority (transfer fee, permanent delegate, transfer hook, default-frozen accounts, pausable, non-transferable, close authority), Metaplex / Token-2022 metadata update authority, DEX pools with liquidity and 24 h buys vs sells (pump.fun bonding curve aware), the 20 largest holders split into wallets vs program accounts (pools, bonding curves, vaults), age, data sources and limits
- Free: `GET /v1/preview?mint=` (verdict, score, flag counts; 10/min per IP), shareable card `/t/<mint>` (+ `/t/<mint>/card.svg`, OG image), remote MCP `POST /mcp` (`check_solana_token`), `/openapi.json`, `/.well-known/x402`, `/v1/stats`, `/health?sources=1`.

Only HTTP 200 results are settled: malformed addresses (400), non-mint accounts (422) and RPC outages (503) are never charged.
A source that does not answer is never read as clean: the verdict can't be SAFE on incomplete data, and `missing_data` lists what's missing.

## Why
Solana launches (pump.fun and friends) are where agents and humans most often buy brand-new tokens. The ways a Solana token traps buyers are visible on chain: an active freeze authority (holders can be frozen so they can't sell), an active mint authority (unlimited dilution), Token-2022 permanent delegates (can take tokens from any wallet), transfer hooks (custom code on every transfer), transfer fees, default-frozen accounts, pausable mints. SolVerdict reads all of that in one call, adds liquidity / sells / holder concentration, and returns a verdict an agent can gate on.

## MCP
```json
{ "mcpServers": { "solverdict": { "type": "http", "url": "https://api.youraitools.co/solverdict/mcp" } } }
{ "mcpServers": { "solverdict": { "command": "npx", "args": ["-y", "@agentgate-builder/solverdict"] } } }
```
The stdio server (`npx @agentgate-builder/solverdict`, Docker: `docker build -t solverdict-mcp .`) returns the free preview; set `SOLVERDICT_X402_PRIVATE_KEY` (a Base wallet key with a little USDC) and it pays the full `/v1/check` report per call ($0.02, capped, only to our payee).

## Data (free public sources only)
Public Solana RPC (read-only account queries; nothing is signed or sent) and the DexScreener public API, with Raydium's public API v3 and the on-chain pump.fun bonding curve account as fallbacks when DexScreener rate-limits. No paid upstream, no scraping.

## Limits
No swap is simulated; sell blocking is inferred from on-chain controls and recent sells. A transfer hook's logic is not analyzed. Exchange and team wallets look like other wallets. LP lock status is not checked. Informational, not financial advice, not an audit.

## Develop
`npm test` (node --test; offline mocks + recorded fixtures) · `npx wrangler deploy` · `node tools/gen-og.mjs`

MIT · by agentgate-builder · hello@youraitools.co
