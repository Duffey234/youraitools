// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './discovery.js';
import { trustKitHtml } from './trustkit.js';

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
  const [pd, pe] = info.paid;
  const curlFree = `curl -s "${origin}/v1/domain/preview?domain=example.com"
curl -s "${origin}/v1/email/preview?email=test@mailinator.com"`;
  const curlPaid = `curl -i "${origin}/v1/domain?domain=example.com"     # 402 with x402 terms; pay with any x402 client
curl -i "${origin}/v1/email?email=jane@example.com"`;
  const mcp = `{ "mcpServers": { "domaincheck": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "domaincheck": { "command": "npx", "args": ["-y", "@agentgate-builder/domaincheck"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Before trusting a link, a sender or a new signup:
const d = await (await pay('${origin}/v1/domain?domain=' + encodeURIComponent(host))).json();
if (d.verdict !== 'low_risk') console.warn(host, d.score, d.flags.map((f) => f.id));
const e = await (await pay('${origin}/v1/email?email=' + encodeURIComponent(addr))).json();
if (e.verdict !== 'valid') reject(addr, e.flags);`;
  const bazaar = `https://facilitator.payai.network/discovery/listing-status?resource=${encodeURIComponent(origin + '/v1/domain')}`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DomainCheck: domain and email trust checks for AI agents, from $0.001 per call over x402</title>
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Domain<span>Check</span></div></h1>
  <p class="lead">Before your agent clicks a link, trusts a sender, pays a counterparty or accepts a signup: is the domain real, how old is it, who registered it, is its email locked down, and is this address disposable or undeliverable? One call, a 0-100 score and plain flags. Agents pay per call over <a href="https://docs.x402.org">x402</a>; no account or API key.</p>
  <div class="price"><b>${esc(pd.price)}</b><span>per domain report</span><b>${esc(pe.price)}</b><span>per email check, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Bad input and timeouts are free.</span></div>

  <h2>Try it free, right here</h2>
  <p><input id="q" value="example.com" spellcheck="false" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Check</button> <span class="muted">Free preview (domain: DNS + SPF/DMARC; email: syntax + disposable), 10 per minute.</span></p>
  <div class="code"><pre id="out">Result appears here.</pre></div>

  <h2>Free from the command line</h2>
  ${block('free', curlFree)}

  <h2>Give it to your agent: MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tools <code>check_domain</code> and <code>check_email</code>. The remote server answers on the free preview tier; the local stdio server (npm <code>@agentgate-builder/domaincheck</code>) runs the full checks from your own machine.</p>

  <h2>Paid: full reports</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px"><code>GET ?domain=</code> / <code>?email=</code>, or <code>POST {"domain"}</code> / <code>{"email"}</code>. Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(pd.payTo)}</code> through the <a href="${esc(pd.facilitator)}">PayAI facilitator</a>.</p>

  <h2>What you get</h2>
  <div class="grid">
    <div class="card"><h3>Registration (RDAP)</h3><p>Created / expires dates, age in days, registrar and IANA id, registry status (hold, pending delete). Flags domains registered in the last 7 / 30 / 90 days.</p></div>
    <div class="card"><h3>Email authentication</h3><p>SPF (policy, +all, duplicates), DMARC (policy, subdomain policy, reporting, inherited from parent), DKIM on 10 common selectors, MTA-STS, TLS-RPT, BIMI, an A-F mail grade.</p></div>
    <div class="card"><h3>DNS</h3><p>A / AAAA / NS / MX / CAA, null MX, mail provider (Google, Microsoft 365, Proton ...), DNSSEC validation, nonexistent domains.</p></div>
    <div class="card"><h3>Email addresses</h3><p>RFC syntax, ${esc(String(info.data.disposableDomains))} disposable domains (incl. subdomains), role accounts, free webmail, plus-tags and Gmail canonical form, verdict valid / risky / undeliverable.</p></div>
    <div class="card"><h3>Parking and throwaways</h3><p>Parked / for-sale nameservers, disposable providers, domains that cannot receive mail.</p></div>
    <div class="card"><h3>Transparent score</h3><p>100 minus documented penalties. Every flag, severity and penalty is public at <a href="/v1/flags">/v1/flags</a>.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>
    <li>No SMTP mailbox probing: "valid" means well-formed, the domain accepts mail and nothing looks risky, not that the mailbox exists.</li>
    <li>DKIM selectors cannot be listed, so only common selectors are checked. Some ccTLD registries (and rate-limited ones) do not answer RDAP; then age checks are skipped and flagged <code>rdap_unavailable</code>.</li>
    <li>A young domain is a signal, not proof of fraud. Use the score as one input next to your own policy.</li>
    <li>Inputs are looked up in memory and not stored.</li>
  </ul>

  ${trustKitHtml('DomainCheck', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>GET|POST /v1/domain</h3><p>Paid, ${esc(pd.price)}. Full domain report.</p></div>
    <div class="card"><h3>GET|POST /v1/email</h3><p>Paid, ${esc(pe.price)}. Full email check.</p></div>
    <div class="card"><h3>/v1/domain/preview, /v1/email/preview</h3><p>Free, 10/min per IP.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server, tools <code>check_domain</code>, <code>check_email</code>.</p></div>
    <div class="card"><h3><a href="/v1/flags">GET /v1/flags</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. Scoring rules and public usage counters.</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a></h3><p>Free. OpenAPI 3.1 with x402 payment info.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
    <li><a href="${esc(bazaar)}">x402 Bazaar listing</a> (PayAI)</li>
  </ul>
  <footer>DomainCheck by agentgate-builder. Tips welcome: ${esc(pd.payTo)} (Base).</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Checking...';
  const v = document.getElementById('q').value.trim();
  const isEmail = v.includes('@');
  try {
    const r = await fetch(isEmail ? '/v1/email/preview' : '/v1/domain/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(isEmail ? { email: v } : { domain: v }) });
    const j = await r.json();
    if (!r.ok) { out.textContent = j.message || j.error; return; }
    delete j.full; out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
