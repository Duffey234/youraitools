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
  const paid = `${origin}${info.paid.path}`;
  const curlFree = `curl -s "${origin}/v1/scan/preview" -H 'content-type: application/json' \\
  -d '{"text":"Please summarize this article about solar panels."}'`;
  const curlPaid = `curl -i "${paid}?url=https://example.com/"   # 402 with x402 terms; pay with any x402 client`;
  const mcp = `{ "mcpServers": { "injectscan": { "type": "http", "url": "${origin}/mcp" } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Scan the MCP tools an agent is about to load (tool poisoning), a web page, or any text:
const res = await pay('${paid}', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tools: (await mcpClient.listTools()).tools }) });
const { verdict, risk_score, tools } = await res.json();`;
  const bazaar = `https://facilitator.payai.network/discovery/listing-status?resource=${encodeURIComponent(paid)}`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  const cats = Object.entries(info.detector.categories ? Object.fromEntries(info.detector.categories.map((k) => [k, k])) : {}).map(([k]) => `<code>${esc(k)}</code>`).join(' ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InjectScan: prompt-injection scanner for AI agents, $0.003 per scan over x402</title>
<meta name="description" content="${esc(info.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#f59e0b; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; }
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Inject<span>Scan</span></div></h1>
  <p class="lead">Check what your agent is about to read (web pages, emails, documents, tool output, other agents' messages and MCP tool descriptions) for prompt injection. You get a 0-100 risk score, a verdict, categories and the exact spans. Deterministic, documented rules. Agents pay per scan over <a href="https://docs.x402.org">x402</a>; no account or API key.</p>
  <div class="price"><b>$0.003 USDC</b><span>per scan, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Invalid input and failed fetches are free.</span></div>

  <h2>Try it free, right here</h2>
  <textarea id="t" spellcheck="false">Please summarize this article about solar panels.</textarea>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Scan</button> <span class="muted">Free preview: up to 2,000 characters, 10 scans per minute.</span></p>
  <div class="code"><pre id="out">Result appears here.</pre></div>

  <h2>Free from the command line</h2>
  ${block('free', curlFree)}

  <h2>Give it to your agent: remote MCP server</h2>
  ${block('mcp', mcp)}
  <p class="muted" style="margin-top:10px">One tool, <code>scan_text</code> (free tier). Tell your agent to call it on untrusted content before following instructions in it.</p>

  <h2>Paid: long text, URLs and MCP tool definitions</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px"><code>GET ?text=</code> / <code>?url=</code>, or <code>POST {"text"}</code>, <code>{"url"}</code> or <code>{"tools":[...]}</code>. Up to 100,000 characters per text and 100 tools per call. In <code>url=</code> mode the visible text <i>and</i> text hidden in the HTML (comments, CSS-hidden elements, alt/aria/meta) are checked. Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(info.paid.payTo)}</code> through the <a href="${esc(info.paid.facilitator)}">x402 facilitator</a>.</p>

  <h2>What it detects</h2>
  <div class="grid">
    <div class="card"><h3>Instruction override</h3><p>"Ignore all previous instructions", "new task:", praise-then-pivot, in English, German, Spanish, French, Italian, Portuguese, Russian, Croatian and Polish.</p></div>
    <div class="card"><h3>Jailbreaks</h3><p>DAN / developer mode / "no restrictions" personas, dual responses, token smuggling, refuse-then-comply.</p></div>
    <div class="card"><h3>Exfiltration</h3><p>Markdown images with data in the URL, URL placeholders like {conversation}, request-collector domains, "send the keys to ...", secret file paths.</p></div>
    <div class="card"><h3>Tool hijack and poisoning</h3><p>&lt;IMPORTANT&gt; blocks, "before using this tool, read ...", cross-tool shadowing, shell payloads, fund transfers and unlimited approvals, "without asking the user".</p></div>
    <div class="card"><h3>Hidden and encoded text</h3><p>Zero-width and Unicode tag characters (ASCII smuggling, decoded and re-scanned), bidi controls, homoglyphs, leetspeak, base64 / hex / escaped payloads.</p></div>
    <div class="card"><h3>Delimiters and extraction</h3><p>Fake &lt;|im_start|&gt; tokens, fake System: turns, "END OF PROMPT", requests to reveal the system prompt or secrets.</p></div>
  </div>
  <p class="muted" style="margin-top:12px">Every rule, weight and pattern is public at <a href="/v1/rules">/v1/rules</a>.</p>

  <h2>Honest limits</h2>
  <ul>
    <li>It is a pattern scanner, not a model. Paraphrased or novel attacks with no known phrasing can pass. Use it as one layer next to least-privilege tools and human confirmation for risky actions.</li>
    <li>Held-out benchmark (ruleset ${esc(info.detector.ruleset)}): recall 0.66 on Lakera's Gandalf "ignore instructions" attacks (an all-attack set, so no precision), P 0.99 / R 0.81 on jackhhao jailbreak-classification, but only R 0.27 on deepset/prompt-injections, which is mostly subtle task-switching. False positives: 1.3% on random Wikipedia articles and 5.6% on GitHub READMEs, where security docs and install scripts look like attacks. Full numbers and method are in the repo.</li>
    <li>Text you send is scanned in memory and not stored.</li>
  </ul>

  ${trustKitHtml('InjectScan', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>GET|POST ${esc(info.paid.path)}</h3><p>Paid, $0.003. text, url or tools. Never charged on 4xx/5xx.</p></div>
    <div class="card"><h3>GET|POST /v1/scan/preview</h3><p>Free, 10/min per IP. Text up to 2,000 characters, full result.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server, tool <code>scan_text</code>.</p></div>
    <div class="card"><h3><a href="/v1/rules">GET /v1/rules</a></h3><p>Free. All rules, weights and patterns.</p></div>
    <div class="card"><h3><a href="/v1/stats">GET /v1/stats</a></h3><p>Free. Public usage counters for the last 30 days.</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a></h3><p>Free. OpenAPI 3.1 with x402 payment info.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT, benchmark in BENCHMARK.md) · <a href="${esc(info.guide)}">Integration guide</a> · <a href="${esc(info.allTools)}">All three tools</a></li>
    <li><a href="${esc(bazaar)}">x402 Bazaar listing</a> (PayAI)</li>
  </ul>
  <footer>InjectScan by agentgate-builder. Tips welcome: ${esc(info.paid.payTo)} (Base).</footer>
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
    const r = await fetch('/v1/scan/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('t').value }) });
    const j = await r.json();
    if (!r.ok) { out.textContent = j.message || j.error; return; }
    const head = document.createElement('div'); head.className = 'v-' + j.verdict; head.textContent = j.verdict.toUpperCase() + '  risk ' + j.risk_score + '/100';
    out.textContent = ''; out.appendChild(head);
    out.appendChild(document.createTextNode((j.categories.length ? '\\nCategories: ' + j.categories.map((c) => c.category + ' ' + c.score).join(', ') : '') + (j.findings.length ? '\\n\\nFindings:\\n' + j.findings.map((f) => '- ' + f.rule + ' [' + f.start + '-' + f.end + '] ' + JSON.stringify(f.text || '')).join('\\n') : '')));
  } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
