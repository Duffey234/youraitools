# AgentGate paid API (x402)

**Live:** https://agentgate.agentgate.workers.dev (paid route `https://agentgate.agentgate.workers.dev/v1/check-agent`, plus free `/health` and `/lax-offer.json`). **Bazaar:** listed on PayAI ([listing status](https://facilitator.payai.network/discovery/listing-status?resource=https://agentgate.agentgate.workers.dev/v1/check-agent)).

`check_agent` as a pay-per-call HTTP API: **$0.005 USDC per call on Base mainnet**, paid over [x402](https://docs.x402.org) v2, paid to `0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F`.

- **Official packages:** `@x402/hono`, `@x402/core`, `@x402/evm` (exact scheme, EIP-3009, gasless for the buyer) and `@x402/extensions` (Bazaar discovery).
- **Facilitator:** [PayAI](https://facilitator.payai.network). It supports Base mainnet with no API key and gives each receiving wallet 1,000 free credits.
  - The CDP facilitator also works, but it needs CDP API keys, i.e. a Coinbase Developer Platform account.
  - `x402.org/facilitator` is testnet-only.
- **Registry lookups:** made with the same real Concordium provider as the library (`../src/registry.js`).
- **Runtimes:** runs on Cloudflare Workers (`src/worker.js`) or Node (`src/node.js`).

| Route | Price | What |
|---|---|---|
| `GET /v1/check-agent?id=<badge or account>&network=mainnet\|testnet\|devnet` | **0.005 USDC** | Concordium Agent Registry verdict (`verified`, `found`, `active`, `cardHashMatches`, owner, issues) |
| `GET /v1/check-agent/preview?id=<badge or account>&network=…` | **free** (20/min per IP) | The verdict only: `verified`, `found`, `active`, `cardHashMatches`, issues. Try it without a wallet. |
| `POST /mcp` | **free** (20/min per IP) | Remote MCP server (Streamable HTTP, stateless JSON) with the `check_agent` tool (free-tier verdict) |
| `GET /v1/stats` | free | Public usage counters (402 challenges, paid calls, free calls) for the last 30 days |
| `GET /` | free | Service info |
| `GET /health` | free | Liveness |
| `GET /lax-offer.json` | free | [LAX](https://lax.kognai.ai) offer for this endpoint (Five Laws in `constitutional_constraints`) |

How charges work:

- An unpaid call gets a `402` with `PAYMENT-REQUIRED`, which contains the x402 v2 terms and a Bazaar `extensions.bazaar` declaration.
- A paid call is verified, served, then settled. The response carries `PAYMENT-RESPONSE`.
- Invalid input (`400`) and registry outages (`502`) are **never settled**, so the buyer isn't charged.

## Run

```bash
npm install
npm test                       # offline: fake facilitator + the official @x402/fetch client with a throwaway key
PORT=8787 npm start            # Node
npx wrangler dev               # Workers runtime, locally
```

Pay for a call from any x402 v2 client, for example:

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.KEY)) }] });
const r = await pay('https://<host>/v1/check-agent?id=Mf22soLh1NuZYFgBK8iSs');
```

## Deploy (Cloudflare Workers, free plan)

Deployed with the `deploy-worker` workflow on every push to `service/`. The repo secrets are set.


1. Create a Cloudflare account and an API token with the "Edit Cloudflare Workers" template.
2. Add the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then run the `deploy-worker` workflow. Alternatively, deploy locally with `CLOUDFLARE_API_TOKEN=... npx wrangler deploy`.
3. Set `PUBLIC_URL` in `wrangler.toml` to the deployed origin, so the 402's `resource.url` is stable (no query string).

## Bazaar listing (PayAI)

PayAI catalogs a resource from a payment payload that echoes the `bazaar` declaration. It catalogs on `/verify` as well as `/settle`, and for a `GET` resource that answers `402` unpaid, a verify-only payment is enough. The verify does have to pass, though, so the paying wallet must hold at least 0.005 USDC on Base.

```bash
PAYER_PRIVATE_KEY=... node scripts/bazaar-index.js https://<host>/v1/check-agent           # verify-only, moves no funds
PAYER_PRIVATE_KEY=... node scripts/bazaar-index.js https://<host>/v1/check-agent --settle  # one real 0.005 USDC call
```

Then check `https://facilitator.payai.network/discovery/listing-status?resource=https://<host>/v1/check-agent`.

## Notes

- On Workers, `@x402/hono` logs a one-time "Error compiling schema" at startup. That's its optional Bazaar route self-check, which uses Ajv code generation and is blocked by the Workers runtime. It's harmless: the 402 and its declaration are unaffected. The same declaration is validated with the official validator in `npm test` (Node).
