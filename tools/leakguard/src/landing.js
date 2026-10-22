// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './brand.js';
import { trustKitHtml } from './trustkit.js';
import { EXAMPLE_TEXT } from './examples.js';

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
  const curlFree = `curl -s -X POST "${origin}/v1/preview" -H 'content-type: text/plain' --data-binary @agent-output.txt`;
  const curlPaid = `curl -i -X POST "${origin}/v1/lite" -H 'content-type: application/json' -d '{"text":"..."}'   # 402 with x402 terms; any x402 client pays it
curl -s -X POST "${origin}/v1/scan" -H "Authorization: Bearer $YOURAITOOLS_CREDITS_KEY" -H 'content-type: application/json' -d '{"json": {"tool": "send_email", "args": {"body": "..."}}}'   # prepaid credits`;
  const mcp = `{ "mcpServers": { "leakguard": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "leakguard": { "command": "npx", "args": ["-y", "@agentgate-builder/leakguard"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Outbound guard: redact before the agent calls a third-party tool or LLM
const r = await (await pay('${origin}/v1/lite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: draft }) })).json();
if (!r.safe_to_send) draft = r.redacted;   // r.findings[i].remediation says what to rotate`;
  const local = `import { redact } from '@agentgate-builder/leakguard';   // same engine, offline, zero dependencies
const r = await redact(text);   // { verdict, safe_to_send, findings, redacted }`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LeakGuard: stop AI agents leaking seed phrases, private keys, API keys and PII (x402 API + MCP)</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="LeakGuard: stop AI agents leaking secrets"><meta property="og:description" content="${esc(info.description)}"><meta property="og:image" content="https://agentgate-source.pages.dev/icons/leakguard.png"><meta name="twitter:card" content="summary">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="openapi.json" title="OpenAPI">
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Leak<span>Guard</span></div></h1>
  <p class="lead">Agents paste logs, configs and tool outputs into LLMs, tools and webhooks all day, and sometimes a <b>seed phrase, private key or API key</b> goes with them. LeakGuard checks text or a JSON payload <b>before it leaves</b>: crypto wallet keys (BIP39 seed phrases with checksum, EVM and Solana private keys, WIF, xprv), API secrets (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack, Telegram, npm, JWT, PEM, credentialed URLs) and PII (cards, IBAN, SSN, email, phone). You get a verdict, the redacted text and what to rotate. The deep scan also tells you <b>which wallet a leaked key controls and whether it holds funds right now</b>.</p>
  <div><span class="price"><b>${esc(p.lite)}</b><span>lite: findings + redacted text</span></span><span class="price"><b>${esc(p.scan)}</b><span>scan: JSON payloads + leaked-wallet balances on 5 chains</span></span></div>
  <p class="muted">Pay in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402, or with a prepaid <a href="https://api.youraitools.co/credits/">YourAITools credits</a> key. Invalid or oversized input is never charged. ${esc(info.policy.privacy)}. Fail-closed: ${esc(info.policy.failClosed)}.</p>

  <h2>Free check</h2>
  <p><textarea id="q" spellcheck="false" rows="4" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit">${esc(EXAMPLE_TEXT)}</textarea></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Check</button> <span class="muted">Free preview: verdict and counts only (8 KB, 10/min). Don&#39;t paste live secrets anywhere, including here.</span></p>
  <pre id="out" class="muted"></pre>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Remote tool <code>scan_for_leaks</code> returns the free preview. The stdio server runs the <b>same engine locally and offline</b> (tools <code>scan_for_leaks</code> and <code>redact_text</code>); set <code>LEAKGUARD_X402_PRIVATE_KEY</code> to add <code>check_leaked_wallets</code>, which pays the hosted deep scan (${esc(p.scan)} USDC on Base, your wallet).</p>

  <h2>Library (offline)</h2>
  ${block('local', local)}

  <h2>Paid API</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(info.payTo)}</code>. GET <code>?text=</code> works too, but prefer POST for anything sensitive.</p>

  <h2>What it finds</h2>
  <div class="grid">
    <div class="card"><h3>Wallet keys (critical)</h3><p>BIP39 seed phrases (12-24 words, checksum verified; a near-miss run is flagged at lower confidence), EVM private keys in context, Solana keypairs (JSON byte arrays and base58, verified as real ed25519 keypairs), Bitcoin WIF and BIP32 xprv (base58check).</p></div>
    <div class="card"><h3>Credentials</h3><p>GitHub, GitLab, AWS, Stripe, OpenAI, Anthropic, Google, Slack tokens and webhooks, Discord webhooks, Telegram bot tokens, SendGrid, npm, Hugging Face, Twilio, JWTs, PEM private keys, credentials in URLs, <code>password=</code> / <code>api_key=</code> assignments (entropy-checked).</p></div>
    <div class="card"><h3>PII</h3><p>Card numbers (Luhn), IBAN (mod-97), US SSN (validity rules), email, phone, public IPv4. <code>style=mask</code> keeps the last 4 digits or the email domain.</p></div>
    <div class="card"><h3>Leaked-wallet exposure (scan)</h3><p>For each leaked seed phrase or private key: the public addresses it controls (EVM m/44&#39;/60&#39;/0&#39;/0/0-2, Solana m/44&#39;/501&#39;/0&#39;/0&#39; and m/44&#39;/501&#39;/0&#39;), native + USDC balances on Base, Ethereum, Polygon, Arbitrum One and Solana, and EVM activity: <code>funds_at_risk</code>, <code>used_empty</code>, <code>no_funds_found</code> or <code>unknown</code>.</p></div>
    <div class="card"><h3>JSON payloads (scan)</h3><p>Send the tool-call arguments or webhook body as <code>{"json": ...}</code>: every string and key is checked with its field name as context, findings come back with a JSON path, and <code>redacted_json</code> has the same shape.</p></div>
    <div class="card"><h3>What to do next</h3><p>Every finding carries a remediation line (where to revoke or rotate it); the scan adds an ordered action list, urgent first.</p></div>
  </div>

  <h2>Honest limits</h2>
  <p class="muted">${esc(info.disclaimer)} Limits: preview ${info.limits.previewBytes} bytes, lite ${info.limits.liteBytes} bytes, scan ${info.limits.scanBytes} bytes / ${info.limits.jsonStrings} JSON strings, up to ${info.limits.addressesChecked} wallet addresses checked per scan. BIP39 passphrases (25th word) and non-default derivation paths are not covered.</p>

  ${trustKitHtml('LeakGuard', esc)}

  <h2>Routes</h2>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)}</h3><p>Paid, ${esc(x.price)}. ${esc(x.returns)}</p></div>`).join('')}
    <div class="card"><h3>GET|POST /v1/preview</h3><p>Free, 10/min per IP. Verdict, safe_to_send, counts by type.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (scan_for_leaks).</p></div>
    <div class="card"><h3><a href="openapi.json">GET /openapi.json</a> · <a href="v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info; public usage counters.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>LeakGuard by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Checking...';
  try {
    const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
    const r = await fetch(base + 'v1/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('q').value }) });
    const j = await r.json();
    out.textContent = r.ok ? (j.verdict + ' (safe_to_send: ' + j.safe_to_send + ', max severity: ' + j.max_severity + ')\\n' + Object.entries(j.counts).map(([k, n]) => k + ' x' + n).join('\\n')) : (j.message || j.error);
  } catch (e) { out.textContent = 'Error: ' + e; }
});
</script>
</body>
</html>`;
}
