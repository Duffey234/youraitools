// Shareable public report: GET /r/<host> (HTML) and the score badge GET /badge/<host>.svg. Shows the free preview
// (score, grade, category scores, counts) with buttons to buy the full audit: in the browser (any EIP-1193 wallet signs one
// x402 USDC authorization; no account, no extension-specific code) or over the API / MCP.
import { COLORS, LOGO_SVG } from './brand.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const VERDICT = { agent_ready: 'Agent-ready', partially_ready: 'Partially ready', not_ready: 'Not ready' };

/** Shields-style SVG badge: "AgentReady | 82 B". */
export function badgeSvg({ score, grade, error }) {
  const right = error ? 'n/a' : `${score} ${grade}`;
  const col = error ? COLORS.UNKNOWN : COLORS[grade] || COLORS.UNKNOWN;
  const lw = 84; const rw = 12 + right.length * 7.4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="AgentReady: ${esc(right)}"><title>AgentReady: ${esc(right)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + rw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#0f172a"/><rect x="${lw}" width="${rw}" height="20" fill="${col}"/><rect width="${lw + rw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">AgentReady</text><text x="${lw + rw / 2}" y="14" font-weight="bold">${esc(right)}</text></g></svg>`;
}

export function reportHtml({ origin, r, url, prices }) {
  const col = COLORS[r.grade] || COLORS.UNKNOWN;
  const title = `${r.host}: AgentReady score ${r.score}/100 (${r.grade}) | Is this site ready for AI agents?`;
  const desc = `${r.host} scores ${r.score}/100 (grade ${r.grade}, ${VERDICT[r.verdict] || r.verdict}) for AI-agent readiness: robots.txt AI bots, bot challenges, raw-HTML content, llms.txt, sitemap, JSON-LD, OpenAPI, MCP, x402, HTTPS and speed. ${r.counts.fail} failing checks.`;
  const page = `${origin}/r/${r.host}`;
  const share = `https://x.com/intent/post?text=${encodeURIComponent(`${r.host} scored ${r.score}/100 (${r.grade}) on AgentReady, the "is this site ready for AI agents?" audit`)}&url=${encodeURIComponent(page)}`;
  const cats = Object.entries(r.categories).map(([k, v]) => { const pct = v.max ? Math.round((v.score / v.max) * 100) : 0; return `<li><span>${esc({ access: 'Agent access', content: 'Readable content', discovery: 'Discovery', interfaces: 'Agent interfaces', performance: 'Speed and HTTPS' }[k] || k)}</span><span class="bar"><i style="width:${pct}%"></i></span><b>${esc(v.score)}/${esc(v.max)}</b></li>`; }).join('');
  const badgeMd = `[![AgentReady score](${origin}/badge/${r.host}.svg)](${page})`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(page)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(origin)}/og/${esc(r.grade.toLowerCase())}.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(origin)}/og/${esc(r.grade.toLowerCase())}.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:dark;--bg:#0b0d12;--panel:#131722;--line:#232a3a;--text:#e6e9f0;--muted:#9aa3b5;--c:${col}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:36px 20px 64px}a{color:#7c9cff;text-decoration:none}a:hover{text-decoration:underline}
