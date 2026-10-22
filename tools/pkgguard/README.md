# PkgGuard: dependency vulnerability and malicious package scanner for AI agents (x402 + MCP)

**Is this dependency safe to install?** PkgGuard checks a `package.json`, `package-lock.json`, `requirements.txt`, `Pipfile.lock`, `poetry.lock`, `go.mod`, `Cargo.lock` or `composer.lock` (or a plain package list) for **known vulnerabilities** (CVE / GHSA / PYSEC / GO / RUSTSEC ids, severity, CVSS score, fixed-in versions) and **confirmed-malicious packages** (OpenSSF Malicious Packages, GitHub malware advisories). Built for coding agents, MCP clients and CI. Data from [OSV.dev](https://osv.dev).

- **Hosted API:** https://api.youraitools.co/pkgguard (also at https://pkgguard.agentgate.workers.dev)
- **Price:** $0.003 USDC per scan (up to 500 packages), $0.001 per single package, on Base over [x402](https://x402.org). No API key, no signup. Invalid input and upstream outages are never charged.
- **Free tier:** `/v1/preview` (verdict + counts, up to 25 packages, 10/min per IP) and a remote MCP server.
- Start here (all our tools, MCP configs, code samples): https://agentgate-source.pages.dev/start/

## MCP (Claude Desktop, Cursor, Windsurf, any MCP client)

Remote (free preview tier):
```json
{ "mcpServers": { "pkgguard": { "type": "http", "url": "https://api.youraitools.co/pkgguard/mcp" } } }
```

Local stdio (this package):
```json
{ "mcpServers": { "pkgguard": { "command": "npx", "args": ["-y", "@agentgate-builder/pkgguard"] } } }
```

Tools:
- `scan_dependencies`: `{ "path": "./package-lock.json" }`, `{ "manifest": "<file contents>" }` or `{ "packages": [{ "ecosystem": "npm", "name": "lodash", "version": "4.17.15" }] }`
- `check_package`: `{ "ecosystem": "PyPI", "name": "requests", "version": "2.19.0" }`

Files are parsed locally; only `{ecosystem, name, version}` triples leave your machine. By default the server returns the free preview (verdict and counts). For the full result (affected packages, advisory ids, severity, CVSS, fixed-in versions, up to 500 packages), set `PKGGUARD_X402_PRIVATE_KEY` to a Base wallet key holding a little USDC and add the optional peers:

```json
{ "mcpServers": { "pkgguard": { "command": "npx",
  "args": ["-y", "-p", "@agentgate-builder/pkgguard", "-p", "@x402/fetch", "-p", "@x402/evm", "-p", "viem", "pkgguard"],
  "env": { "PKGGUARD_X402_PRIVATE_KEY": "0x..." } } } }
```
Spend guard: Base USDC only, at most $0.005 per payment, only to PkgGuard's pay-to address.

## HTTP

```bash
# free preview
curl -s "https://api.youraitools.co/pkgguard/v1/preview?ecosystem=npm&name=lodash&version=4.17.15"
curl -s -X POST "https://api.youraitools.co/pkgguard/v1/preview" --data-binary @package.json

# paid (answers 402 with x402 terms; any x402 client pays it)
curl -i -X POST "https://api.youraitools.co/pkgguard/v1/scan" --data-binary @package-lock.json
curl -i "https://api.youraitools.co/pkgguard/v1/package?ecosystem=PyPI&name=requests&version=2.19.0"
```

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
const r = await (await pay('https://api.youraitools.co/pkgguard/v1/scan', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ manifest: readFileSync('package-lock.json', 'utf8') }),
})).json();
if (r.malicious_count || r.highest_severity === 'CRITICAL') console.log(r.packages);
```

Response (trimmed):
```json
{ "verdict": "malicious", "highest_severity": "CRITICAL", "package_count": 3, "vulnerable_count": 2, "malicious_count": 1,
  "packages": [
    { "ecosystem": "npm", "name": "flatmap-stream", "version": "0.1.1", "malicious": true, "highest_severity": "CRITICAL",
      "vulns": [{ "id": "MAL-2025-20690", "malicious": true, "summary": "Malicious code in flatmap-stream (npm)" }] },
    { "ecosystem": "npm", "name": "lodash", "version": "4.17.15", "highest_severity": "HIGH",
      "vulns": [{ "id": "GHSA-35jh-r3h4-6jhm", "aliases": ["CVE-2021-23337"], "severity": "HIGH", "cvss_score": 7.2, "fixed_in": ["4.17.21"] }] } ] }
```

## Library

```js
import { parseManifest, toPackages, preview } from '@agentgate-builder/pkgguard';
const { type, packages } = parseManifest(readFileSync('go.mod', 'utf8')); // offline parser, 8 file types
console.log(await preview(packages.slice(0, 25)));                          // free hosted preview
```

## Routes

| Route | Price | What |
|---|---|---|
| `POST /v1/scan` | $0.003 | `{manifest}`, `{packages}` or the raw file as body; up to 500 packages |
| `GET/POST /v1/package` | $0.001 | `ecosystem`, `name`, `version` |
| `GET/POST /v1/preview` | free | verdict + counts, up to 25 packages, 10/min per IP |
| `POST /mcp` | free | remote MCP, `scan_dependencies` + `check_package` |
| `/openapi.json`, `/.well-known/x402`, `/v1/ecosystems`, `/v1/stats`, `/health` | free | discovery and counters |

x402 v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`), USDC on Base (eip155:8453), Coinbase CDP facilitator. Listed on the x402 Bazaar.

## Honest limits

- Lists published advisories only. A clean result does not prove a package is safe, and new malware can appear before it is reported.
- For ranges in `package.json` / `requirements.txt` the lowest allowed version is scanned, which can over-report. Scan the lockfile for exact results.
- Not a security audit, reachability analysis or license check.

## Part of the agent trust kit

AgentGate (agent identity), WebRead (web page to Markdown), InjectScan (prompt injection), DomainCheck (domain and email trust), PayGuard (OFAC wallet screening), PkgGuard (dependency safety). All at https://api.youraitools.co, all pay-per-call over x402 with free tiers.

Contact: hello@youraitools.co. MIT licensed. Vulnerability data: OSV.dev (CC-BY 4.0).
