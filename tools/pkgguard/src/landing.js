// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './discovery.js';
import { trustKitHtml } from './trustkit.js';
import { EXAMPLE_MANIFEST } from './examples.js';

/** True only when the Accept header ranks text/html strictly above application/json (and above 0). */
export function prefersHtml(accept) {
  if (!accept) return false;
  let html = 0, json = 0, wildcard = 0, jsonListed = false;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';').map((s) => s.trim());
    const qp = params.find((p) => p.startsWith('q='));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (!Number.isFinite(q)) continue;
    if (type === 'text/html' || type === 'application/xhtml+xml') html = Math.max(html, q);
    else if (type === 'application/json') { json = Math.max(json, q); jsonListed = true; }
    else if (type === '*/*' || type === 'application/*') wildcard = Math.max(wildcard, q);
  }
  const jsonEff = jsonListed ? json : wildcard;
  return html > 0 && html > jsonEff;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function landingHtml({ origin, info }) {
  const [ps, pp] = info.paid;
  const sample = JSON.stringify(JSON.parse(EXAMPLE_MANIFEST), null, 2);
  const curlFree = `curl -s "${origin}/v1/preview?ecosystem=npm&name=lodash&version=4.17.15"
curl -s -X POST "${origin}/v1/preview" --data-binary @package.json`;
  const curlPaid = `curl -i -X POST "${origin}/v1/scan" --data-binary @package-lock.json   # 402 with x402 terms; any x402 client pays it
curl -i "${origin}/v1/package?ecosystem=PyPI&name=requests&version=2.19.0"`;
  const mcp = `{ "mcpServers": { "pkgguard": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "pkgguard": { "command": "npx", "args": ["-y", "@agentgate-builder/pkgguard"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Gate step in a coding agent, before "npm install" runs:
const r = await (await pay('${origin}/v1/scan', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ manifest: readFileSync('package-lock.json', 'utf8') }) })).json();
if (r.malicious_count || r.highest_severity === 'CRITICAL') stopAndAsk(r.packages); // ids, severity, fixed_in`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PkgGuard: dependency vulnerability and malicious package scan API, $0.003 per scan over x402</title>
<meta name="description" content="${esc(info.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#38bdf8; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 22px 72px; } h1 { font-size: 2.4rem; margin: 0 0 6px; letter-spacing: -0.02em; display:flex; gap:14px; align-items:center; } h1 span { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; } p { margin: 0 0 12px; } .lead { color: var(--muted); font-size: 1.1rem; max-width: 700px; }
  .price { display:inline-flex; gap:10px; align-items:center; margin:22px 0 6px; padding:10px 16px; border:1px solid var(--line); border-radius:999px; background:var(--panel); } .price b { color: var(--ok); font-size: 1.15rem; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; } .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; } .card h3 { margin: 0 0 6px; font-size: 1rem; } .card p { color: var(--muted); font-size: .95rem; margin: 0; }
  a { color: #7c9cff; text-decoration: none; } a:hover { text-decoration: underline; } code, pre, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88rem; }
  .code { position: relative; background:#0f131c; border:1px solid var(--line); border-radius: 12px; margin: 10px 0 0; } .code pre { margin:0; padding: 16px 18px; overflow-x: auto; }
  .copy, button.run { position:absolute; top:8px; right:8px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; font: inherit; font-size:.8rem; }
  button.run { position: static; padding: 8px 16px; font-size: .95rem; background: var(--accent); color: #111; border: 0; font-weight: 600; }
  textarea { width: 100%; min-height: 110px; background:#0f131c; color: var(--text); border:1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  #out { white-space: pre-wrap; } .v-safe { color: var(--ok); } .v-suspicious { color: var(--warn); } .v-malicious { color: var(--bad); }
  ul { padding-left: 20px; margin: 0; } li { margin: 4px 0; } .muted { color: var(--muted); } footer { margin-top: 48px; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 18px; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Pkg<span>Guard</span></div></h1>
  <p class="lead">Is this dependency safe to install? Send a manifest or lockfile and get known vulnerabilities (CVE / GHSA ids, severity, CVSS, fixed-in versions) and confirmed-malicious packages per dependency. Built for coding agents and CI, data from OSV.dev.</p>
  <div class="price"><b>${esc(ps.price)}</b><span>per scan (up to 500 packages)</span><b>${esc(pp.price)}</b><span>per package, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Invalid input is free.</span></div>
  <p class="muted">Ecosystems: ${esc(info.ecosystems.join(', '))}. Files: ${esc(info.manifests.join(', '))}.</p>

  <h2>Free preview</h2>
  <p><textarea id="q" spellcheck="false">${esc(sample)}</textarea></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Scan</button> <span class="muted">Free preview: verdict and counts for up to 25 packages, 10 per minute. Paste a package.json, requirements.txt, go.mod or lockfile.</span></p>
  <div class="code"><pre id="out">Result appears here.</pre></div>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tools <code>scan_dependencies</code> and <code>check_package</code>. The free servers return the preview verdict and counts (remote: 10 calls/min). For package names, advisory ids, severity and fixed-in versions, set <code>PKGGUARD_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays this API per call over x402 ($0.003 per scan, your wallet), or call the paid routes below directly.</p>

  <h2>Paid: full results</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px"><code>POST /v1/scan</code> takes <code>{"manifest": "..."}</code>, <code>{"packages": [{"ecosystem","name","version"}]}</code> or the raw file as the body. Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(ps.payTo)}</code>.</p>

  <h2>What you get</h2>
  <div class="grid">
    <div class="card"><h3>Vulnerabilities</h3><p>Every OSV advisory for the exact versions: GHSA, CVE, PYSEC, GO, RUSTSEC and more, with summary and aliases.</p></div>
    <div class="card"><h3>Severity and fix</h3><p>Severity rating, CVSS v3 base score and vector, and the versions that fix each advisory.</p></div>
    <div class="card"><h3>Malicious packages</h3><p>Confirmed-malicious packages (OpenSSF Malicious Packages, GitHub malware advisories) flagged first.</p></div>
    <div class="card"><h3>8 file types</h3><p>package.json, package-lock.json, requirements.txt, Pipfile.lock, poetry.lock, go.mod, Cargo.lock, composer.lock, or a plain list.</p></div>
    <div class="card"><h3>Fast and private</h3><p>Only names and versions go to OSV.dev; files are parsed in the Worker and never stored or logged.</p></div>
    <div class="card"><h3>Never charged for errors</h3><p>Bad input gets a free 400; an OSV outage gets a free 503. Only HTTP 200 results settle.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>
    <li>Lists published advisories only. A clean result does not prove a package is safe, and new malware can appear before it is reported.</li>
    <li>For version ranges in package.json or requirements.txt the lowest allowed version is scanned, which can over-report. Scan the lockfile for exact results.</li>
    <li>Not a security audit, reachability analysis or license check.</li>
  </ul>

  ${trustKitHtml('PkgGuard', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>POST /v1/scan</h3><p>Paid, ${esc(ps.price)}. Up to 500 packages.</p></div>
    <div class="card"><h3>GET|POST /v1/package</h3><p>Paid, ${esc(pp.price)}. One package version.</p></div>
    <div class="card"><h3>/v1/preview</h3><p>Free, 10/min per IP.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server.</p></div>
    <div class="card"><h3><a href="/v1/ecosystems">GET /v1/ecosystems</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. Supported inputs; public usage counters.</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a></h3><p>Free. OpenAPI 3.1 with x402 payment info.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
    <li>Data: <a href="https://osv.dev">OSV.dev</a> (${esc(info.data.license.split(';')[0])})</li>
  </ul>
  <footer>PkgGuard by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Scanning...';
  try {
    const r = await fetch('/v1/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: document.getElementById('q').value }) });
    const j = await r.json();
    if (!r.ok) { out.textContent = j.message || j.error; return; }
    delete j.full; out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
