# YourAITools: pay-per-call x402 tools for AI agents

YourAITools is a set of small, single-purpose APIs that AI agents pay for per call with
[x402](https://x402.org) (HTTP 402 Payment Required + a USDC payment). There's no signup, no API key and
no subscription. An agent calls a paid route, gets a `402` with the payment requirements, pays in USDC
and gets the answer.

- **API:** https://api.youraitools.co (each tool lives under its own path, e.g. `https://api.youraitools.co/webread/`)
- **Website and directory:** https://youraitools.co
- **Browsable source mirror:** https://agentgate-source.pages.dev

Every tool in this repository is a Cloudflare Worker (Hono, x402 v2 with a v1 fallback), with a free
preview route, OpenAPI, `/.well-known/x402` discovery, a remote MCP server at `/mcp` and, for most tools,
a stdio MCP server.

## Tools

Prices are in USDC per call. They come from each tool's `wrangler.toml` / `src/config.js` and match what the
live API charges today. `GET|POST` means both methods are accepted at the same price.

| Tool | What it does | Paid routes and prices | Landing page |
|---|---|---|---|
| [AgentGate](tools/agentgate/) | Checks whether an AI agent is registered, Active and Verified in the Concordium Agent Registry | `GET /v1/check-agent` $0.005 | [api.youraitools.co/agentgate/](https://api.youraitools.co/agentgate/) |
| [WebRead](tools/webread/) | Reads any public web page as clean Markdown (robots.txt-aware, SSRF-safe) | `GET /v1/read` $0.002 | [api.youraitools.co/webread/](https://api.youraitools.co/webread/) |
| [InjectScan](tools/injectscan/) | Scans text, web pages and MCP tool definitions for prompt injection | `GET\|POST /v1/scan` $0.003 | [api.youraitools.co/injectscan/](https://api.youraitools.co/injectscan/) |
| [DomainCheck](tools/domaincheck/) | Domain and email trust checks: DNS, SPF/DMARC, registration age, disposable mail | `GET /v1/domain` $0.002, `GET /v1/email` $0.001 | [api.youraitools.co/domaincheck/](https://api.youraitools.co/domaincheck/) |
| [PayGuard](tools/payguard/) | OFAC SDN sanctions screening for crypto addresses (informational, not legal advice) | `GET /v1/address` $0.001, `POST /v1/batch` $0.01 (up to 50 addresses) | [api.youraitools.co/payguard/](https://api.youraitools.co/payguard/) |
| [PkgGuard](tools/pkgguard/) | Known vulnerabilities and confirmed-malicious packages in a manifest or lockfile (OSV.dev data) | `POST /v1/scan` $0.003, `GET /v1/package` $0.001 | [api.youraitools.co/pkgguard/](https://api.youraitools.co/pkgguard/) |
| [StackDetect](tools/stackdetect/) | Website technology detection: CMS, frameworks, hosting/CDN, analytics, payments, email and DNS providers | `GET\|POST /v1/detect` $0.003 | [api.youraitools.co/stackdetect/](https://api.youraitools.co/stackdetect/) |
| [TokenVerdict](tools/tokenverdict/) | Base ERC-20 token safety check (honeypot / sell simulation, taxes, owner powers, liquidity, holders) | `GET /v1/lite` $0.005, `GET /v1/quick` $0.015, `GET /v1/deep` $0.05 | [api.youraitools.co/tokenverdict/](https://api.youraitools.co/tokenverdict/) |
| [SignCheck](tools/signcheck/) | Pre-sign check for agent wallets: transactions, Permit / Permit2 / EIP-3009 signatures, EIP-7702, x402 payments | `GET\|POST /v1/check` $0.015, `GET\|POST /v1/lite` $0.005 (offline) | [api.youraitools.co/signcheck/](https://api.youraitools.co/signcheck/) |
| [CounterpartyCheck](tools/counterpartycheck/) | Pre-payment due diligence on an EVM or Solana address: ok / caution / block with reasons | `GET\|POST /v1/lite` $0.005, `/v1/quick` $0.015, `/v1/full` $0.05 | [api.youraitools.co/counterpartycheck/](https://api.youraitools.co/counterpartycheck/) |
| [x402fix](tools/x402fix/) | x402 endpoint doctor for sellers: grades a paid x402 URL A-F with paste-ready fixes (unpaid probes only) | `GET\|POST /v1/lite` $0.005, `/v1/check` $0.02, `/v1/site` $0.05 | [api.youraitools.co/x402fix/](https://api.youraitools.co/x402fix/) |
| [SolVerdict](tools/solverdict/) | Solana SPL / Token-2022 mint safety check (authorities, Token-2022 traps, liquidity, holders) | `GET\|POST /v1/lite` $0.005, `/v1/check` $0.02 | [api.youraitools.co/solverdict/](https://api.youraitools.co/solverdict/) |
| [AgentReady](tools/agentready/) | Website AI-agent readiness audit: 23 checks, a 0-100 score and grade, with fixes | `GET\|POST /v1/lite` $0.005, `/v1/audit` $0.03 | [api.youraitools.co/agentready/](https://api.youraitools.co/agentready/) |
| [PerpRadar](tools/perpradar/) | Perp funding radar: normalized funding, open interest and cross-venue spreads (Hyperliquid, dYdX v4, Paradex, Aevo) | `GET\|POST /v1/lite` $0.005, `/v1/full` $0.03, `/v1/scan` $0.02 | [api.youraitools.co/perpradar/](https://api.youraitools.co/perpradar/) |
| [TASignal](tools/tasignal/) | Technical analysis, risk metrics and rule backtests on public candles | `GET\|POST /v1/lite` $0.005, `/v1/risk` $0.02, `/v1/backtest` $0.05 | [api.youraitools.co/tasignal/](https://api.youraitools.co/tasignal/) |
| [LeakGuard](tools/leakguard/) | Finds and redacts wallet keys, seed phrases, API secrets and PII before text reaches an LLM, tool or log | `GET\|POST /v1/lite` $0.005, `/v1/scan` $0.02 | [api.youraitools.co/leakguard/](https://api.youraitools.co/leakguard/) |
| [Credits](tools/credits/) | Prepaid credit packs accepted by every tool above | `POST /v1/pack/1` $1, `POST /v1/pack/5` $5 (gives $5.50 of credits) | [api.youraitools.co/credits/](https://api.youraitools.co/credits/) |

**Safety tools** (PayGuard, TokenVerdict, SignCheck, CounterpartyCheck, SolVerdict, PkgGuard, InjectScan,
LeakGuard, DomainCheck): each result is a safety check, not a guarantee and not financial advice. A good
verdict means the checks found nothing wrong. It does not mean an asset, address or package is safe.

**Trader tools** (PerpRadar, TASignal): read-only market analytics and simulation. They never trade, hold
funds or touch keys. **Not financial advice. Past performance does not guarantee future results.**

## Payments and chains

Paid routes accept USDC on:

- **Base** (`eip155:8453`)
- **Polygon** (`eip155:137`)
- **Arbitrum One** (`eip155:42161`)
- **Solana** mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)

Every `402` response lists all four in `accepts` (x402 v2, `PAYMENT-REQUIRED` header). x402 v1 (`X-PAYMENT`)
is supported on Base. Payments settle to the public payout addresses
`0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F` (EVM) and `FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte` (Solana).

### Prepaid credits

To skip the on-chain payment on every call, buy a credit pack once from
[Credits](https://api.youraitools.co/credits/): $1, or $5 with a 10% bonus. The payment returns an API key
with a USDC balance. Send `Authorization: Bearer <key>` to any paid route, and that route's normal price is
debited from the balance. Credits are for prepaid API usage only and are not refundable.

## Using the tools from an MCP client

Each tool runs a remote MCP server (Streamable HTTP) at `https://api.youraitools.co/<tool>/mcp`. For example:

```json
{
  "mcpServers": {
    "webread": { "url": "https://api.youraitools.co/webread/mcp" },
    "leakguard": { "url": "https://api.youraitools.co/leakguard/mcp" }
  }
}
```

The free preview tools work without payment. Paid tools return the x402 payment requirements, which an
x402-capable client (such as `@x402/fetch` or `x402` for Python) can pay. Ready-to-use MCP configs for each
tool are in its folder (`server.json` / `glama.json` where present, and the README).

## Repository layout

```
tools/<name>/     one folder per tool: src/, test/, README.md, package.json, wrangler.toml, Dockerfile, logo
```

Each folder is an exact export of that tool's published commit on agentgate-source.pages.dev, with
deployment-specific values removed:

- Cloudflare KV namespace IDs in `wrangler.toml` are replaced with `"<your-kv-id>"`
- internal paths and notes are removed from comments
- internal test-payment scripts are left out

To run a tool yourself, follow its README. You'll need your own Cloudflare account, KV namespace and payout
address, plus secrets such as `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` set with `wrangler secret put` (never committed).

```bash
cd tools/webread
npm install
npm test
npx wrangler dev
```

## License

MIT. See [LICENSE](LICENSE).
