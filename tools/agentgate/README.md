# AgentGate: AI agent identity verification (Concordium Agent Registry, MCP + x402)

> **Start here:** copy-paste MCP configs for Claude, Cursor and Windsurf, x402 client code, AgentKit and LangChain wrappers: https://agentgate-source.pages.dev/start/  
> API: https://api.youraitools.co/agentgate · fallback (same Worker): https://agentgate.agentgate.workers.dev · npm: `concordium-agentgate`

**Is this AI agent who it says it is? One call tells you.**

AgentGate checks an AI agent against the [Concordium Agent Registry](https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html) (CIS-8004, ERC-8004 compatible) and answers: is it **registered**, **Active** (not revoked), and **Verified by Concordium** (its published Agent Card matches the hash committed on-chain)? Use it before your agent trusts, hires or pays another agent, or to keep anonymous scripts out of your [x402](https://docs.x402.org) paid API.

[![live API](https://img.shields.io/badge/API-live-brightgreen)](https://api.youraitools.co/agentgate) [![x402](https://img.shields.io/badge/x402-%240.005%20USDC%20on%20Base-blue)](https://api.youraitools.co/agentgate/v1/check-agent) [![MCP](https://img.shields.io/badge/MCP-remote%20%2B%20stdio-purple)](#mcp) [![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

## 30-second quickstart

**1. Try it now (free, no wallet, no signup):**

```bash
curl "https://api.youraitools.co/agentgate/v1/check-agent/preview?id=Mf22soLh1NuZYFgBK8iSs"
# {"id":"Mf22soLh1NuZYFgBK8iSs","network":"mainnet","found":true,"active":true,"verified":true,"cardHashMatches":true,...,"tier":"free"}
```

**2. Give it to your agent as a tool (MCP).** Remote, nothing to install:

```json
{ "mcpServers": { "agentgate": { "type": "http", "url": "https://api.youraitools.co/agentgate/mcp" } } }
```

Or run it locally over stdio: `npx -y -p concordium-agentgate agentgate-mcp` (or Docker: `docker build -t agentgate-mcp . && docker run -i --rm agentgate-mcp`). Either way you get one tool, `check_agent({ id, network })`.

**3. Pay per call for the full record** (owner account, agent wallet, Agent Card URI, token id): `GET https://api.youraitools.co/agentgate/v1/check-agent?id=<badge>` costs **$0.005 USDC on Base** over x402 v2. Any x402 client works; see [examples/x402-paid-call.mjs](examples/x402-paid-call.mjs). It is listed in the x402 Bazaar (PayAI).

**4. Use it in code:**

```js
import { createAgentGateClient } from 'concordium-agentgate/client'; // or from this repo: ./src/client.js
const agentgate = createAgentGateClient();            // free preview; pass { paidFetch } for the paid route
const r = await agentgate.verify('Mf22soLh1NuZYFgBK8iSs');
if (!r.verified) throw new Error('untrusted agent');
```

Framework tools ready to paste: [LangChain/LangGraph](examples/langchain/check-agent-tool.mjs), [Vercel AI SDK](examples/vercel-ai-sdk/check-agent-tool.mjs), [OpenAI Agents SDK](examples/openai-agents/check-agent-tool.mjs), [ElizaOS](examples/elizaos/check-agent-action.ts).

| Hosted endpoint | Price | Returns |
|---|---|---|
| `GET /v1/check-agent/preview?id=&network=` | free, 20/min per IP | verdict: `verified`, `found`, `active`, `cardHashMatches`, issues |
| `POST /mcp` | free, 20/min per IP | remote MCP server, tool `check_agent` (verdict) |
| `GET /v1/check-agent?id=&network=` | $0.005 USDC (x402, Base) | full record incl. owner, agent wallet, Agent Card URI |
| `GET /v1/stats` | free | public usage counters |

What's in the repo:

- **Library** (`src/registry.js`): `checkAgent(badgeOrAccount, { network })`, with pluggable providers.
- **Express-style middleware** (`src/middleware.js`): `agentGate()`. Mount it before x402 `paymentMiddleware`.
- **MCP server** (`mcp/server.js`): a `check_agent` tool for Claude, Cursor and other MCP clients.
- **Static checker page** (`docs/`): a single HTML file you can open locally or host anywhere. live at **https://agentgate-source.pages.dev/agentgate/demo/** (guide: https://youraitools.co/guides/x402-agent-verification)
- **Paid x402 API** (`service/`): `check_agent` at **$0.005 USDC per call on Base mainnet**, using the official `@x402/*` packages and the PayAI facilitator, and listed in the x402 Bazaar (PayAI). **Live:** `https://api.youraitools.co/agentgate/v1/check-agent?id=<badge or account>`. See [service/README.md](service/README.md).
- **Tests and a runnable demo.**

> Status: v0.1, an MVP built for the [Concordium Trusted Agents Hackathon](https://www.encodeclub.com/programmes/concordium-trusted-agents-hackathon) (Encode Club). Independent project, not affiliated with Concordium.

## Why

x402 lets any agent pay any API with no signup, which also means any anonymous script can call it. Concordium's Agent Registry ties each agent to an identity-verified owner account without putting personal data on-chain. AgentGate is the missing piece in between: one line of middleware that lets only agents with an accountable owner reach your paid routes. Unverified agents are rejected **before** they are asked to pay.

## Quickstart

```bash
# just the package: npm install concordium-agentgate   (MCP server: npx -y -p concordium-agentgate agentgate-mcp)
# full source (tests, demo, service): https://agentgate-source.pages.dev/agentgate/
curl -LO https://agentgate-source.pages.dev/agentgate/agentgate.bundle && git clone agentgate.bundle agentgate && cd agentgate
npm install
npm test              # unit + integration tests (offline)
npm run demo          # offline demo: MockProvider + mock x402 paywall
npm run demo:live     # real Concordium mainnet registry lookups (payment step still mocked)
npm run check -- Mf22soLh1NuZYFgBK8iSs                         # CLI, mainnet
npm run check -- JyP9TtQC3HCNrTYR3sc2T --network testnet       # CLI, testnet
```

### Gate a route

```js
import express from 'express';
import { agentGate } from 'concordium-agentgate';
// import { paymentMiddleware } from '@x402/express'; // official x402 seller middleware

const app = express();
app.get('/paid/quote',
  agentGate({ network: 'testnet' }),   // 401 no badge · 403 unregistered/revoked/tampered · 503 registry down
  paymentMiddleware(/* your x402 config */),
  (req, res) => res.json({ quote: '…', agent: req.agentGate.tokenAddress }));
```

Agents identify themselves with the `X-Agent-Badge` header. Its value is their badge, i.e. the CIS-2 token address such as `Mf22soLh1NuZYFgBK8iSs`. CAIP-19 form and a Concordium owner account are also accepted.

`agentGate(options)`:

| option | default | meaning |
|---|---|---|
| `network` | `'mainnet'` | `mainnet` / `testnet` / `devnet` |
| `provider` | cached `ConcordiumPublicProvider` (60 s TTL) | any object with `check(id, {network})` |
| `header` | `X-Agent-Badge` | request header carrying the badge |
| `requireCardMatch` | `true` | require Agent Card hash == on-chain `metadata_hash` |
| `bindPayer` | `false` | if an x402 `PAYMENT-SIGNATURE` is attached, require its payer to be the agent's on-chain `agentWallet` or owner |
| `failOpen` | `false` | let traffic through if the registry is unreachable (default: fail closed, 503) |
| `policy` | — | `async (req, result) => boolean` for extra rules |

On success, the verified record is available as `req.agentGate`, and an `X-AgentGate: verified; …` header is set.

### MCP server <a id="mcp"></a>

Remote (hosted, free tier): `https://api.youraitools.co/agentgate/mcp` (Streamable HTTP). Local (stdio, queries Concordium directly, full record):


```json
{ "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "-p", "concordium-agentgate", "agentgate-mcp"] } } }
```

Or run it locally with `node mcp/server.js` (stdio). The server exposes one tool:

- **`check_agent({ id, network })`** returns `VERIFIED` / `NOT VERIFIED` plus the structured record.

Set `AGENTGATE_MOCK=1` to use offline fixtures.

### Static checker

Live at https://agentgate-source.pages.dev/agentgate/demo/ (or open `docs/index.html` locally). You can deep-link a check, e.g. `?id=Mf22soLh1NuZYFgBK8iSs&network=mainnet`. The page queries Concordium's public endpoints directly from the browser (CORS is open), using the same `registry.js` as the library.

## What is real and what is mocked

| Part | Status |
|---|---|
| Mainnet lookups | **Real.** Concordium's public, documented badge-check REST endpoint: `GET https://agent-registry-mcp.concordium.com/v1/badge-check/{badge\|account}` ([docs](https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/concordium-badge.html)). It returns on-chain status plus the Agent Card hash check. |
| Testnet / devnet lookups | **Real.** Concordium's hosted Agent Registry MCP server (`https://agent-registry-mcp.concordium.com/mcp`, JSON-RPC tools `agent_by_token_address`, `agents_by_owner`, `verify_agent_card`; [docs](https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/mcp-service.html)). Testnet registry contract `<12802,0>`, mainnet `<10082,0>`. |
| `MockProvider` | **Mock.** In-memory fixtures (`MockVerifiedAgent1111`, `MockRevokedAgent22222`, `MockTamperedCard33333`). Every result has `mock: true` and `source: 'mock'`. Used for tests and the offline demo only. |
| `examples/mock-paywall.js` | **Mock.** Speaks the x402 v2 header shapes (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) but does not verify signatures or settle anything. No funds move. In production use the official x402 middleware and a real facilitator. |
| Badge ownership proof | **Not yet.** In v0.1 the badge header is a claim. `bindPayer` ties it to the x402 payer when the payer is the agent's Concordium wallet or owner. Cross-chain payer binding via CIS-8 external keys and signed badge challenges are on the roadmap. |

Tests use recorded real responses from the badge-check API (`test/fixtures/`). `npm run test:live` also hits the real endpoints.

## Roadmap (toward the Dec 9, 2026 hackathon submission)

- [ ] Signed badge challenge: the agent proves control of its CIS-8 bound key or agent wallet, so a header can't be replayed.
- [ ] Cross-chain payer binding: resolve EVM/Solana x402 payers through CIS-8 (`owner_of_key`, `agent_by_external_reference`).
- [ ] End-to-end testnet demo: register an AgentGate demo agent with a mock testnet identity, pay through a real x402 facilitator on Concordium testnet, record a video.
- [x] Free preview tier, remote MCP server, framework examples.
- [ ] npm package `concordium-agentgate` (package.json ready).

## Development

```bash
npm test          # node:test, offline
npm run test:live # adds live calls to Concordium public endpoints
npm run sync-docs # copy src/registry.js -> docs/registry.js (a test enforces they match)
```

Built by an AI builder agent (`agentgate-builder`) with human oversight.

## Support

If AgentGate is useful to you, tips are welcome at **`0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F`** (EVM: Ethereum, Base, and other EVM chains).

## Agent trust kit

Six small x402 tools for agents that act on outside input. Same pay-per-call USDC on Base, free tiers, remote MCP:

| Tool | What it does | Price |
|---|---|---|
| [AgentGate](https://api.youraitools.co/agentgate) | Is this AI agent who it says it is? Concordium Agent Registry (CIS-8004) check | $0.005 |
| [WebRead](https://api.youraitools.co/webread) | Any public web page as clean Markdown, robots.txt-aware, SSRF-safe | $0.002 |
| [InjectScan](https://api.youraitools.co/injectscan) | Scans text, pages and MCP tool definitions for prompt injection ([repo](https://agentgate-source.pages.dev/x402-prompt-injection-scan/)) | $0.003 |
| [DomainCheck](https://api.youraitools.co/domaincheck) | Is this domain or email real and trustworthy? DNS, SPF/DMARC, RDAP registration age, disposable and parked detection, 0-100 score ([source](https://agentgate-source.pages.dev/x402-domain-check/)) | $0.002 domain / $0.001 email |
| [PayGuard](https://api.youraitools.co/payguard) | Is this crypto address on the US Treasury OFAC SDN list? Exact match with entity, programs and list date, plus chain and checksum ([source](https://agentgate-source.pages.dev/x402-payguard/)) | $0.001 address / $0.01 batch of 50 |
| [PkgGuard](https://api.youraitools.co/pkgguard) | Is this dependency safe to install? Known vulnerabilities (CVE/GHSA, severity, fixed-in versions) and confirmed-malicious packages for a package, manifest or lockfile, from OSV.dev ([source](https://agentgate-source.pages.dev/x402-pkgguard/)) | $0.001 package / $0.003 lockfile scan |

Typical flow: verify the counterpart agent with AgentGate, check its domain or contact email with DomainCheck, read a page with WebRead, check it with InjectScan before following anything in it, screen any wallet with PayGuard before paying it, and check any package with PkgGuard before installing it.

## License

MIT
