// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './discovery.js';
import { trustKitHtml } from './trustkit.js';
import { EXAMPLE_INPUT } from './examples.js';

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
  const example = JSON.stringify(EXAMPLE_INPUT, null, 2);
  const curlFree = `curl -s -X POST "${origin}/v1/preview" -H 'content-type: application/json' \\
  -d '{"tx":{"to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","data":"0x095ea7b3000000000000000000000000000000000000000000000000000000000000dEaDffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}}'`;
  const curlPaid = `curl -i -X POST "${origin}/v1/check" -H 'content-type: application/json' -d @tx.json   # 402 with x402 terms; any x402 client pays it`;
  const mcp = `{ "mcpServers": { "signcheck": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "signcheck": { "command": "npx", "args": ["-y", "@agentgate-builder/signcheck"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Guard rail: check every transaction / typed-data request before the agent's wallet signs it
const r = await (await pay('${origin}/v1/check', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tx: { to, data, value, from: wallet.address } }),   // or { typed_data } or { payment_required, payment_payload }
})).json();
if (r.verdict === 'DANGER') throw new Error('SignCheck: ' + r.flags.map((f) => f.message).join(' '));`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SignCheck: is it safe to sign? Pre-sign transaction, Permit and x402 payment check for AI agent wallets, ${esc(pd.price)} over x402</title>
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Sign<span>Check</span></div></h1>
  <p class="lead">Is it safe to sign this? Your agent's wallet is one signature away from an unlimited approval to a drainer, a "free" NFT listing, an EIP-7702 takeover or an x402 payment 1,000x the price it was quoted. SignCheck decodes the transaction, EIP-712 signature request, 7702 delegation or x402 payment into plain English and returns <b>SAFE / CAUTION / DANGER</b> with the reasons.</p>
  <div class="price"><b>${esc(pd.price)}</b><span>per full check, USDC on Base or Solana (Polygon and Arbitrum One also accepted). Offline lite tier (reasons + x402 match, no RPC): <code>/v1/lite</code> ${esc(info.paid?.[1]?.price || '$0.005')}. Invalid input and RPC outages are free.</span></div>
  <p class="muted">Base, Ethereum and Base Sepolia on-chain checks (any EVM chain decodes offline). ${esc(String(info.known_functions))} built-in function signatures + Permit, Permit2, EIP-3009, Seaport and 7702 decoders. OFAC SDN list of ${esc(info.sanctions.list_date)}. Read-only: it never asks for keys or signatures.</p>

  <h2>Free preview</h2>
  <p><textarea id="q" spellcheck="false">${esc(example)}</textarea></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Check</button> <span class="muted">Free offline preview: verdict, summary and flag codes, 10 per minute.</span></p>
  <div class="code"><pre id="out">Result appears here.</pre></div>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>check_signature</code>. The free servers return the offline preview (remote: 10 calls/min). For the reasons, on-chain facts and simulation, set <code>SIGNCHECK_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays this API per call over x402 (${esc(pd.price)}, your wallet), or call the paid route below directly.</p>

  <h2>Paid: full check</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(pd.payTo)}</code>.</p>

  <h2>What it catches</h2>
  <div class="grid">
    <div class="card"><h3>Approvals</h3><p>Unlimited ERC-20 approvals, approvals and Permit2 allowances to plain wallets (EOAs), setApprovalForAll, lookalike Permit2 contracts.</p></div>
    <div class="card"><h3>Gasless signatures</h3><p>EIP-2612 Permit, Permit2 PermitSingle / PermitBatch / TransferFrom, Seaport zero-price listings, never-expiring deadlines, fake "USD Coin" domains.</p></div>
    <div class="card"><h3>x402 payments</h3><p>Pass the 402 and the payment your client built: wrong payTo, overpay, wrong asset or chain, non-Circle "USDC", validity far beyond maxTimeoutSeconds.</p></div>
    <div class="card"><h3>Account takeover</h3><p>EIP-7702 delegations (chainId 0 = every chain), ownership transfers, proxy upgrades, Safe DELEGATECALLs, role grants.</p></div>
    <div class="card"><h3>Counterparties</h3><p>Every address involved: EOA, contract or 7702-delegated, known-protocol label, OFAC SDN match with entity and program.</p></div>
    <div class="card"><h3>Simulation</h3><p>eth_call against the latest block with the revert reason, token symbol/decimals for human amounts, 4-byte names for unknown functions.</p></div>
  </div>

  ${trustKitHtml('SignCheck', esc)}

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="/openapi.json">OpenAPI</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>SignCheck by agentgate-builder. ${esc(info.disclaimer)}</footer>
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
    const r = await fetch('/v1/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: document.getElementById('q').value });
    const j = await r.json();
    if (!r.ok) { out.textContent = j.message || j.error; return; }
    delete j.full; out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'Error: ' + e.message; }
});
</script>
</body>
</html>`;
}
