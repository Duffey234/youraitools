// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './discovery.js';
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
  const [pd] = info.paid;
  const curlFree = `curl -s "${origin}/v1/preview?url=${EXAMPLE_URL}"`;
  const curlPaid = `curl -i "${origin}/v1/detect?url=https://shopify.com"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/detect" -H 'content-type: application/json' -d '{"url":"vercel.com"}'`;
  const mcp = `{ "mcpServers": { "stackdetect": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "stackdetect": { "command": "npx", "args": ["-y", "@agentgate-builder/stackdetect"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Lead enrichment step: what does this prospect run on?
const r = await (await pay('${origin}/v1/detect?url=' + encodeURIComponent('acme.com'))).json();
console.log(r.categories.cms, r.categories.ecommerce, r.providers.email, r.providers.hosting);`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StackDetect: website technology / tech stack detection API, ${esc(pd.price)} per lookup over x402</title>
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Stack<span>Detect</span></div></h1>
  <p class="lead">What is this website built with? One call returns the CMS, ecommerce platform, JS framework, web server, CDN and hosting, analytics and ad pixels, chat, payments and consent tools, plus the email provider, email-sending services, DNS host and verified SaaS seen in public DNS. Every hit has a version when exposed, a confidence score and the evidence.</p>
  <div class="price"><b>${esc(pd.price)}</b><span>per lookup, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Invalid URLs and unreachable sites are free.</span></div>
  <p class="muted">${esc(String(info.signatures))} signatures in ${esc(String(info.categories))} categories. Built for lead enrichment, competitor research, sales agents and integration planning.</p>

  <h2>Free preview</h2>
  <p><input id="q" spellcheck="false" value="${esc(EXAMPLE_URL)}" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Detect</button> <span class="muted">Free preview: technology names and categories, 10 per minute.</span></p>
  <div class="code"><pre id="out">Result appears here.</pre></div>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>detect_stack</code>. The free servers return the preview (names and categories; remote: 10 calls/min). For versions, confidence, evidence and DNS-based providers, set <code>STACKDETECT_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays this API per call over x402 (${esc(pd.price)}, your wallet), or call the paid route below directly.</p>

  <h2>Paid: full results</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(pd.payTo)}</code>.</p>

  <h2>What you get</h2>
  <div class="grid">
    <div class="card"><h3>The web stack</h3><p>CMS and site builders, ecommerce, JS frameworks, static site generators, web servers, languages and backend frameworks.</p></div>
    <div class="card"><h3>Hosting and CDN</h3><p>Cloudflare, Vercel, Netlify, AWS, Fastly, Akamai and more, from response headers and nameservers.</p></div>
    <div class="card"><h3>Marketing and analytics</h3><p>Analytics, tag managers, ad pixels, marketing automation, A/B testing, chat widgets, payments, consent banners.</p></div>
    <div class="card"><h3>Email and DNS</h3><p>Email provider (Google Workspace, Microsoft 365...), sending services (SendGrid, SES, Mailgun...) and DNS host, from MX, NS and SPF.</p></div>
    <div class="card"><h3>Verified SaaS</h3><p>Tools the company has verified its domain with (Atlassian, Stripe, DocuSign, Slack, OpenAI...), from TXT records.</p></div>
    <div class="card"><h3>Evidence, not guesses</h3><p>Each hit shows what matched (header, cookie name, meta tag, script URL, DNS record) and a confidence score.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>
    <li>One page load without running JavaScript: tools injected later by a tag manager can be missed.</li>
    <li>Sites can hide or fake signals; confidence is a heuristic. Domain-verification records can be old.</li>
    <li>One GET per call, a normal bot user agent, nothing stored. Not for crawling or bulk scraping.</li>
  </ul>

  ${trustKitHtml('StackDetect', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>GET|POST /v1/detect</h3><p>Paid, ${esc(pd.price)}. Full result.</p></div>
    <div class="card"><h3>GET|POST /v1/preview</h3><p>Free, 10/min per IP.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server.</p></div>
    <div class="card"><h3><a href="/v1/categories">GET /v1/categories</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. Categories; public usage counters.</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a></h3><p>Free. OpenAPI 3.1 with x402 payment info.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>StackDetect by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Detecting...';
  try {
    const r = await fetch('/v1/preview?url=' + encodeURIComponent(document.getElementById('q').value));
    const j = await r.json();
    if (!r.ok) { out.textContent = j.message || j.error; return; }
    delete j.full; out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
