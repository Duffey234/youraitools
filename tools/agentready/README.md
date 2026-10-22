# AgentReady

**Is this website ready for AI agents?** An audit of what ChatGPT, Claude, Perplexity and autonomous agents actually get from a site, paid per call over x402.

- Live: https://api.youraitools.co/agentready (also https://agentready.agentgate.workers.dev)
- Paid (USDC on Base or Solana; Polygon and Arbitrum One also accepted; x402 v2 and v1, or a prepaid [YourAITools credits](https://api.youraitools.co/credits/) key via `Authorization: Bearer`):
  - `GET|POST /v1/lite?url=` **$0.005**: score 0-100, grade A-F, verdict, category scores, top 5 prioritized fixes, AI bots blocked by robots.txt
  - `GET|POST /v1/audit?url=` **$0.03**: all 23 checks with evidence, the robots.txt matrix for 17 AI bots, every fix with priority and points to gain, and ready-to-paste snippets: a generated **llms.txt draft**, **robots.txt lines**, **JSON-LD**, **meta / Open Graph tags**, a markdown link tag, an **mcp.json** and an **A2A agent card** starter
- Free: `GET /v1/preview?url=` (score, grade, category scores; 10/min per IP), shareable report `/r/<domain>`, score badge `/badge/<domain>.svg`, remote MCP `POST /mcp` (`audit_website`), `/openapi.json`, `/.well-known/x402`, `/v1/stats`, `/health?sources=1`.

## What is checked (100 points)
| Category | Checks |
|---|---|
| Agent access (30) | HTTP 200 for an agent; WAF / CAPTCHA / JS challenge detection; robots.txt (RFC 9309) for 17 AI bots: user-triggered agents (ChatGPT-User, Claude-User, Perplexity-User, MistralAI-User), AI search (OAI-SearchBot, Claude-SearchBot, PerplexityBot, DuckAssistBot, Amazonbot), training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent, cohere-ai: reported, no points, your choice); noindex / noai / X-Robots-Tag / Content-Signal opt-outs |
| Readable content (25) | Text in the raw HTML (SPA-shell and "enable JavaScript" detection); markdown via `Accept: text/markdown` or `<link rel="alternate" type="text/markdown">`; title and meta description; semantic HTML (h1, main, nav, h2); accessibility basics browser agents use (alt text, form labels, button names, lang) |
| Discovery (25) | `/llms.txt` validated against llmstxt.org; `/llms-full.txt`; XML sitemap (and whether robots.txt lists it); schema.org JSON-LD; canonical and Open Graph |
| Agent interfaces (12) | OpenAPI (`/openapi.json`, `/.well-known/openapi.json`); MCP discovery (`/.well-known/mcp.json`, `/.well-known/mcp/server-card.json`) plus a live MCP `initialize`; A2A `/.well-known/agent-card.json`, `agent.json`, `agents.json`, `ai-plugin.json`; x402 (`/.well-known/x402` or OpenAPI payment info) |
| Speed and HTTPS (8) | HTTPS; http:// to https:// redirect and HSTS; time to first response |

Grades: A >= 90, B >= 75, C >= 60, D >= 40, F below. Verdict: agent_ready >= 80, partially_ready >= 55.

## Fail-closed
A source that errors, times out, answers 429 or 5xx is never read as a pass: its checks are `unknown`, score 0, are listed in `sources_failed`, and confidence drops. If the page itself can't be fetched, paid routes answer **503 `checks_incomplete`** and are not charged. Only HTTP 200 results are settled; bad, private or internal URLs (400), hosts that don't resolve or resolve to private IPs (422) are free.

## Safe fetching
http(s) only, default ports only, no credentials in URLs, public hostnames only; IP literals and every DNS answer (DNS over HTTPS, two resolvers) must be public; redirects followed by hand (max 5, each hop re-checked); per-request timeouts (5 s, page 7 s); bodies capped (512 KB, page 1 MB); about 20 requests per audit with an honest user agent: `AgentReadyBot/0.1 (+https://api.youraitools.co/agentready; ...)`. No user-agent spoofing.

## MCP
```json
{ "mcpServers": { "agentready": { "type": "http", "url": "https://api.youraitools.co/agentready/mcp" } } }
{ "mcpServers": { "agentready": { "command": "npx", "args": ["-y", "@agentgate-builder/agentready"] } } }
```
The stdio server (`npx @agentgate-builder/agentready`, Docker: `docker build -t agentready-mcp .`) returns the free preview; set `AGENTREADY_X402_PRIVATE_KEY` (a Base wallet key with a little USDC) and it pays the full `/v1/audit` per call ($0.03, capped, only to our payee).

## Badge
```md
[![AgentReady score](https://api.youraitools.co/agentready/badge/example.com.svg)](https://api.youraitools.co/agentready/r/example.com)
```

## Limits
Raw HTML only (what non-browser agents see). Bot-challenge detection uses our own honest agent user agent; vendors whitelisted by IP may be treated differently. Response time is one measurement from one Cloudflare edge. Informational; no guarantee that a given AI product will crawl, cite or use the site.

## Develop
`npm test` (node --test; offline mocks) · `npx wrangler deploy` · `node tools/gen-og.mjs`

MIT · by agentgate-builder · hello@youraitools.co
