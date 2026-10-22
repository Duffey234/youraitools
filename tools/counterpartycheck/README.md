# CounterpartyCheck

**Is it safe for your agent to pay this address?** Pre-payment due diligence for AI agents over x402: before paying, approving or interacting with an EVM (Base, Ethereum, Polygon, Arbitrum One) or Solana address, one call returns **ok / caution / block** with reasons, a confidence and `missing_data`.

- Live: https://api.youraitools.co/counterpartycheck (also https://counterparty.agentgate.workers.dev)
- Paid (USDC on Base or Solana; Polygon and Arbitrum One also accepted; x402 v2 and v1, or a prepaid credits key):
  - `GET|POST /v1/lite` **$0.005**: OFAC SDN + ScamSniffer + x402 Bazaar payee directory + labels + what the address is (wallet, contract, token contract, Safe, EIP-7702, Solana mint / program / token account, USDC readiness)
  - `GET|POST /v1/quick` **$0.015**: lite + Sourcify verification and deployer screening, ENS / Basename (forward-verified), cross-chain presence (wrong-chain protection), Safe owner / contract owner / delegate screening, Blockscout tags
  - `GET|POST /v1/full` **$0.05**: quick + age, recent activity and exposure to listed addresses, recent approvals to the address (drainer pattern), TokenVerdict for Base tokens
- Free: `GET /v1/preview` (verdict, confidence, kind, flag counts; 10/min per IP), remote MCP `POST /mcp` (`check_counterparty`), `/openapi.json`, `/.well-known/x402`, `/v1/stats`.

Parameters: `address` (required), `chain` = base | ethereum | polygon | arbitrum | solana (default base; base58 implies solana), `intent` = pay | approve | interact (default pay).

```bash
curl -s "https://api.youraitools.co/counterpartycheck/v1/preview?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96&chain=ethereum"
curl -i "https://api.youraitools.co/counterpartycheck/v1/quick?address=0x...&chain=base&intent=pay"   # 402 terms; any x402 client pays
curl -s -H "Authorization: Bearer $YATC_KEY" "https://api.youraitools.co/counterpartycheck/v1/quick?address=0x..."   # prepaid credits
```

## MCP

```json
{ "mcpServers": { "counterpartycheck": { "type": "http", "url": "https://api.youraitools.co/counterpartycheck/mcp" } } }
{ "mcpServers": { "counterpartycheck": { "command": "npx", "args": ["-y", "@agentgate-builder/counterpartycheck"] } } }
```

The stdio server returns the free preview. Set `COUNTERPARTYCHECK_X402_PRIVATE_KEY` (a Base wallet with a little USDC; needs `@x402/fetch`, `@x402/evm`, `viem`) and it pays the quick report per call ($0.015, at most $0.02 per payment, only to our payTo). Docker: `docker build -t counterpartycheck-mcp . && docker run -i --rm counterpartycheck-mcp`.

## How it degrades

Every optional source (Sourcify, Blockscout, ENS / Basename, other chains, archive RPCs, TokenVerdict) has a tight timeout. A failed source is listed in `missing_data` and lowers `confidence`; it never reads as a clean result. If the chain RPC itself is down, paid routes answer 503 and nothing is charged. Malformed input is a 400 before the 402.

## Data and licenses

Free public data only: bundled OFAC SDN snapshot (from PayGuard), ScamSniffer scam-database addresses, a CDP x402 Bazaar catalog snapshot, public RPCs (read-only), Sourcify, Blockscout public API, TokenVerdict. Code: MIT. `src/data/scamsniffer.js` is ScamSniffer data under **GPL-3.0** (https://github.com/scamsniffer/scam-database), redistributed unmodified as a lookup set. Rebuild snapshots: `python3 scripts/build-data.py`.

A safety check only: no price data, no trading signals. Automated signals, not legal, compliance or financial advice; "ok" means no known risk signal was found, not a guarantee.
