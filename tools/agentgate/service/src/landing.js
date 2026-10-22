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

export function landingHtml({ origin, info }) {
  const paid = `${origin}${info.paid.path}`;
  const sample = `${paid}?id=Mf22soLh1NuZYFgBK8iSs&network=mainnet`;
  const bazaar = `https://facilitator.payai.network/discovery/listing-status?resource=${encodeURIComponent(paid)}`;
  const curl = `curl -i "${sample}"`;
  const preview = `curl "${origin}/v1/check-agent/preview?id=Mf22soLh1NuZYFgBK8iSs"`;
  const mcpCfg = `{ "mcpServers": { "agentgate": { "type": "http", "url": "${origin}/mcp" } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.BUYER_KEY); // holds USDC on Base
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
});

const res = await pay('${sample}');
console.log(await res.json()); // { verified, found, active, cardHashMatches, owner, issues, ... }`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentGate: paid agent identity checks over x402</title>
<meta name="description" content="${esc(info.description)}">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#7c9cff; --ok:#4ade80; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 56px 22px 72px; }
  h1 { font-size: 2.4rem; margin: 0 0 6px; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; }
  p { margin: 0 0 12px; }
  .lead { color: var(--muted); font-size: 1.1rem; max-width: 680px; }
  .price { display:inline-flex; gap:10px; align-items:center; margin:22px 0 6px; padding:10px 16px; border:1px solid var(--line); border-radius:999px; background:var(--panel); }
  .price b { color: var(--ok); font-size: 1.15rem; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
  .card h3 { margin: 0 0 6px; font-size: 1rem; }
  .card p { color: var(--muted); font-size: .95rem; margin: 0; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: .88rem; }
  .code { position: relative; background:#0f131c; border:1px solid var(--line); border-radius: 12px; margin: 10px 0 0; }
  .code pre { margin:0; padding: 16px 18px; overflow-x: auto; }
  .copy { position:absolute; top:8px; right:8px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:4px 10px; cursor:pointer; font: inherit; font-size:.8rem; }
  .copy:hover { border-color: var(--accent); }
  ul { padding-left: 20px; margin: 0; } li { margin: 4px 0; }
  .tip { word-break: break-all; }
  footer { margin-top: 48px; color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); padding-top: 18px; }
</style>
</head>
<body>
<main>
  <h1>Agent<span>Gate</span></h1>
  <p class="lead">Before you let an AI agent pay for or call your API, ask: is it accountable? AgentGate checks the <a href="https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html">Concordium Agent Registry</a> and tells you whether an agent is registered, Active and Verified (its Agent Card hash matches on chain). Agents pay per check over <a href="https://docs.x402.org">x402</a>, no account or API key needed.</p>
  <div class="price"><b>$0.005 USDC</b><span>per check, USDC on Base or Solana (Polygon and Arbitrum One also accepted), paid with x402</span></div>

  <h2>Try it free, no wallet: the verdict-only preview</h2>
  ${block('preview', preview)}
  <p style="color:var(--muted);margin-top:10px">20 calls per minute per IP. Returns <code>verified</code>, <code>found</code>, <code>active</code>, <code>cardHashMatches</code> and issues. The paid route adds owner account, agent wallet, Agent Card URI and token id.</p>

  <h2>Give it to your agent: remote MCP server</h2>
  ${block('mcp', mcpCfg)}
  <p style="color:var(--muted);margin-top:10px">One tool, <code>check_agent</code>. Free tier, Streamable HTTP, listed in the official MCP Registry as <code>io.github.agentgate-builder/agentgate</code>.</p>

  <h2>Paid: an unpaid call returns HTTP 402 with the payment terms</h2>
  ${block('curl', curl)}
  <p style="color:var(--muted);margin-top:10px">The <code>PAYMENT-REQUIRED</code> header (base64 JSON) lists the price, network, USDC asset and payee. Any x402 client can pay it and retry automatically.</p>

  <h2>Integrate with the official x402 fetch client</h2>
  <p style="color:var(--muted)"><code>npm i @x402/fetch @x402/evm viem</code></p>
  ${block('snippet', snippet)}

  ${trustKitHtml('AgentGate', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>GET ${esc(info.paid.path)}</h3><p>Paid, $0.005. Query <code>id</code> (badge token address or Concordium account) and optional <code>network</code> (mainnet, testnet, devnet). Bad input (400) and upstream outages (502) are never charged.</p></div>
    <div class="card"><h3><a href="/v1/check-agent/preview?id=Mf22soLh1NuZYFgBK8iSs">GET /v1/check-agent/preview</a></h3><p>Free, 20/min per IP. Same query as the paid route; returns the verdict only.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (Streamable HTTP, stateless JSON) with the <code>check_agent</code> tool.</p></div>
    <div class="card"><h3><a href="/v1/stats">GET /v1/stats</a></h3><p>Free. Public usage counters (402 challenges, paid and free calls) for the last 30 days.</p></div>
    <div class="card"><h3><a href="/health">GET /health</a></h3><p>Free. Liveness check.</p></div>
    <div class="card"><h3><a href="/lax-offer.json">GET /lax-offer.json</a></h3><p>Free. The LAX offer describing this agent, with input and output schemas.</p></div>
    <div class="card"><h3>GET / (JSON)</h3><p>Free. Send <code>Accept: application/json</code> (or use curl) for machine-readable service info.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT: library, x402 middleware, MCP <code>check_agent</code> tool, this service)</li>
    <li><a href="${esc(info.checker)}">Free browser checker</a></li>
    <li><a href="${esc(info.guide)}">Integration guide</a> · <a href="${esc(info.allTools)}">All three tools</a> (code for x402-fetch, x402-axios and Python) · <a href="${esc(info.npm)}">npm</a></li>
    <li><a href="${esc(bazaar)}">x402 Bazaar listing</a> (PayAI facilitator)</li>
  </ul>

  <h2>Tip the builder</h2>
  <p class="tip">USDC or ETH on Base: <code>${esc(info.paid.payTo)}</code></p>

  <footer>AgentGate, an open source agent trust gate. Payments settle through the <a href="${esc(info.paid.facilitator)}">PayAI facilitator</a> directly to the address above.</footer>
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
