// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './brand.js';
import { ROUTES, PREVIEW, NAME, SLUG, MCP_TOOLS, LANDING } from './tool.js';

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
  const qs = (o) => new URLSearchParams(o).toString();
  const curlFree = `curl -s "${origin}${PREVIEW.path}?${qs(PREVIEW.input)}"`;
  const curlPaid = ROUTES.map((r) => `curl -i "${origin}${r.path}?${qs(r.input)}"   # 402 with x402 terms (${info.paid.find((p) => p.tier === r.tier).price}); any x402 client pays it`).join('\n')
    + `\ncurl -s "${origin}${ROUTES[0].path}?${qs(ROUTES[0].input)}" -H "Authorization: Bearer $YOURAITOOLS_CREDITS_KEY"   # prepaid credits`;
  const mcp = `{ "mcpServers": { "${SLUG}": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "${SLUG}": { "command": "npx", "args": ["-y", "@agentgate-builder/${SLUG}"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
${LANDING.snippet(origin)}`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(LANDING.title)}</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="${esc(LANDING.title)}"><meta property="og:description" content="${esc(info.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#22d3ee; --ok:#4ade80; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 22px 72px; } h1 { font-size: 2.4rem; margin: 0 0 6px; letter-spacing: -0.02em; display:flex; gap:14px; align-items:center; } h1 span { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; } p { margin: 0 0 12px; } .lead { color: var(--muted); font-size: 1.1rem; max-width: 720px; }
  .price { display:inline-flex; gap:10px; align-items:center; margin:22px 8px 6px 0; padding:10px 16px; border:1px solid var(--line); border-radius:999px; background:var(--panel); } .price b { color: var(--ok); font-size: 1.1rem; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; } .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; } .card h3 { margin: 0 0 6px; font-size: 1rem; } .card p { color: var(--muted); font-size: .95rem; margin: 0; }
  a { color: #7c9cff; text-decoration: none; } a:hover { text-decoration: underline; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88rem; }
  .code { position: relative; background:#0f131c; border:1px solid var(--line); border-radius: 12px; margin: 10px 0 0; } .code pre { margin:0; padding: 16px 18px; overflow-x: auto; }
  .copy { position:absolute; top:8px; right:8px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; font: inherit; font-size:.8rem; }
  .warn { border:1px solid #854d0e; background:#1c1405; color:#fde68a; border-radius:12px; padding:12px 16px; }
  ul { padding-left: 20px; margin: 0; } li { margin: 4px 0; } .muted { color: var(--muted); } footer { margin-top: 48px; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 18px; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>${LANDING.h1}</div></h1>
  <p class="lead">${LANDING.lead}</p>
  <div>${info.paid.map((x) => `<span class="price"><b>${esc(x.price)}</b><span>${esc(x.tier)}: ${esc(x.path)}</span></span>`).join('')}</div>
  <p class="muted">Pay in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402, or with a prepaid <a href="https://api.youraitools.co/credits/">YourAITools credits</a> key. Bad input, unknown symbols and upstream failures are never charged. Fail-closed: a data source that fails is listed in <code>sources_failed</code>, never estimated.</p>
  <p class="warn">${esc(info.disclaimer)}</p>

  <h2>Free preview</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tools: ${MCP_TOOLS.map((t) => `<code>${esc(t.name)}</code>`).join(', ')}. The free servers return the preview. Set <code>${SLUG.toUpperCase()}_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays the full tier per call over x402 (your wallet, Base USDC), or call the paid routes directly.</p>

  <h2>Paid routes</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(info.payTo)}</code>.</p>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)} · ${esc(x.price)}</h3><p>${esc(x.returns)} Params: ${x.params.map(esc).join(', ')}.</p></div>`).join('')}
    <div class="card"><h3>GET ${esc(PREVIEW.path)} · free</h3><p>${esc(PREVIEW.returns)}. 10/min per IP.</p></div>
    <div class="card"><h3><a href="/openapi.json">/openapi.json</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info, x402 manifest, public usage counters.</p></div>
  </div>

  <h2>Data and limits</h2>
  <ul>${info.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="muted" style="margin-top:10px">Sources: ${Object.entries(info.sources).map(([k, v]) => `${esc(k)} (<code>${esc(v)}</code>)`).join(', ')}. ${esc(info.policy.custody)}.</p>

  <h2>Links</h2>
  <ul><li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li></ul>
  <footer>${esc(NAME)} by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
</script>
</body>
</html>`;
}
