// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './discovery.js';
import { trustKitHtml } from './trustkit.js';
import { SANCTIONED_ADDRESS, CLEAN_ADDRESS } from './examples.js';

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
  const [pa, pb] = info.paid;
  const curlFree = `curl -s "${origin}/v1/preview?address=${SANCTIONED_ADDRESS}"
curl -s "${origin}/v1/preview?address=${CLEAN_ADDRESS}"`;
  const curlPaid = `curl -i "${origin}/v1/address?address=${SANCTIONED_ADDRESS}"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/batch" -H 'content-type: application/json' -d '{"addresses":["${SANCTIONED_ADDRESS}","${CLEAN_ADDRESS}"]}'`;
  const mcp = `{ "mcpServers": { "payguard": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "payguard": { "command": "npx", "args": ["-y", "@agentgate-builder/payguard"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Screening step in a payout flow, before funds go to a new counterparty:
const r = await (await pay('${origin}/v1/address?address=' + encodeURIComponent(recipient))).json();
if (r.sanctioned) holdForReview(recipient, r.matches); // entity, programs, list_date`;
  const bazaar = `https://facilitator.payai.network/discovery/listing-status?resource=${encodeURIComponent(origin + '/v1/address')}`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  const cur = Object.entries(info.data.by_currency || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayGuard: OFAC SDN sanctions screening for crypto addresses, $0.001 per call over x402</title>
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Pay<span>Guard</span></div></h1>
  <p class="lead">Sanctions screening for crypto addresses, built for AI agents and payment flows. One call reports whether an address appears in the US Treasury OFAC SDN list, and if so which entity, which sanctions programs and since when.</p>
  <div class="price"><b>${esc(pa.price)}</b><span>per address</span><b>${esc(pb.price)}</b><span>per batch of up to 50, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Invalid input is free.</span></div>
  <p class="muted">List: ${esc(info.data.list)}, updated <b>${esc(info.data.list_updated_at)}</b>, ${esc(String(info.data.sdn_address_count))} digital currency addresses (${esc(cur)}).</p>

  <h2>Free preview</h2>
  <p><input id="q" value="${esc(SANCTIONED_ADDRESS)}" spellcheck="false" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Screen</button> <span class="muted">Free preview: sanctioned true/false and chain guess, 10 per minute. The sample is a Lazarus Group address from the SDN list.</span></p>
  <div class="code"><pre id="out">Result appears here.</pre></div>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>screen_address</code>. Both free servers return the preview verdict: sanctioned true/false, match count and chain guess. The remote server is limited to 10 calls/min. The local stdio server (npm <code>@agentgate-builder/payguard</code>) works offline from a bundled list snapshot, with no limit. For entity, programs and list date, set <code>PAYGUARD_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays this API per call over x402 ($0.001, your wallet), or call the paid route below directly.</p>

  <h2>Paid: full results</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px"><code>GET ?address=</code> or <code>POST {"address"}</code>; batch is <code>POST {"addresses": [...]}</code>. Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(pa.payTo)}</code>.</p>

  <h2>What you get</h2>
  <div class="grid">
    <div class="card"><h3>Exact SDN match</h3><p>Every "Digital Currency Address" identifier in the official SDN file. EVM hex and bech32 match case-insensitively; base58 formats match exactly.</p></div>
    <div class="card"><h3>Who and why</h3><p>SDN entity name and type, SDN uid, sanctions programs (e.g. DPRK3, CYBER2, SDGT) and the date the entry was added.</p></div>
    <div class="card"><h3>Chain and checksum</h3><p>Format detection (EVM, bech32/bech32m, base58check, cashaddr, Solana, Monero, XRP) and checksum validity: EIP-55, base58check, bech32, cashaddr.</p></div>
    <div class="card"><h3>Fresh and dated</h3><p>Rebuilt from the Treasury file daily; every response carries <code>list_updated_at</code> and <code>list_age_days</code>.</p></div>
    <div class="card"><h3>Fast and private</h3><p>An in-memory lookup: no third-party calls, inputs are not stored or logged.</p></div>
    <div class="card"><h3>Batch</h3><p>Up to 50 addresses per call for payout runs and allowlist reviews.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>
    <li>Informational screening against public OFAC SDN data. Not legal advice and not a compliance program.</li>
    <li>Only addresses OFAC publishes are matched. A clear result does not mean an address is unsanctioned: sanctions also cover persons and property that OFAC does not list by address, and funds can be one hop away.</li>
    <li>Other lists (EU, UK, UN) and on-chain exposure analysis are out of scope.</li>
  </ul>

  ${trustKitHtml('PayGuard', esc)}

  <h2>Routes</h2>
  <div class="grid">
    <div class="card"><h3>GET|POST /v1/address</h3><p>Paid, ${esc(pa.price)}. Full screening result.</p></div>
    <div class="card"><h3>POST /v1/batch</h3><p>Paid, ${esc(pb.price)}. Up to 50 addresses.</p></div>
    <div class="card"><h3>/v1/preview</h3><p>Free, 10/min per IP.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server, tool <code>screen_address</code>.</p></div>
    <div class="card"><h3><a href="/v1/list">GET /v1/list</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. List date and counts; public usage counters.</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a></h3><p>Free. OpenAPI 3.1 with x402 payment info.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
    <li><a href="${esc(info.data.source_url)}">Official OFAC SDN file</a> · <a href="${esc(bazaar)}">x402 Bazaar listing</a> (PayAI)</li>
  </ul>
  <footer>PayGuard by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out'); out.textContent = 'Screening...';
  try {
    const r = await fetch('/v1/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: document.getElementById('q').value.trim() }) });
    const j = await r.json();
    if (!r.ok) { out.textContent = j.message || j.error; return; }
    delete j.full; out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
