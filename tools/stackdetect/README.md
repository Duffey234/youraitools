# StackDetect: website technology / tech stack detection API for AI agents (x402 + MCP)

**What is this website built with?** StackDetect looks at one page load of a URL (response headers, cookie names, `<meta>`, script and stylesheet URLs, inline markers) plus the domain's public DNS (MX, NS, SPF and TXT verification records) and returns the **CMS and site builder, ecommerce platform, JS framework, web server, CDN and hosting, analytics and ad pixels, live chat, payments, consent tools**, and the **email provider, email-sending services, DNS host and verified SaaS**. Every technology comes with categories, a version when the site exposes one, a confidence score (0-100) and the evidence that matched.

Built for lead enrichment and sales agents, competitor research, integration planning ("is this a Shopify store?"), and agents that need to know how a site works before reading or automating it.

- **Hosted API:** https://api.youraitools.co/stackdetect (also at https://stackdetect.agentgate.workers.dev)
- **Price:** $0.003 USDC per lookup on Base over [x402](https://x402.org). No API key, no signup. Invalid URLs, unreachable sites and error pages with nothing detectable are never charged.
- **Free tier:** `/v1/preview` (technology names and categories, 10/min per IP) and a remote MCP server.
- In-house signature set (MIT), 266 technologies in 38 categories.
- Start here (all our tools, MCP configs, code samples): https://agentgate-source.pages.dev/start/

## MCP (Claude Desktop, Cursor, Windsurf, any MCP client)

Remote (free preview tier):
```json
{ "mcpServers": { "stackdetect": { "type": "http", "url": "https://api.youraitools.co/stackdetect/mcp" } } }
```

Local stdio (this package):
```json
{ "mcpServers": { "stackdetect": { "command": "npx", "args": ["-y", "@agentgate-builder/stackdetect"] } } }
```

Tool: `detect_stack(url)`. Free by default. For full results (versions, confidence, evidence, DNS-based providers), set `STACKDETECT_X402_PRIVATE_KEY` to a Base wallet key with a little USDC and add the optional peers:
```json
{ "mcpServers": { "stackdetect": { "command": "npx", "args": ["-y", "-p", "@agentgate-builder/stackdetect", "-p", "@x402/fetch", "-p", "@x402/evm", "-p", "viem", "stackdetect"], "env": { "STACKDETECT_X402_PRIVATE_KEY": "0x..." } } } }
```
The stdio server only pays the StackDetect pay-to address, on Base, at most $0.005 per call.

Docker: `docker build -t stackdetect-mcp . && docker run -i --rm stackdetect-mcp`

## HTTP

```bash
# free preview
curl -s "https://api.youraitools.co/stackdetect/v1/preview?url=https://laravel.com"
# paid (any x402 client): GET ?url= or POST {"url": "..."}
curl -i "https://api.youraitools.co/stackdetect/v1/detect?url=shopify.com"     # 402 + PAYMENT-REQUIRED
```

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }] });
const r = await (await pay('https://api.youraitools.co/stackdetect/v1/detect?url=acme.com')).json();
console.log(r.categories.cms, r.providers.email, r.providers.hosting);
```

Response (trimmed):
```json
{ "tier": "full", "final_url": "https://laravel.com/", "http_status": 200, "technology_count": 14,
  "technologies": [{ "name": "Cloudflare", "categories": ["cdn", "waf"], "version": null, "confidence": 100, "evidence": [{ "type": "header", "value": "server: cloudflare" }] },
                   { "name": "Laravel", "categories": ["web-framework"], "version": null, "confidence": 85, "evidence": [{ "type": "cookie", "value": "laravel_session" }] }],
  "categories": { "web-framework": ["Laravel"], "js-framework": ["Vue.js"] },
  "providers": { "email": ["Google Workspace"], "email_delivery": [], "dns": ["Cloudflare DNS"], "hosting": ["Cloudflare"], "verified_saas": [] } }
```

## Routes

| Route | Price | What |
|---|---|---|
| `GET\|POST /v1/detect?url=` | $0.003 | Full result |
| `GET\|POST /v1/preview?url=` | free, 10/min/IP | Names and categories only |
| `POST /mcp` | free | Remote MCP (Streamable HTTP, stateless) |
| `GET /v1/categories`, `/v1/stats`, `/health`, `/openapi.json`, `/.well-known/x402` | free | Discovery and public usage counters |

x402 v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`). `GET`, `POST` and `HEAD` on the paid route all answer the 402 challenge with the `PAYMENT-REQUIRED` header. The 402 is answered without any network call.

## How it works, and honest limits

- One GET of the URL you pass (redirects followed, 8 s timeout, 1.5 MB cap, private and internal addresses refused, our own hosts refused), plus three DNS-over-HTTPS queries (MX, NS, TXT) on the paid tier. Nothing is stored or logged. Cookie values are never kept, only cookie names.
- The hosted API runs on Cloudflare Workers, whose outbound fetches overwrite the origin's `Server` header and add `cf-ray`; those are ignored there, and Cloudflare is detected from the site's IP range instead. So the web-server software (nginx, Apache...) is only reported when another header exposes it.
- No JavaScript is executed: tools injected later by a tag manager can be missed. Sites can hide or fake signals. Domain-verification TXT records can be old.
- One request per call with a clear bot user agent (`StackDetectBot`). Not a crawler: please don't use it for bulk scraping.

## Development

```bash
npm install && npm test        # offline tests (fake site, fake DoH, fake facilitator)
npx wrangler deploy            # Cloudflare Worker (free plan; usage counters in a SQLite Durable Object, no KV)
node scripts/live-check.mjs    # no-spend live check of the 402s and the preview
```

MIT licensed. Part of the agentgate-builder trust kit: AgentGate, WebRead, InjectScan, DomainCheck, PayGuard, PkgGuard, StackDetect. Built by an AI builder agent with human oversight.
