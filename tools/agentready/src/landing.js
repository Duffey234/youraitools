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
  const curlFree = `curl -s "${origin}/v1/preview?url=${EXAMPLE_URL}"`;
  const curlPaid = `curl -i "${origin}/v1/audit?url=${EXAMPLE_URL}"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/lite" -H 'content-type: application/json' -d '{"url":"${EXAMPLE_URL}"}'
curl -s "${origin}/v1/audit?url=${EXAMPLE_URL}" -H "Authorization: Bearer $YOURAITOOLS_CREDITS_KEY"   # prepaid credits`;
  const mcp = `{ "mcpServers": { "agentready": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "agentready": { "command": "npx", "args": ["-y", "@agentgate-builder/agentready"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// SEO / dev agent: audit a client site and open a PR with the fixes
const a = await (await pay('${origin}/v1/audit?url=' + encodeURIComponent(site))).json();
console.log(a.score, a.grade, a.fixes.map((f) => f.title));
fs.writeFileSync('public/llms.txt', a.snippets.llms_txt ?? '');`;
  const badge = `[![AgentReady score](${origin}/badge/example.com.svg)](${origin}/r/example.com)`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentReady: is your website ready for AI agents? llms.txt, robots.txt AI bots, MCP, OpenAPI audit over x402</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="AgentReady: is this website ready for AI agents?"><meta property="og:description" content="${esc(info.description)}"><meta property="og:image" content="${esc(origin)}/og/generic.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#a78bfa; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 22px 72px; } h1 { font-size: 2.4rem; margin: 0 0 6px; letter-spacing: -0.02em; display:flex; gap:14px; align-items:center; } h1 span { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; } p { margin: 0 0 12px; } .lead { color: var(--muted); font-size: 1.1rem; max-width: 720px; }
  .price { display:inline-flex; gap:10px; align-items:center; margin:22px 8px 6px 0; padding:10px 16px; border:1px solid var(--line); border-radius:999px; background:var(--panel); } .price b { color: var(--ok); font-size: 1.1rem; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; } .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; } .card h3 { margin: 0 0 6px; font-size: 1rem; } .card p { color: var(--muted); font-size: .95rem; margin: 0; }
  a { color: #7c9cff; text-decoration: none; } a:hover { text-decoration: underline; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88rem; }
  .code { position: relative; background:#0f131c; border:1px solid var(--line); border-radius: 12px; margin: 10px 0 0; } .code pre { margin:0; padding: 16px 18px; overflow-x: auto; }
  .copy { position:absolute; top:8px; right:8px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; font: inherit; font-size:.8rem; }
  button.run { padding: 8px 16px; font-size: .95rem; background: var(--accent); color: #111; border: 0; font-weight: 600; border-radius: 8px; cursor: pointer; }
  #out { white-space: pre-wrap; } ul { padding-left: 20px; margin: 0; } li { margin: 4px 0; } .muted { color: var(--muted); } footer { margin-top: 48px; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 18px; word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Agent<span>Ready</span></div></h1>
  <p class="lead">Is this website ready for AI agents? One call checks what ChatGPT, Claude, Perplexity and autonomous agents actually get from a site: robots.txt rules for 17 AI bots, bot challenges, content in the raw HTML (no JavaScript), markdown, <code>llms.txt</code>, sitemap, schema.org JSON-LD, Open Graph, OpenAPI, a live MCP server, A2A agent card and x402 payments. You get a <b>0-100 score, a grade</b>, prioritized fixes and <b>ready-to-paste snippets</b>: a generated llms.txt draft, robots.txt lines, JSON-LD and meta tags.</p>
  <div><span class="price"><b>${esc(p.lite)}</b><span>lite: score + top 5 fixes</span></span><span class="price"><b>${esc(p.audit)}</b><span>audit: 23 checks, evidence, all fixes + snippets</span></span></div>
  <p class="muted">Pay in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402, or with a prepaid <a href="https://api.youraitools.co/credits/">YourAITools credits</a> key. Invalid or private URLs and unreachable sites are never charged. Fail-closed: anything we could not fetch is reported as unknown and scores 0, never as a pass.</p>

  <h2>Free check</h2>
  <p><input id="q" spellcheck="false" value="youraitools.co" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Check site</button> <span class="muted">Opens the shareable report <code>/r/&lt;domain&gt;</code>: score, grade, category scores (10/min).</span></p>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>audit_website</code>. The free servers return the preview (score, grade, category scores). Set <code>AGENTREADY_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays the full audit per call over x402 (${esc(p.audit)} USDC on Base, your wallet), or call the paid routes directly.</p>

  <h2>Paid: full audits</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(info.payTo)}</code>. Humans can pay on any report page with a browser wallet.</p>

  <h2>Score badge</h2>
  ${block('badge', badge)}

  <h2>What is checked (23 checks, 100 points)</h2>
  <div class="grid">
    <div class="card"><h3>Agent access (30)</h3><p>HTTP 200 for agents, no WAF / CAPTCHA / JS challenge, robots.txt rules for 17 AI bots split into user-triggered agents (ChatGPT-User, Claude-User, Perplexity-User), AI search (OAI-SearchBot, Claude-SearchBot, PerplexityBot) and training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot: reported, your choice), noindex / noai / Content-Signal opt-outs.</p></div>
    <div class="card"><h3>Readable content (25)</h3><p>Text in the raw HTML without JavaScript (SPA shell detection), markdown via <code>Accept: text/markdown</code> or a markdown alternate, title and description, semantic HTML, accessibility basics browser agents rely on (alt text, labels, button names, lang).</p></div>
    <div class="card"><h3>Discovery (25)</h3><p><code>/llms.txt</code> validated against llmstxt.org, <code>/llms-full.txt</code>, XML sitemap (and whether robots.txt lists it), schema.org JSON-LD types, canonical and Open Graph.</p></div>
    <div class="card"><h3>Agent interfaces (12)</h3><p>OpenAPI at /openapi.json or /.well-known/openapi.json, MCP discovery (<code>/.well-known/mcp.json</code>, server card) plus a <b>live MCP initialize</b>, A2A <code>agent-card.json</code>, agent.json, agents.json, ai-plugin.json, x402 (<code>/.well-known/x402</code>).</p></div>
    <div class="card"><h3>Speed and HTTPS (8)</h3><p>HTTPS, http:// to https:// redirect, HSTS, time to first response from a Cloudflare edge.</p></div>
    <div class="card"><h3>Fixes you can paste</h3><p>Every failing check comes with a priority and points to gain. The audit tier adds a generated llms.txt draft from your nav and sitemap, robots.txt lines for the blocked agent bots, JSON-LD, meta / OG tags, a markdown link tag, an mcp.json and an A2A agent card starter.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>${info.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="muted" style="margin-top:10px">${esc(info.disclaimer)} Fetch policy: ${esc(info.policy.fetching)}. User agent: <code>${esc(info.userAgent)}</code>.</p>

  ${trustKitHtml('AgentReady', esc)}

  <h2>Routes</h2>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)}</h3><p>Paid, ${esc(x.price)}. ${esc(x.returns)}</p></div>`).join('')}
    <div class="card"><h3>GET /v1/preview · /r/&lt;domain&gt; · /badge/&lt;domain&gt;.svg</h3><p>Free, 10/min per IP. Score, grade, category scores; shareable report with OG tags; SVG badge.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (audit_website).</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info; public usage counters.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>AgentReady by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', () => {
  let v = document.getElementById('q').value.trim().replace(/^https?:\/\//i, '').split(/[\/?#]/)[0].toLowerCase();
  if (!/^([a-z0-9-]+\.)+[a-z][a-z0-9-]+$/.test(v)) { alert('Enter a domain, e.g. example.com'); return; }
  location.href = location.pathname.replace(/\/$/, '') + '/r/' + v;
});
</script>
</body>
</html>`;
}
