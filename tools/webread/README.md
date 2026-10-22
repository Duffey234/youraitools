# WebRead: URL to Markdown for AI agents (MCP server + x402 API)

> **Start here:** copy-paste MCP configs for Claude, Cursor and Windsurf, x402 client code, AgentKit and LangChain wrappers: https://agentgate-source.pages.dev/start/  
> API: https://api.youraitools.co/webread · fallback (same Worker): https://webread.agentgate.workers.dev · npm: `x402-url-to-markdown`

<img src="logo.svg" width="56" align="right" alt="WebRead logo">

**Give your agent any web page as clean Markdown, for $0.002 per page. No account or API key needed.**

WebRead fetches a public web page and returns only its main content as Markdown: no navigation, scripts or ads. Links come back absolute, with title, description, language and canonical metadata. Agents pay per successful read over [x402](https://docs.x402.org) in USDC on Base, and failed reads are free. There is a free preview, and a remote MCP server for Claude, Cursor and other MCP clients.

- **Live:** https://api.youraitools.co/webread
- **Paid route:** `GET https://api.youraitools.co/webread/v1/read?url=<page>` costs **$0.002 USDC on Base** (x402 v2 and v1). It is listed on the x402 Bazaar (PayAI).
- **Free preview:** `GET /v1/read/preview?url=<page>` returns the first 2,000 characters, 10 calls/min per IP.
- **Remote MCP:** `https://api.youraitools.co/webread/mcp` with the tool `read_url`. It is listed in the official MCP Registry as `io.github.agentgate-builder/x402-url-to-markdown`.
- **Local MCP (stdio):** `npx -y -p x402-url-to-markdown webread-mcp` or `docker build -t webread-mcp . && docker run -i --rm webread-mcp`, tool `read_url`. Reads pages locally with the same SSRF-safe, robots.txt-respecting reader (free; no data goes to WebRead).
- **npm:** `x402-url-to-markdown`, which ships the dependency-free HTML-to-Markdown converter, the SSRF-safe fetcher and a robots.txt parser.

## 30-second quickstart

```bash
# 1. Free, no wallet
curl "https://api.youraitools.co/webread/v1/read/preview?url=https://example.com/"

# 2. Paid: an unpaid call answers 402 with the x402 terms (2000 = 0.002 USDC, Base, payTo)
curl -i "https://api.youraitools.co/webread/v1/read?url=https://example.com/"
```

```json
{ "mcpServers": { "webread": { "type": "http", "url": "https://api.youraitools.co/webread/mcp" } } }
```

```js
// 3. Pay from code with the official x402 client: npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }] });
const { title, markdown } = await (await pay('https://api.youraitools.co/webread/v1/read?url=' + encodeURIComponent('https://example.com/'))).json();
```

```js
// Or use just the converter (no network): npm i x402-url-to-markdown
import { htmlToMarkdown } from 'x402-url-to-markdown';
const { markdown, title } = htmlToMarkdown(html, { baseUrl: 'https://example.com/' });
```

## Response

```json
{ "url": "https://example.com/", "finalUrl": "https://example.com/", "status": 200, "contentType": "text/html; charset=utf-8",
  "title": "Example Domain", "description": null, "lang": "en", "canonical": null,
  "markdown": "This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.",
  "chars": 156, "wordCount": 25, "links": 0, "truncated": false, "sourceBytes": 577, "redirects": 0, "fetchMs": 17,
  "robots": "allowed", "fetchedAt": "2026-10-21T21:32:28.690Z" }
```

(Live output for `https://example.com/` on 2026-10-21; the page has no heading or links today, so the Markdown is one paragraph. The free preview adds `"tier": "free"` and a `full` link.)

Query parameters: `url` (required) and `maxChars` (100–200000, default 200000).

Machine-readable discovery: [`/openapi.json`](https://api.youraitools.co/webread/openapi.json) (OpenAPI 3.1 with `x-payment-info`) and [`/.well-known/x402`](https://api.youraitools.co/webread/.well-known/x402) (x402scan manifest).

| Situation | HTTP | Charged? |
|---|---|---|
| Success | 200 | yes, $0.002 |
| Invalid URL, blocked scheme/host/IP/port | 400 | no |
| Disallowed by robots.txt, or robots.txt unreachable (5xx/timeout) | 403 | no |
| Not HTML or text | 415 | no |
| Page returned 4xx/5xx, DNS failure, fetch error | 502 / 422 | no |
| Timeout (10 s) | 504 | no |

## Safety and good citizenship

- **robots.txt:** checked on every hop, including redirects, following RFC 9309 (groups, longest match, `*` and `$`). The product token is `WebReadBot` and the User-Agent links to this repo. robots.txt files are cached for 10 minutes. A 4xx robots.txt means allowed; a 5xx or timeout means disallowed.
- **SSRF protection:** only `http:`/`https:` on ports 80/443, and no credentials in URLs. It blocks localhost, internal TLDs and private or reserved IPv4/IPv6 literals (including IPv4-mapped forms and numeric IPv4 encodings). Hostnames are resolved over DNS-over-HTTPS and refused if they point at a private address. At most 5 redirects are followed, each one re-validated.
- **Limits:** 2 MB download cap, 1 MB of HTML converted, 10-second total time limit, Markdown capped at 200k characters.

## Routes

| Route | Price |
|---|---|
| `GET /v1/read?url=&maxChars=` | $0.002 USDC (x402, Base) |
| `GET /v1/read/preview?url=` | free, 10/min per IP |
| `POST /mcp` | free (remote MCP, Streamable HTTP, stateless JSON) |
| `GET /v1/stats` | free, public usage counters |
| `GET /health`, `GET /` | free (JSON for agents, HTML landing page for browsers) |

## Develop

```bash
npm install
npm test            # node:test, offline: fake web + fake facilitators, real x402 v2 and v1 clients
npx wrangler dev    # Workers runtime locally
```

It deploys to Cloudflare Workers (free plan) with `wrangler deploy`. Sister project: [AgentGate](https://api.youraitools.co/agentgate), which checks whether an AI agent is verified.

Built by an AI builder agent (`agentgate-builder`) with human oversight. MIT licensed. Tips: `0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F` (Base).

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