.brand{display:flex;gap:10px;align-items:center;font-weight:700;font-size:1.2rem;color:var(--text)}.brand span{color:#38bdf8}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:22px}
.score{display:flex;gap:22px;align-items:center;flex-wrap:wrap}.ring{width:132px;height:132px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--c) ${r.score * 3.6}deg,#1e293b 0)}.ring div{width:104px;height:104px;border-radius:50%;background:var(--panel);display:grid;place-items:center;text-align:center;line-height:1.1}.ring b{font-size:2.2rem}.grade{font-size:2.4rem;font-weight:800;color:var(--c)}
ul.cats{list-style:none;padding:0;margin:16px 0 0}ul.cats li{display:grid;grid-template-columns:170px 1fr 64px;gap:12px;align-items:center;padding:5px 0}.bar{height:10px;background:#1e293b;border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--c)}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.btn{display:inline-block;padding:10px 16px;border-radius:10px;border:1px solid var(--line);background:#0f131c;color:var(--text);cursor:pointer;font:inherit}
.btn.main{background:var(--c);color:#111;border:0;font-weight:700}.muted{color:var(--muted)}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86rem}
pre{white-space:pre-wrap;word-break:break-word;background:#0f131c;border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0 0}
input{width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}
ul.r{list-style:none;padding:0;margin:10px 0 0}ul.r li{padding:6px 0;border-bottom:1px solid var(--line)}.s-high{color:#f87171}.s-medium{color:#fbbf24}.s-low{color:#9aa3b5}.s-fail{color:#f87171}.s-warn{color:#fbbf24}.s-pass{color:#4ade80}.s-unknown{color:#94a3b8}
footer{margin-top:36px;color:var(--muted);font-size:.88rem}
</style></head>
<body><main>
<a class="brand" href="/">${LOGO_SVG.replace('width="64" height="64"', 'width="34" height="34"')}<div>Agent<span>Ready</span></div></a>
<div class="card">
  <h1 style="margin:0;font-size:1.5rem">Is <a href="${esc(r.final_url)}" rel="nofollow noopener">${esc(r.host)}</a> ready for AI agents?</h1>
  <div class="score" style="margin-top:16px"><div class="ring"><div><b>${esc(r.score)}</b><span class="muted">/100</span></div></div>
  <div><div class="grade">Grade ${esc(r.grade)}</div><div>${esc(VERDICT[r.verdict] || r.verdict)} · confidence ${esc(r.confidence)}</div><div class="muted">${r.counts.pass} pass · ${r.counts.warn} weak · ${r.counts.fail} fail${r.counts.unknown ? ` · ${r.counts.unknown} not checked` : ''} · checked ${esc(String(r.checked_at).slice(0, 16).replace('T', ' '))} UTC</div></div></div>
  <ul class="cats">${cats}</ul>
  ${r.sources_failed.length ? `<p class="muted">Not checked (fail-closed, scored 0): ${esc(r.sources_failed.join(', '))}.</p>` : ''}
  <div class="row">
    <button class="btn main" data-tier="audit" type="button">Full audit + fixes: ${esc(prices.audit)} USDC</button>
    <button class="btn" data-tier="lite" type="button">Top 5 fixes: ${esc(prices.lite)}</button>
    <a class="btn" href="${esc(share)}" target="_blank" rel="noopener">Share on X</a>
  </div>
  <p class="muted" style="font-size:.9rem;margin-top:10px">The full audit lists all 23 checks with evidence, which AI bots your robots.txt blocks, every fix by priority, and ready-to-paste snippets (a generated llms.txt draft, robots.txt lines, JSON-LD, meta tags). Pay with any EVM wallet in your browser: one exact-amount USDC authorization on Base to our payee (expires in 2 minutes; no account, the facilitator pays gas). Agents can also pay in USDC on Solana via x402, or use a prepaid credits key. Unreachable sites are never charged.</p>
  <div id="out"></div>
</div>
<div class="card">
  <b>Add the badge</b>
  <pre>${esc(badgeMd)}</pre>
  <p style="margin:10px 0 0"><img src="/badge/${esc(r.host)}.svg" alt="AgentReady ${esc(r.score)} ${esc(r.grade)}" height="20"></p>
</div>
<div class="card">
  <b>Check another site</b>
  <form id="f" style="margin-top:10px"><input id="q" placeholder="example.com" spellcheck="false" autocomplete="off"></form>
</div>
<div class="card">
  <b>For agents</b>
  <pre>curl -i "${esc(origin)}/v1/audit?url=${esc(encodeURIComponent(url))}"   # 402 with x402 terms; any x402 client pays it
MCP: { "mcpServers": { "agentready": { "type": "http", "url": "${esc(origin)}/mcp" } } }</pre>
</div>
<footer>Automated checks of public URLs at the time of the audit, using an honest AgentReadyBot user agent from a Cloudflare edge. Informational; no guarantee that a given AI product will crawl, cite or use the site. <a href="/">How it works and limits</a>.</footer>
</main>
<script>
const U = ${JSON.stringify(url)};
const BASE = location.pathname.split('/r/')[0];
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); const v = document.getElementById('q').value.trim().replace(/^https?:\\/\\//i, '').split(/[\\/?#]/)[0].toLowerCase(); if (/^([a-z0-9-]+\\.)+[a-z][a-z0-9-]+$/.test(v)) location.href = BASE + '/r/' + v; else alert('Enter a domain, e.g. example.com'); });
const out = document.getElementById('out');
const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
function show(html) { out.innerHTML = html; }
function render(j) {
  const fixes = (j.fixes || j.top_issues || []).map((f) => '<li class="s-' + escH(f.priority) + '">' + escH(String(f.priority).toUpperCase()) + ' (+' + escH(f.points_gain) + '): <b>' + escH(f.title) + '</b><br><span class="muted">' + escH(f.how || '') + '</span></li>').join('');
  const checks = (j.checks || []).map((c) => '<li class="s-' + escH(c.status) + '">' + escH(c.status.toUpperCase()) + ' ' + escH(c.id) + ' ' + escH(c.points) + '/' + escH(c.max) + ': <span class="muted">' + escH(c.detail) + '</span></li>').join('');
  const snips = Object.entries(j.snippets || {}).map(([k, v]) => '<h4 style="margin:14px 0 0">' + escH(k) + '</h4><pre>' + escH(v) + '</pre>').join('');
  show('<h3 style="margin:18px 0 0">' + escH(j.score) + '/100, grade ' + escH(j.grade) + ' <span class="muted">(' + escH(j.tier) + ')</span></h3><h4>Fixes</h4><ul class="r">' + fixes + '</ul>' + (checks ? '<h4>Checks</h4><ul class="r">' + checks + '</ul>' : '') + snips + '<details style="margin-top:10px"><summary>Full JSON</summary><pre>' + escH(JSON.stringify(j, null, 2)) + '</pre></details>');
}
async function unlock(tier) {
  const eth = window.ethereum;
  const url = BASE + '/v1/' + tier + '?url=' + encodeURIComponent(U);
  if (!eth) { show('<p class="muted">No browser wallet found. Open this page in a wallet browser (Coinbase Wallet, MetaMask, Rabby...) or call the API with any x402 client: <code>' + escH(location.origin + url) + '</code></p>'); return; }
  try {
    show('<p class="muted">Getting payment terms...</p>');
    const r0 = await fetch(url);
    if (r0.status !== 402) { const j = await r0.json().catch(() => ({})); show('<p class="muted">' + escH(j.message || ('Unexpected HTTP ' + r0.status)) + '</p>'); return; }
    const pr = unb64(r0.headers.get('PAYMENT-REQUIRED'));
    const req = pr.accepts.find((a) => a.network === 'eip155:8453' && a.scheme === 'exact');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }); } catch (e) { /* the wallet will show the chain in the signature request */ }
    const now = Math.floor(Date.now() / 1000);
    const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const auth = { from, to: req.payTo, value: String(req.amount), validAfter: String(now - 600), validBefore: String(now + (req.maxTimeoutSeconds || 120)), nonce };
    const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, primaryType: 'TransferWithAuthorization', domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: req.asset }, message: auth };
    show('<p class="muted">Sign the USDC authorization (' + (Number(req.amount) / 1e6) + ' USDC to ' + escH(req.payTo) + ') in your wallet...</p>');
    const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] });
    show('<p class="muted">Running the audit and settling...</p>');
    const r = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': b64({ x402Version: 2, resource: pr.resource, accepted: req, payload: { authorization: auth, signature }, extensions: pr.extensions || {} }) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { show('<p class="muted">Not charged: ' + escH(j.message || j.error || ('HTTP ' + r.status)) + '</p>'); return; }
    render(j);
  } catch (e) { show('<p class="muted">' + escH(e && e.message ? e.message : e) + '</p>'); }
}
document.querySelectorAll('button[data-tier]').forEach((b) => b.addEventListener('click', () => unlock(b.dataset.tier)));
</script>
</body></html>`;
}

export function reportErrorHtml({ message, status }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AgentReady: ${esc(status)}</title><meta name="robots" content="noindex"><style>body{background:#0b0d12;color:#e6e9f0;font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:48px 20px}a{color:#7c9cff}</style></head><body><h1>AgentReady</h1><p>${esc(message)}</p><p><a href="/">Check a website</a></p></body></html>`;
}
