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
  const curlFree = `curl -s "${origin}/v1/preview?token=${EXAMPLE_TOKEN}"`;
  const curlPaid = `curl -i "${origin}/v1/quick?token=${EXAMPLE_TOKEN}"   # 402 with x402 terms; any x402 client pays it
curl -i -X POST "${origin}/v1/lite" -H 'content-type: application/json' -d '{"token":"${EXAMPLE_TOKEN}"}'`;
  const mcp = `{ "mcpServers": { "tokenverdict": { "type": "http", "url": "${origin}/mcp" } } }`;
  const stdio = `{ "mcpServers": { "tokenverdict": { "command": "npx", "args": ["-y", "@agentgate-builder/tokenverdict"] } } }`;
  const snippet = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// Trading agent guardrail: never buy a token that fails the check
const v = await (await pay('${origin}/v1/quick?token=' + tokenAddress)).json();
if (v.verdict !== 'SAFE') throw new Error(\`skip \${v.symbol}: \${v.verdict} \${v.score}/100: \${v.reasons[0]?.text}\`);`;
  const block = (id, text) => `<div class="code"><button class="copy" data-target="${id}" type="button">Copy</button><pre id="${id}"><code>${esc(text)}</code></pre></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenVerdict: Base token safety check API (honeypot, taxes, owner powers, liquidity) over x402</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:title" content="TokenVerdict: Base ERC-20 token safety check"><meta property="og:description" content="${esc(info.description)}"><meta property="og:image" content="${esc(origin)}/og/generic.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#131722; --line:#232a3a; --text:#e6e9f0; --muted:#9aa3b5; --accent:#38bdf8; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; }
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
  <h1>${LOGO_SVG.replace('width="64" height="64"', 'width="44" height="44"')}<div>Token<span>Verdict</span></div></h1>
  <p class="lead">Safety check for a Base ERC-20 token before an agent or app interacts with it. SAFE is not a guarantee and not financial advice. One call simulates a real buy, wallet transfer and sell on the token&#39;s own pool (Uniswap v2/v3/v4, Aerodrome, Pancake) to catch honeypots and hidden taxes, reads the owner&#39;s powers (mint, blacklist, pause, tax changes, upgradeable proxy, renounced), and checks liquidity, LP burn, holder concentration, verified source and age. You get <b>SAFE / CAUTION / DANGER</b>, a 0-100 score and the reasons.</p>
  <div><span class="price"><b>${esc(p.lite)}</b><span>lite: verdict + reasons</span></span><span class="price"><b>${esc(p.quick)}</b><span>quick: full evidence</span></span><span class="price"><b>${esc(p.deep)}</b><span>deep: multi-pool + holder list</span></span></div>
  <p class="muted">Pay in USDC on Base or Solana (Polygon and Arbitrum One also accepted) over x402. Invalid addresses, non-tokens and source outages are never charged. Free public data only: public Base RPC, Sourcify, DexScreener, GeckoTerminal, plus on-chain factory lookups as a fallback.</p>

  <h2>Free check</h2>
  <p><input id="q" spellcheck="false" value="${esc(EXAMPLE_TOKEN)}" style="width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit"></p>
  <p style="margin-top:10px"><button class="run" id="go" type="button">Get verdict</button> <span class="muted">Opens the shareable card <code>/t/&lt;token&gt;</code>: verdict, score, key facts (10/min).</span></p>

  <h2>Command line</h2>
  ${block('free', curlFree)}

  <h2>MCP</h2>
  ${block('mcp', mcp)}
  ${block('stdio', stdio)}
  <p class="muted" style="margin-top:10px">Tool <code>check_token</code>. The free servers return the preview (verdict, score, flag counts). Set <code>TOKENVERDICT_X402_PRIVATE_KEY</code> in the stdio server&#39;s env and it pays the quick report per call over x402 (${esc(p.quick)}, your wallet), or call the paid routes directly.</p>

  <h2>Paid: full reports</h2>
  ${block('paid', curlPaid)}
  ${block('snippet', snippet)}
  <p class="muted" style="margin-top:10px">Supports x402 v2 (<code>PAYMENT-SIGNATURE</code>) and v1 (<code>X-PAYMENT</code>). Payments go to <code>${esc(info.payTo)}</code>. Humans can pay on any card page with a browser wallet.</p>

  <h2>What is checked</h2>
  <div class="grid">
    <div class="card"><h3>Honeypot simulation</h3><p>Buy, transfer to a fresh wallet, and sell back on the token&#39;s own pool in one simulated call (state overrides, nothing sent). Reports buy / sell / transfer tax and round-trip loss.</p></div>
    <div class="card"><h3>Owner powers</h3><p>Mint, blacklist / bot lists, pause, tax setters, trading switch, max-tx limits, balance setters, role-based access; from the verified ABI or bytecode selectors.</p></div>
    <div class="card"><h3>Proxy and ownership</h3><p>EIP-1967, beacon and legacy proxies (who can upgrade), EIP-1167 clones, owner renounced or held by an EOA or contract.</p></div>
    <div class="card"><h3>Liquidity and LP</h3><p>Pools and USD liquidity (DexScreener, GeckoTerminal fallback); share of v2 LP tokens burned.</p></div>
    <div class="card"><h3>Holders</h3><p>Top-10 concentration (GeckoTerminal snapshot) with pool balances backed out; shown as unknown when the snapshot is unavailable.</p></div>
    <div class="card"><h3>Source and age</h3><p>Verified on Sourcify; exact contract creation block found on-chain (first pool date as fallback).</p></div>
  </div>

  <h2>Honest limits</h2>
  <ul>${info.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="muted" style="margin-top:10px">${esc(info.disclaimer)}</p>

  ${trustKitHtml('TokenVerdict', esc)}

  <h2>Routes</h2>
  <div class="grid">
    ${info.paid.map((x) => `<div class="card"><h3>GET|POST ${esc(x.path)}</h3><p>Paid, ${esc(x.price)}. ${esc(x.returns)}</p></div>`).join('')}
    <div class="card"><h3>GET /v1/preview · /t/&lt;token&gt;</h3><p>Free, 10/min per IP. Verdict, score, flag counts; shareable card with OG image.</p></div>
    <div class="card"><h3>POST /mcp</h3><p>Free. Remote MCP server (check_token).</p></div>
    <div class="card"><h3><a href="/openapi.json">GET /openapi.json</a> · <a href="/v1/stats">/v1/stats</a></h3><p>Free. OpenAPI 3.1 with x402 payment info; public usage counters.</p></div>
  </div>

  <h2>Links</h2>
  <ul>
    <li><a href="${esc(info.source)}">Source</a> (MIT) · <a href="${esc(info.npm)}">npm</a> · <a href="${esc(info.allTools)}">All our tools</a></li>
  </ul>
  <footer>TokenVerdict by agentgate-builder. ${esc(info.disclaimer)}</footer>
</main>
<script>
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
  const t = document.getElementById(b.dataset.target).innerText;
  try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => (b.textContent = 'Copy'), 1500);
}));
document.getElementById('go').addEventListener('click', () => {
  const v = document.getElementById('q').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { alert('Enter a 0x... Base token contract address'); return; }
  location.href = location.pathname.replace(/\/$/, '') + '/t/' + v.toLowerCase();
});
</script>
</body>
</html>`;
}
