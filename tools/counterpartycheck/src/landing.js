// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './brand.js';
import { trustKitHtml } from './trustkit.js';
import { EXAMPLE_ADDRESS, SANCTIONED_EXAMPLE_ADDRESS } from './examples.js';

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
  const curlFree = `curl -s "${origin}/v1/preview?address=${SANCTIONED_EXAMPLE_ADDRESS}&chain=ethereum"`;
  const curlPaid = `curl -i "${origin}/v1/quick?address=${EXAMPLE_ADDRESS}&chain=base&intent=pay"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/full" -H 'content-type: application/json' -d '{"address":"${EXAMPLE_ADDRESS}","chain":"base","intent":"pay"}'`;
  const credits = `curl -s -H "Authorization: Bearer $YATC_KEY" "${origin}/v1/quick?address=${EXAMPLE_ADDRESS}&chain=base"   # prepaid credits key, no on-chain payment per call`;
  const mcp = `{ "mcpServers": { "counterpartycheck": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "counterpartycheck": { "command": "npx", "args": ["-y", "@agentgate-builder/counterpartycheck"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Payment agent guardrail: vet the payee before sending money
const r = await (await pay('${origin}/v1/quick?chain=base&intent=pay&address=' + payTo)).json();
if (r.verdict === 'block') throw new Error(\`refusing to pay \${payTo}: \${r.summary}\`);
if (r.verdict === 'caution') await askHuman(r.summary, r.reasons);`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CounterpartyCheck: pre-payment due diligence API for AI agents (EVM and Solana) over x402</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="CounterpartyCheck: is it safe to pay this address?"><meta property="og:description" content="${esc(info.description)}"><meta name="twitter:card" content="summary">
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Counterparty<span>Check</span></div></h1>
  <p class="lead">Is it safe for your agent to pay this address? One call, before the money moves: sanctions and scam lists, the x402 payee directory, wallet vs contract vs token contract vs Safe vs EIP-7702, verification and deployer, ENS and Basename, cross-chain presence, age, recent exposure and approvals. You get <b>ok / caution / block</b>, the reasons and a confidence. EVM (Base, Ethereum, Polygon, Arbitrum One) and Solana.</p>
  <div><span class="price"><b>${esc(p.lite)}</b><span>lite: lists + on-chain type</span></span><span class="price"><b>${esc(p.quick)}</b><span>quick: + verification, names, cross-chain</span></span><span class="price"><b>${esc(p.full)}</b><span>full: + age, exposure, approvals</span></span></div>
  <p class="muted">Pay per call in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402, or with a prepaid <a href="https://api.youraitools.co/credits/">credits key</a>. Invalid input and chain RPC outages are never charged. A safety check only: no price data, no trading signals.</p>

  <h2>Free check</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap"><input id="q" spellcheck="false" value="${esc(SANCTIONED_EXAMPLE_ADDRESS)}" style="flex:1 1 360px"><select id="ch"><option>base</option><option selected>ethereum</option><option>polygon</option><option>arbitrum</option><option>solana</option></select><select id="in"><option>pay</option><option>approve</option><option>interact</option></select></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Check</button> <span class="muted">Free preview: verdict, confidence, address kind and flag counts (10/min).</span></p>
  <pre id="out" class="muted"></pre>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>check_counterparty</code>. The free servers return the preview. Set <code>COUNTERPARTYCHECK_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays the quick report per call over x402 (${esc(p.quick)}, your wallet), or call the paid routes directly.</p>

  <h2>Paid: full reports</h2>
  ${block('paid', curlPaid)}
  ${block('credits', credits)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>, Base). Payments go to <code>${esc(info.payTo)}</code>.</p>

  <h2>What is checked</h2>
  <div class="grid">
    <div class="card"><h3>Sanctions and scam lists</h3><p>OFAC SDN digital-currency addresses (also for the deployer, Safe owners, contract owner and EIP-7702 delegate) and ScamSniffer phishing addresses.</p></div>
    <div class="card"><h3>Known x402 payee?</h3><p>Is the address a payTo in the x402 Bazaar catalog, for how many resources and hosts. Useful before an agent pays an unknown 402.</p></div>
    <div class="card"><h3>What the address is</h3><p>Wallet, contract, token contract (paying it loses funds), Safe multisig, EIP-7702 delegated wallet, upgradeable proxy; Solana wallet, mint, program or token account, and whether it can receive USDC.</p></div>
    <div class="card"><h3>Wrong-chain protection</h3><p>Contract on another chain but nothing here (smart wallets and Safes are per chain): a classic way to lose a payment.</p></div>
    <div class="card"><h3>Identity</h3><p>ENS and Basename reverse records, forward-verified; verified source and contract name; explorer public tags.</p></div>
    <div class="card"><h3>History and exposure</h3><p>Age (first transaction or creation block), recent activity, direct transactions with listed addresses, approvals pouring into an unverified contract.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>${info.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="muted" style="margin-top:10px">${esc(info.disclaimer)}</p>

  ${trustKitHtml('CounterpartyCheck', esc)}

  <h2>Routes</h2>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)}</h3><p>Paid, ${esc(x.price)}. ${esc(x.returns)}</p></div>`).join('')}
    <div class="card"><h3>GET /v1/preview</h3><p>Free, 10/min per IP. Verdict, confidence, kind, flag counts.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (check_counterparty).</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info; public usage counters.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT; bundled ScamSniffer data GPL-3.0) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>CounterpartyCheck by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Checking...';
  const q = new URLSearchParams({ address: document.getElementById('q').value.trim(), chain: document.getElementById('ch').value, intent: document.getElementById('in').value });
  try { const r = await fetch(location.pathname.replace(/\\/$/, '') + '/v1/preview?' + q, { headers: { accept: 'application/json' } }); const j = await r.json(); delete j.full; out.textContent = JSON.stringify(j, null, 2); } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
