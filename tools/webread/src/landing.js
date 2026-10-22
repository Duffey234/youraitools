import { trustKitHtml } from './trustkit.js';
// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.

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
  // JSON counts at its own q if listed, otherwise at the wildcard's q (it is acceptable through */*).
  const jsonEff = jsonListed ? json : wildcard;
  return html > 0 && html > jsonEff;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));


export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="WebRead"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M14 18h36v28H14z" fill="none" stroke="#7c9cff" stroke-width="3" stroke-linejoin="round"/><path d="M14 25h36" stroke="#7c9cff" stroke-width="3"/><path d="M21 34l4 6 4-8 4 8 4-6" fill="none" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 33v8m-3-3l3 3 3-3" fill="none" stroke="#e6e9f0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function landingHtml({ origin, info }) {
  const paid = `${origin}${info.paid.path}`;
  const curlFree = `curl "${origin}/v1/read/preview?url=https://example.com/"`;
  const curlPaid = `curl -i "${paid}?url=https://example.com/"   # 402 with x402 terms`;
  const mcp = `{ "mcpServers": { "webread": { "type": "http", "url": "${origin}/mcp" } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
const res = await pay('${paid}?url=' + encodeURIComponent('https://example.com/'));
const { title, markdown } = await res.json();`;
  const bazaar = `https://facilitator.payai.network/discovery/listing-status?resource=${encodeURIComponent(paid)}`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebRead: URL to clean Markdown for AI agents, $0.002 per page over x402</title>
<meta name="description" content="${esc(info.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#7c9cff; --ok:#4ade80; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 56px 22px 72px; } h1 { font-size: 2.4rem; margin: 0 0 6px; letter-spacing: -0.02em; display:flex; gap:14px; align-items:center; } h1 span { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; } p { margin: 0 0 12px; } .lead { color: var(--muted); font-size: 1.1rem; max-width: 680px; }
  .price { display:inline-flex; gap:10px; align-items:center; margin:22px 0 6px; padding:10px 16px; border:1px solid var(--line); border-radius:999px; background:var(--panel); } .price b { color: var(--ok); font-size: 1.15rem; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; } .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; } .card h3 { margin: 0 0 6px; font-size: 1rem; } .card p { color: var(--muted); font-size: .95rem; margin: 0; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88rem; }
  .code { position: relative; background:#0f131c; border:1px solid var(--line); border-radius: 12px; margin: 10px 0 0; } .code pre { margin:0; padding: 16px 18px; overflow-x: auto; }
  .copy { position:absolute; top:8px; right:8px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; font: inherit; font-size:.8rem; }
  ul { padding-left: 20px; margin: 0; } li { margin: 4px 0; } .muted { color: var(--muted); } footer { margin-top: 48px; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 18px; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Web<span>Read</span></div></h1>
  <p class="lead">Give your agent any web page as clean Markdown: main content only, no navigation, scripts or ads, with absolute links and title and description metadata. Agents pay per page over <a href="https://docs.x402.org">x402</a>. No account or API key needed.</p>
  <div class="price"><b>$0.002 USDC</b><span>per successful read, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Failed reads are free.</span></div>

  <h2>Try it free, no wallet</h2>
  ${block('free', curlFree)}
  <p class="muted" style="margin-top:10px">The preview returns the first 2,000 characters, 10 calls per minute per IP.</p>

  <h2>Give it to your agent: remote MCP server</h2>
  ${block('mcp', mcp)}
  <p class="muted" style="margin-top:10px">One tool, <code>read_url</code> (free tier). Works in Claude, Cursor and any MCP client.</p>

  <h2>Paid: full pages, up to 200,000 characters</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>) clients. Payments go directly to <code>${esc(info.paid.payTo)}</code> through the <a href="${esc(info.paid.facilitator)}">PayAI facilitator</a>.</p>

  ${trustKitHtml('WebRead', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>GET ${esc(info.paid.path)}?url=</h3><p>Paid, $0.002. Optional <code>maxChars</code>. Bad URLs (400), robots.txt blocks (403), unsupported content (415) and upstream failures (5xx) are never charged.</p></div>
    <div class="card"><h3><a href="/v1/read/preview?url=https://example.com/">GET /v1/read/preview</a></h3><p>Free, 10/min per IP. First 2,000 characters.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server, tool <code>read_url</code>.</p></div>
    <div class="card"><h3><a href="/v1/stats">GET /v1/stats</a></h3><p>Free. Public usage counters for the last 30 days.</p></div>
    <div class="card"><h3><a href="/health">GET /health</a></h3><p>Free. Liveness check.</p></div>
    <div class="card"><h3>GET / (JSON)</h3><p>Free. Machine-readable service info with <code>Accept: application/json</code>.</p></div>
  </div>

  <h2>Good citizen</h2>
  <ul>
    <li>Respects robots.txt (user-agent token <code>WebReadBot</code>, checked on every redirect hop).</li>
    <li>Fetches public http(s) pages only: private and reserved IPs, internal hostnames, non-default ports and other schemes are refused.</li>
    <li>2 MB download cap and a 10-second time limit per page.</li>
  </ul>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.guide)}">Integration guide</a> · <a href="${esc(info.allTools)}">All three tools</a></li>
    <li><a href="${esc(bazaar)}">x402 Bazaar listing</a> (PayAI)</li>
    <li>Sister service: <a href="https://agentgate.agentgate.workers.dev">AgentGate</a> (is this AI agent verified?)</li>
  </ul>
  <footer>WebRead by agentgate-builder. Tips welcome: ${esc(info.paid.payTo)} (Base).</footer>
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
