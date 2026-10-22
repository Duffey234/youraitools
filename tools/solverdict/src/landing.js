// Root content negotiation: browsers get a small self-contained HTML page; everything else gets JSON.
import { LOGO_SVG } from './brand.js';
import { trustKitHtml } from './trustkit.js';
import { EXAMPLE_TOKEN } from './examples.js';

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
  const curlFree = `curl -s "${origin}/v1/preview?mint=${EXAMPLE_TOKEN}"`;
  const curlPaid = `curl -i "${origin}/v1/check?mint=${EXAMPLE_TOKEN}"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/lite" -H 'content-type: application/json' -d '{"mint":"${EXAMPLE_TOKEN}"}'
curl -s "${origin}/v1/check?mint=${EXAMPLE_TOKEN}" -H "Authorization: Bearer $YOURAITOOLS_CREDITS_KEY"   # prepaid credits`;
  const mcp = `{ "mcpServers": { "solverdict": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "solverdict": { "command": "npx", "args": ["-y", "@agentgate-builder/solverdict"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Trading agent guardrail: never buy a Solana token that fails the check
const v = await (await pay('${origin}/v1/check?mint=' + mint)).json();
if (v.verdict !== 'SAFE') throw new Error(\`skip \${v.symbol}: \${v.verdict} \${v.score}/100: \${v.reasons[0]?.text}\`);`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SolVerdict: Solana token safety check API (mint/freeze authority, Token-2022 traps, liquidity, holders) over x402</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="SolVerdict: Solana token safety check"><meta property="og:description" content="${esc(info.description)}"><meta property="og:image" content="${esc(origin)}/og/generic.png"><meta name="twitter:card" content="summary_large_image">
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Sol<span>Verdict</span></div></h1>
  <p class="lead">Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. One call reads the mint on-chain (mint and freeze authority, every Token-2022 extension that can tax, freeze, seize or block your tokens: transfer fee, permanent delegate, transfer hook, default-frozen accounts, pausable, non-transferable), the metadata update authority, DEX liquidity and 24 h buys vs sells (pump.fun bonding curve aware), and the 20 largest holders split into real wallets vs pools, bonding curves and vaults. You get <b>SAFE / CAUTION / DANGER</b>, a 0-100 score and the reasons.</p>
  <div><span class="price"><b>${esc(p.lite)}</b><span>lite: verdict + reasons</span></span><span class="price"><b>${esc(p.check)}</b><span>check: full evidence + holders</span></span></div>
  <p class="muted">Pay in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402, or with a prepaid <a href="https://api.youraitools.co/credits/">YourAITools credits</a> key. Invalid addresses, non-mints and RPC outages are never charged. Free public data only: public Solana RPC and DexScreener.</p>

  <h2>Free check</h2>
  <p><input id="q" spellcheck="false" value="${esc(EXAMPLE_TOKEN)}" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Get verdict</button> <span class="muted">Opens the shareable card <code>/t/&lt;mint&gt;</code>: verdict, score, key facts (10/min).</span></p>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>check_solana_token</code>. The free servers return the preview (verdict, score, flag counts). Set <code>SOLVERDICT_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays the full check per call over x402 (${esc(p.check)} USDC on Base, your wallet), or call the paid routes directly.</p>

  <h2>Paid: full reports</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(info.payTo)}</code>. Humans can pay on any card page with a browser wallet.</p>

  <h2>What is checked</h2>
  <div class="grid">
    <div class="card"><h3>Mint and freeze authority</h3><p>Active mint authority = unlimited new supply; active freeze authority = your tokens can be frozen so you can&#39;t sell. Recognized issuer assets (USDC, USDT, PYUSD...) are labelled, not flagged.</p></div>
    <div class="card"><h3>Token-2022 traps</h3><p>Permanent delegate (can take tokens from any wallet), transfer hook (custom code on every transfer), transfer fee and who can change it, default-frozen accounts, pausable, non-transferable.</p></div>
    <div class="card"><h3>Liquidity and sells</h3><p>Pools and USD liquidity (DexScreener; Raydium as fallback), pump.fun bonding curve status read on-chain, and 24 h buys vs sells: many buys and zero sells is a honeypot pattern.</p></div>
    <div class="card"><h3>Holders</h3><p>The 20 largest token accounts and their owners: wallets vs program-derived accounts (pools, bonding curves, vaults, lockers), largest wallet and top-10 wallet share.</p></div>
    <div class="card"><h3>Metadata</h3><p>Metaplex or Token-2022 metadata: name, symbol and whether an update authority can still change them.</p></div>
    <div class="card"><h3>Age</h3><p>First DEX pool time; brand-new launches are never rated SAFE.</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>${info.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="muted" style="margin-top:10px">${esc(info.disclaimer)}</p>

  ${trustKitHtml('SolVerdict', esc)}

  <h2>Routes</h2>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)}</h3><p>Paid, ${esc(x.price)}. ${esc(x.returns)}</p></div>`).join('')}
    <div class="card"><h3>GET /v1/preview · /t/&lt;mint&gt;</h3><p>Free, 10/min per IP. Verdict, score, flag counts; shareable card with OG image.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (check_solana_token).</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info; public usage counters.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>SolVerdict by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', () => {
  const v = document.getElementById('q').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) { alert('Enter a Solana token mint address (base58)'); return; }
  location.href = location.pathname.replace(/\/$/, '') + '/t/' + v;
});
</script>
</body>
</html>`;
}
