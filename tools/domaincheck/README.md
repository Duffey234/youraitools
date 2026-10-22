# DomainCheck: disposable email check and domain trust score for AI agents (MCP server + x402 API)

> **Start here:** copy-paste MCP configs for Claude, Cursor and Windsurf, x402 client code, AgentKit and LangChain wrappers: https://agentgate-source.pages.dev/start/  
> API: https://api.youraitools.co/domaincheck · fallback (same Worker): https://domaincheck.agentgate.workers.dev · npm: `@agentgate-builder/domaincheck`

**Domain and email trust checks for AI agents, paid per call over [x402](https://docs.x402.org).**
Is this domain real, how old is it, who registered it, is its email locked down, and is this address disposable or undeliverable? One call returns plain flags, a 0-100 score and a verdict.

- Live API: https://api.youraitools.co/domaincheck (fallback: https://domaincheck.agentgate.workers.dev)
- Price: **$0.002 USDC** per domain report, **$0.001 USDC** per email check, on Base (eip155:8453). Invalid input and lookup timeouts are never charged.
- Free tier: `/v1/domain/preview`, `/v1/email/preview` and a remote MCP server at `/mcp` (10 calls/min per IP).
- Local MCP (stdio, full checks from your machine): `npx -y @agentgate-builder/domaincheck`
- Source: https://agentgate-source.pages.dev/x402-domain-check/ (MIT) · npm: [@agentgate-builder/domaincheck](https://www.npmjs.com/package/@agentgate-builder/domaincheck) · all our tools: https://youraitools.co/built-by-us

## Why

Agents increasingly act on links, senders, counterparties and signups they have never seen. The cheapest strong signals are public: brand-new domains, parked domains, disposable mail providers, domains with no mail server, and domains whose email anyone can spoof. DomainCheck gathers them from public DNS (DNS over HTTPS) and RDAP, the registries' official successor to WHOIS, and scores them with documented rules.

## Quick start

```bash
# Free
curl -s "https://api.youraitools.co/domaincheck/v1/domain/preview?domain=example.com"
curl -s "https://api.youraitools.co/domaincheck/v1/email/preview?email=test@mailinator.com"

# Paid: answers 402 with x402 terms; pay with any x402 client
curl -i "https://api.youraitools.co/domaincheck/v1/domain?domain=example.com"
curl -i "https://api.youraitools.co/domaincheck/v1/email?email=jane@example.com"
```

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
const d = await (await pay('https://api.youraitools.co/domaincheck/v1/domain?domain=' + encodeURIComponent(host))).json();
if (d.verdict !== 'low_risk') console.warn(host, d.score, d.flags.map((f) => f.id));
```

### MCP

Remote (free preview tier):

```json
{ "mcpServers": { "domaincheck": { "type": "http", "url": "https://api.youraitools.co/domaincheck/mcp" } } }
```

Local stdio (full checks, free, runs on your machine):

```json
{ "mcpServers": { "domaincheck": { "command": "npx", "args": ["-y", "@agentgate-builder/domaincheck"] } } }
```

Tools: `check_domain {domain}` and `check_email {email}`. Docker: `docker build -t domaincheck-mcp . && docker run -i --rm domaincheck-mcp`.

### Library

```js
import { checkDomain, checkEmail } from '@agentgate-builder/domaincheck';
const report = await checkDomain('example.com');           // { verdict, score, flags, dns, email, registration, ... }
const email = await checkEmail('jane.doe+news@gmail.com'); // { verdict: 'valid' | 'risky' | 'undeliverable' | 'invalid', ... }
```

## Routes

| Route | Price | What |
|---|---|---|
| `GET\|POST /v1/domain` `?domain=` / `{"domain"}` | $0.002 | Full domain report |
| `GET\|POST /v1/email` `?email=` / `{"email"}` | $0.001 | Full email check |
| `GET\|POST /v1/domain/preview` | free | DNS, MX, SPF, DMARC (no RDAP age, DKIM, MTA-STS or score) |
| `GET\|POST /v1/email/preview` | free | Syntax, disposable, role, free provider (no network) |
| `POST /mcp` | free | Remote MCP: `check_domain`, `check_email` (preview tier) |
| `GET /v1/flags` | free | Every flag, severity and penalty |
| `GET /v1/stats` | free | Public usage counters, last 30 days |
| `GET /openapi.json`, `/.well-known/x402` | free | Discovery documents |

x402 v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`) clients both work. Payments are verified and settled by the PayAI facilitator, and only HTTP 200 answers are settled. The 402 challenge makes no network calls.

