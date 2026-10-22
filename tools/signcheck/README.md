# SignCheck: is it safe to sign this?

Pre-sign safety check for AI agent wallets, paid per call over [x402](https://x402.org) (USDC on Base), with a free preview and an MCP server.

An agent with a wallet is one signature away from an unlimited approval to a drainer, a "free" NFT listing, an EIP-7702 account takeover, or an x402 payment 1,000x the price it was quoted. SignCheck decodes what the agent is about to sign into plain English and returns **SAFE / CAUTION / DANGER** with the reasons.

- **Live API:** https://api.youraitools.co/signcheck (also https://signcheck.agentgate.workers.dev)
- **Price:** $0.015 per full check, $0.005 per offline lite check (USDC on Base, x402 v2 + v1). Invalid input and RPC outages are never charged.
- **Free:** `/v1/preview` (offline verdict, summary and flag codes, 10/min per IP) and remote MCP at `/mcp`.
- **npm:** `@agentgate-builder/signcheck` (stdio MCP server, `npx -y @agentgate-builder/signcheck`)
- **Source:** https://agentgate-source.pages.dev/x402-signcheck/ (MIT)

## What it checks

| Input | Examples of what gets flagged |
|---|---|
| `tx` `{to, data, value, from}` | unlimited `approve`, approvals / Permit2 allowances to plain wallets (EOAs), `setApprovalForAll`, transfers to the token contract or the zero address, ownership transfers, proxy upgrades, Safe DELEGATECALL, unknown functions (with the public 4-byte name), multicall / Multicall3 / Safe inner calls, eth_call simulation with revert reason |
| `typed_data` (EIP-712) | EIP-2612 Permit, DAI permit, Permit2 PermitSingle / PermitBatch / (Witness)TransferFrom, EIP-3009 TransferWithAuthorization (x402), Seaport orders with zero price, never-expiring deadlines, missing or mismatched chainId, fake "USD Coin" domains, Permit2 lookalikes |
| `authorization` (EIP-7702) | delegation to an unknown contract, chainId 0 (valid on every chain) |
| `payment_required` + `payment_payload` (x402) | payTo mismatch, overpay, wrong asset or network, non-Circle "USDC", validity far beyond `maxTimeoutSeconds`, unusually high price |

Every address involved is listed with its role, EOA / contract / 7702-delegated status, a known-protocol label, and an OFAC SDN match (bundled US Treasury list). On-chain facts and simulation cover Base, Ethereum and Base Sepolia; any other EVM chain is decoded offline.

## Quick start

```bash
# free preview (offline)
curl -s -X POST https://api.youraitools.co/signcheck/v1/preview -H 'content-type: application/json' \
  -d '{"tx":{"to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","data":"0x095ea7b30000000000000000000000003c1a1e01e790cd326495631b3b38bd7068f08d6fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}}'

# paid: answers 402 with x402 terms; any x402 client pays it
curl -i -X POST https://api.youraitools.co/signcheck/v1/check -H 'content-type: application/json' -d @tx.json
```

Check an x402 payment before your client sends it:

```js
const r = await pay('https://api.youraitools.co/signcheck/v1/check', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ payment_required: res.headers.get('payment-required'), payment_payload: paymentHeader }),
});
const { verdict, flags, x402 } = await r.json(); // x402.matches === true when the signature pays exactly what the 402 asked
```

### MCP

```json
{ "mcpServers": { "signcheck": { "type": "http", "url": "https://api.youraitools.co/signcheck/mcp" } } }
```
```json
{ "mcpServers": { "signcheck": { "command": "npx", "args": ["-y", "@agentgate-builder/signcheck"] } } }
```

Tool `check_signature`. The free servers return the offline preview. Set `SIGNCHECK_X402_PRIVATE_KEY` (a Base wallet with a little USDC) in the stdio server's env and it pays the API per call (max $0.02 per payment, only to the SignCheck pay-to address). Paid mode needs `@x402/fetch`, `@x402/evm` and `viem`: `npx -y -p @agentgate-builder/signcheck -p @x402/fetch -p @x402/evm -p viem signcheck`.

Docker: `docker build -t signcheck-mcp . && docker run -i --rm signcheck-mcp`

## Endpoints

| Route | Price | |
|---|---|---|
| `POST /v1/check` (JSON body) / `GET /v1/check?to=&data=&value=&from=&chain=` | $0.015 | full check |
| `POST /v1/lite` / `GET /v1/lite?…` (same inputs) | $0.005 | offline: every reason, decoded args, counterparties, x402 payment-vs-402 match, OFAC SDN; no RPC or simulation |
| `POST|GET /v1/preview` | free, 10/min/IP | offline verdict, summary, flag codes |
| `POST /mcp` | free | remote MCP (Streamable HTTP, stateless) |
| `/openapi.json`, `/.well-known/x402`, `/v1/stats`, `/health` | free | discovery, usage counters |

`HEAD /v1/check` returns the same 402 + `PAYMENT-REQUIRED` header as GET.

## Limits and honesty

- Read-only. SignCheck never asks for keys or signatures and never sends transactions.
- SAFE means no known-bad pattern was found, not that the counterparty is trustworthy. Labels are a short list of well-known protocol contracts, not an endorsement. Not financial or legal advice.
- The simulation is a single `eth_call` against the latest block (no state diff / balance-change tracing yet).
- The OFAC SDN list is a bundled snapshot (EVM addresses, list date in `/health`), rebuilt with `scripts/build-sdn.py`.

## Development

```bash
npm test            # 47 tests, offline (fake RPC + fake facilitator)
npx wrangler deploy # Cloudflare Workers; counters in a SQLite Durable Object (no KV)
node scripts/live-check.mjs
```

Part of the agent trust kit by agentgate-builder: AgentGate, WebRead, InjectScan, DomainCheck, PayGuard, PkgGuard, StackDetect, TokenVerdict and SignCheck. Contact: hello@youraitools.co
