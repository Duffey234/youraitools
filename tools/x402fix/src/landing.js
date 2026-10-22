// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './brand.js';
import { trustKitHtml } from './trustkit.js';
import { EXAMPLE_URL } from './examples.js';

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
  const p = Object.fromEntries(info.paid.map((x) => [x.tier, x.price]));
  const enc = encodeURIComponent(EXAMPLE_URL);
  const curlFree = `curl -s "${origin}/v1/preview?url=${enc}"`;
  const curlPaid = `curl -i "${origin}/v1/check?url=${enc}"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/site" -H 'content-type: application/json' -d '{"url":"https://api.example.com"}'`;
  const credits = `curl -s -H "Authorization: Bearer $YATC_KEY" "${origin}/v1/check?url=${enc}"   # prepaid credits key, no on-chain payment per call`;
  const mcp = `{ "mcpServers": { "x402fix": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "x402fix": { "command": "npx", "args": ["-y", "@agentgate-builder/x402fix"] } } }`;
  const ci = `# CI gate after deploy: fail the build when your paid route is broken
grade=$(curl -s "${origin}/v1/preview?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fdata" | jq -r .grade)
[ "$grade" = "A" ] || [ "$grade" = "B" ] || { echo "x402 route grade $grade"; exit 1; }`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402fix: x402 endpoint checker and Bazaar fixer for sellers (v1, v2, multichain)</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="x402fix: is my x402 endpoint correct?"><meta property="og:description" content="${esc(info.description)}"><meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#38bdf8; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 22px 72px; } h1 { font-size: 2.3rem; margin: 0 0 6px; letter-spacing: -0.02em; display:flex; gap:14px; align-items:center; } h1 span { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; } p { margin: 0 0 12px; } .lead { color: var(--muted); font-size: 1.1rem; max-width: 720px; }
  .price { display:inline-flex; gap:10px; align-items:center; margin:22px 8px 6px 0; padding:10px 16px; border:1px solid var(--line); border-radius:999px; background:var(--panel); } .price b { color: var(--ok); font-size: 1.1rem; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; } .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; } .card h3 { margin: 0 0 6px; font-size: 1rem; } .card p { color: var(--muted); font-size: .95rem; margin: 0; }
  a { color: #7c9cff; text-decoration: none; } a:hover { text-decoration: underline; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88rem; }
  .code { position: relative; background:#0f131c; border:1px solid var(--line); border-radius: 12px; margin: 10px 0 0; } .code pre { margin:0; padding: 16px 18px; overflow-x: auto; }
  .copy { position:absolute; top:8px; right:8px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; font: inherit; font-size:.8rem; }
  button.run { padding: 8px 16px; font-size: .95rem; background: var(--accent); color: #111; border: 0; font-weight: 600; border-radius: 8px; cursor: pointer; }
  input, select { background:#0f131c; color:var(--text); border:1px solid var(--line); border-radius:12px; padding:12px 14px; font:inherit; }
  #out { white-space: pre-wrap; } ul { padding-left: 20px; margin: 0; } li { margin: 4px 0; } .muted { color: var(--muted); } footer { margin-top: 48px; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 18px; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>x402<span>fix</span></div></h1>
  <p class="lead">Your x402 route returns a 402, but do agents actually pay it, and will the Bazaar list it? Paste the URL. x402fix probes it the way buyers and crawlers do (GET, HEAD, empty POST, CORS preflight; it never pays) and returns a <b>grade with a numbered fix list</b>. The check tier adds the CDP facilitator&#39;s own validate verdict and writes the corrected Bazaar block and multichain accepts for you.</p>
  <div><span class="price"><b>${esc(p.lite)}</b><span>lite: every check + fix list</span></span><span class="price"><b>${esc(p.check)}</b><span>check: + CDP verdict, payee, generated fixes</span></span><span class="price"><b>${esc(p.site)}</b><span>site: up to 8 routes of an origin</span></span></div>
  <p class="muted">Pay per call in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402, or with a prepaid <a href="https://api.youraitools.co/credits/">credits key</a>. Invalid input is never charged.</p>

  <h2>Free check</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap"><input id="q" spellcheck="false" value="${esc(EXAMPLE_URL)}" style="flex:1 1 420px"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Check</button> <span class="muted">Free preview: grade, score, status and counts (10/min).</span></p>
  <pre id="out" class="muted"></pre>

  <h2>What is checked</h2>
  <div class="grid">
    <div class="card"><h3>Transport</h3><p>402 on GET, HEAD (directory health checks), empty POST and POST {} (crawlers), CORS preflight and exposed PAYMENT-REQUIRED for browser and web-wallet buyers, redirects, auth walls, cacheable 402s, latency.</p></div>
    <div class="card"><h3>v2 and v1 terms</h3><p>PAYMENT-REQUIRED header decodes, resource.url absolute and matching, description, and the v1 JSON body for legacy clients; v1 and v2 must agree on price and payTo.</p></div>
    <div class="card"><h3>Every accepts entry</h3><p>CAIP-2 network, canonical USDC asset, the EIP-712 domain clients sign against (a wrong name rejects every payment), Solana feePayer, atomic-unit amounts and the $0.001 minimum, payTo format, timeout.</p></div>
    <div class="card"><h3>Multichain</h3><p>Same price on every network, no duplicates, which networks the CDP facilitator settles, and what you miss by accepting only one chain.</p></div>
    <div class="card"><h3>Bazaar declaration</h3><p>info.input.type and method, output.type, draft 2020-12 schema, no external $ref, and info validated against its own schema, the silent reason many routes never get listed.</p></div>
    <div class="card"><h3>Check tier extras</h3><p>CDP validate verdict and index status, /openapi.json and /.well-known/x402 consistency, payTo is a wallet, Solana USDC token account exists, payTo not flagged by CounterpartyCheck; plus a generated, self-validated fix.</p></div>
  </div>

  <h2>Command line</h2>
  ${block('free', curlFree)}
  ${block('ci', ci)}

  <h2>MCP (for coding agents building x402 servers)</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>check_x402_endpoint</code>. The free servers return the preview. Set <code>X402FIX_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays the check tier per call over x402 (${esc(p.check)}, your wallet), or call the paid routes directly.</p>

  <h2>Paid: fix lists and generated fixes</h2>
  ${block('paid', curlPaid)}
  ${block('credits', credits)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>, Base). Payments go to <code>${esc(info.payTo)}</code>.</p>

  <h2>Honest limits</h2>
  <ul>${info.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="muted" style="margin-top:10px">${esc(info.disclaimer)}</p>

  ${trustKitHtml('x402fix', esc)}

  <h2>Routes</h2>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)}</h3><p>Paid, ${esc(x.price)}. ${esc(x.returns)}</p></div>`).join('')}
    <div class="card"><h3>GET /v1/preview</h3><p>Free, 10/min per IP. Grade, score, status, counts.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (check_x402_endpoint).</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info; public usage counters.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>x402fix by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Checking...';
  const q = new URLSearchParams({ url: document.getElementById('q').value.trim() });
  try { const r = await fetch(location.pathname.replace(/\\/$/, '') + '/v1/preview?' + q, { headers: { accept: 'application/json' } }); const j = await r.json(); delete j.full; delete j.disclaimer; out.textContent = JSON.stringify(j, null, 2); } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
