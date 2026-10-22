# x402fix: x402 endpoint doctor

<img src="logo.svg" width="64" alt="x402fix logo">

Point x402fix at any paid [x402](https://x402.org) URL and it tells you, in order of severity, what will break payments or keep the route out of the Bazaar / x402scan, and how to fix each problem. It probes the route **without paying**: GET, HEAD, an empty POST, POST `{}` and a CORS preflight. Then it grades the route A to F.

- **Transport:** 402 on GET, HEAD and empty POST; CORS preflight; `Access-Control-Expose-Headers: PAYMENT-REQUIRED`; cacheable 402s; redirects; auth walls; latency.
- **x402 v2:** PAYMENT-REQUIRED header; `resource.url`; CAIP-2 networks; `amount` given as a string of atomic units; canonical USDC asset; the EIP-712 domain (`extra.name` and `extra.version`) for each chain; `payTo` format; Solana `extra.feePayer`; `maxTimeoutSeconds`.
- **x402 v1:** JSON body; `maxAmountRequired`; network names; whether v1 and v2 terms agree.
- **Bazaar:** `extensions.bazaar` info and schema. It validates `info` against `schema` (JSON Schema 2020-12), flags external `$ref` and old drafts, and checks method and input/output consistency.
- **Multichain:** price drift across networks, duplicate entries, networks the CDP facilitator doesn't settle, and which of Base, Polygon, Arbitrum One and Solana you accept.
- **Check tier extras:** the CDP facilitator's own `validate` verdict and Bazaar index status, payee checks (EVM contract vs wallet, whether the Solana USDC token account exists, CounterpartyCheck screening), drift between `/openapi.json` and `/.well-known/x402`, a **generated, self-validated `extensions.bazaar` block**, and a multichain `accepts` snippet for Hono, Express or Next.

Live API: **https://api.youraitools.co/x402fix** (origin: https://x402fix.agentgate.workers.dev)

| Route | Price (USDC) | Returns |
|---|---|---|
| `GET /v1/preview?url=` | free, 10/min | grade, score, status, counts, detected versions and networks |
| `GET|POST /v1/lite?url=` | $0.005 | every check plus a numbered fix list |
| `GET|POST /v1/check?url=&framework=hono` | $0.02 | lite + CDP verdict, payee checks, docs drift, generated Bazaar block and accepts |
| `GET|POST /v1/site?url=https://origin` | $0.05 | finds up to 8 paid routes from `/.well-known/x402` and `/openapi.json`, grades each, checks doc drift |

Payment: x402 v2 or v1, exact USDC on Base, Polygon, Arbitrum One or Solana. Prepaid credits (`Authorization: Bearer`) are also accepted, via https://api.youraitools.co/credits.

## MCP

- Remote: `https://api.youraitools.co/x402fix/mcp` (tool `check_x402_endpoint`, free preview)
- stdio: `npx -y @agentgate-builder/x402fix`. Set `X402FIX_X402_PRIVATE_KEY` to a Base wallet key holding a little USDC, and it pays for check reports ($0.02 each).
- Docker: `docker build -t x402fix-mcp . && docker run -i --rm x402fix-mcp`

## CI

```sh
curl -s "https://api.youraitools.co/x402fix/v1/preview?url=https://your.api/v1/paid" | jq -e '.status != "broken"'
```

## Notes

- Probes are unpaid and never send payment headers. Private, loopback and link-local hosts are refused, and ports are limited to 80, 443, 8080, 8443, 3000, 8000 and 8787.
- Fixes are suggestions. A passing grade does not guarantee listing or settlement.

Develop: `npm test`; `npm start` (Node, port 8795); `npx wrangler deploy`. MIT.