## What a domain report contains

- **Existence:** NXDOMAIN detection, A / AAAA / NS / CNAME / CAA.
- **Mail:** MX hosts with priority, null MX (RFC 7505), mail provider (Google Workspace, Microsoft 365, Proton, Zoho, Fastmail, Mimecast, Proofpoint ...).
- **Mail authentication:** SPF (policy, `+all`, duplicates, includes), DMARC (policy, subdomain policy, pct, reporting, inherited from the registrable domain), DKIM on 10 common selectors, MTA-STS, TLS-RPT, BIMI and an A-F mail grade.
- **DNSSEC:** validated by the resolver (AD bit), plus the registry's delegationSigned.
- **Registration (RDAP):** registrar and IANA id, created / expires / updated, age in days, days to expiry, registry status (e.g. client hold, pending delete), nameservers.
- **Risk:** parked / for-sale nameservers, disposable mail domain, newly registered (7 / 30 / 90 days, 1 year), expiring within 15 days, registry hold.
- **Score:** 100 minus the penalties of the raised flags. Verdict `low_risk` (≥70), `medium_risk` (40-69), `high_risk` (<40) or `nonexistent`.

## What an email check contains

RFC 5321/5322 syntax (64/254 limits, IDN domains), normalized and canonical form (Gmail dots and plus-tags), plus-tag, role account, free webmail, disposable provider (8,883 domains, CC0 list, subdomains included), MX / null MX, SPF and DMARC of the domain, domain age, then verdict `valid`, `risky`, `undeliverable` or `invalid` with a 0-100 score.

## Example (live, example.com)

```json
{
  "domain": "example.com", "exists": true, "verdict": "low_risk", "score": 90,
  "flags": [{ "id": "null_mx", "severity": "medium", "penalty": 10, "description": "Null MX (RFC 7505): the domain explicitly accepts no email." }],
  "email": { "accepts_mail": false, "spf": { "policy": "fail" }, "dmarc": { "policy": "reject" }, "grade": "A" },
  "registration": { "registrar": "RESERVED-Internet Assigned Numbers Authority", "created": "1995-08-14T04:00:00Z", "age_days": 11391 }
}
```

## Honest limits

- **No SMTP mailbox probing.** "valid" means well-formed, the domain accepts mail and nothing looks risky. It does not mean the mailbox exists. RCPT probing is unreliable, is often blocked, and looks like abuse.
- **DKIM selectors can't be enumerated**, so only common selectors are checked.
- **Some TLDs have no public RDAP** (e.g. .de, .io at the time of writing), and some registries rate-limit. Age checks are then skipped and flagged `rdap_unavailable`.
- A young domain is a signal, not proof. Use the score as one input next to your own policy.
- Inputs are looked up in memory and not stored. DNS goes to Cloudflare 1.1.1.1 DoH, with Google Public DNS as the fallback. RDAP servers come from the IANA bootstrap file. Our requests identify as `DomainCheck/0.1`, and registration results are cached for 6 hours per instance to keep registry load low.

## Agent trust kit

Six small x402 tools for agents that act on outside input. Same pay-per-call USDC on Base, free tiers, remote MCP:

| Tool | Price | What |
|---|---|---|
| [AgentGate](https://api.youraitools.co/agentgate) | $0.005 | Is this AI agent who it says it is? (Concordium Agent Registry) |
| [WebRead](https://api.youraitools.co/webread) | $0.002 | Any public web page as clean Markdown |
| [InjectScan](https://api.youraitools.co/injectscan) | $0.003 | Prompt-injection scan for text, pages and MCP tools |
| **DomainCheck** | $0.002 / $0.001 | Domain and email trust checks |
| [PayGuard](https://api.youraitools.co/payguard) | $0.001 / $0.01 batch | OFAC SDN sanctions screen for crypto addresses |
| [PkgGuard](https://api.youraitools.co/pkgguard) | $0.001 / $0.003 scan | Dependency vulnerability + malicious-package scan (OSV.dev) |

## Develop

```bash
npm install
npm test            # 23 tests, no network (fake DoH + RDAP)
npm start           # local server on :8789
npx wrangler deploy # Cloudflare Workers (free plan: ~20-23 subrequests per full report, under the 50 limit)
```

MIT License. Tips welcome: 0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F (Base).
