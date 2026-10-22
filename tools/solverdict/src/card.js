// Shareable public card: GET /t/<mint> (HTML) and /t/<mint>/card.svg. Shows the verdict, score and a few public facts
// (free preview tier), with links to buy the full report: in the browser (any EIP-1193 wallet signs one x402 USDC
// authorization; no account, no extension-specific code) or over the API / MCP.
import { COLORS, LOGO_SVG } from './brand.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = (n) => (n == null ? 'n/a' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`);
const ageTxt = (d) => (d == null ? 'unknown' : d < 1 ? `${Math.max(1, Math.round(d * 24))} h` : d < 60 ? `${Math.round(d)} days` : `${Math.round(d / 30.4)} months`);
const label = (p) => (p.symbol ? `${p.symbol}${p.name && p.name !== p.symbol ? ` (${p.name})` : ''}` : `${p.token.slice(0, 4)}…${p.token.slice(-4)}`);

/** Facts that are public on the card (subset of the preview). */
export function cardFacts(r) {
  const c = r.checks; const e = c.extensions || {};
  const controls = [!c.authorities.mint_authority ? null : 'mint', !c.authorities.freeze_authority ? null : 'freeze', e.permanent_delegate ? 'delegate' : null, e.transfer_hook_program ? 'hook' : null, e.transfer_fee_pct ? `${e.transfer_fee_pct}% fee` : null].filter(Boolean);
  return {
    token: r.mint, name: r.name, symbol: r.symbol, verdict: r.verdict, score: r.score, confidence: r.confidence,
    controls: controls.length ? `${controls.join(', ')} active${c.recognized ? ' (issuer)' : ''}` : 'none (renounced)',
    liquidity_usd: c.market.liquidity_usd ?? null, bonding_curve: !!c.market.bonding_curve, age_days: c.age?.days ?? null,
    flags: r.reasons.reduce((x, y) => { if (y.severity === 'danger' || y.severity === 'warn') x[y.severity]++; return x; }, { danger: 0, warn: 0 }),
    checked_at: r.checked_at,
  };
}

export function cardSvg(f) {
  const col = COLORS[f.verdict] || COLORS.UNKNOWN;
  const name = esc(label(f)).slice(0, 40);
  const pct = Math.max(0, Math.min(100, f.score));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="SolVerdict ${esc(f.symbol || '')} ${esc(f.verdict)} ${f.score}/100">
<rect width="1200" height="630" fill="#0b1020"/><rect width="1200" height="12" fill="${col}"/>
<g transform="translate(60,48) scale(1.25)">${LOGO_SVG.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>
<text x="155" y="105" font-family="DejaVu Sans,Arial,sans-serif" font-size="42" font-weight="700" fill="#e6e9f0">Sol<tspan fill="#a78bfa">Verdict</tspan></text>
<text x="64" y="200" font-family="DejaVu Sans,Arial,sans-serif" font-size="46" font-weight="700" fill="#e6e9f0">${name}</text>
<text x="64" y="240" font-family="DejaVu Sans Mono,monospace" font-size="22" fill="#64748b">${esc(f.token)} · Solana</text>
<rect x="64" y="275" rx="24" width="${f.verdict.length * 62 + 70}" height="120" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-width="4"/>
<text x="99" y="362" font-family="DejaVu Sans,Arial,sans-serif" font-size="88" font-weight="800" fill="${col}">${esc(f.verdict)}</text>
<text x="${f.verdict.length * 62 + 170}" y="362" font-family="DejaVu Sans,Arial,sans-serif" font-size="72" font-weight="800" fill="#e6e9f0">${f.score}<tspan font-size="36" fill="#94a3b8">/100</tspan></text>
<rect x="64" y="420" width="1072" height="14" rx="7" fill="#1e293b"/><rect x="64" y="420" width="${Math.round(10.72 * pct)}" height="14" rx="7" fill="${col}"/>
<text x="64" y="492" font-family="DejaVu Sans,Arial,sans-serif" font-size="28" fill="#cbd5e1">Controls: ${esc(f.controls)} · Liquidity: ${esc(f.bonding_curve ? 'bonding curve' : money(f.liquidity_usd))} · Age: ${esc(ageTxt(f.age_days))} · ${f.flags.danger} red / ${f.flags.warn} warn</text>
<text x="64" y="570" font-family="DejaVu Sans,Arial,sans-serif" font-size="22" fill="#64748b">Checked ${esc(String(f.checked_at).slice(0, 16).replace('T', ' '))} UTC · not financial advice · api.youraitools.co/solverdict</text>
</svg>`;
}

export function cardHtml({ origin, f, prices }) {
  const col = COLORS[f.verdict] || COLORS.UNKNOWN;
  const title = `${label(f)} on Solana: ${f.verdict} (${f.score}/100) | SolVerdict`;
  const desc = `SolVerdict: ${f.verdict} ${f.score}/100. Controls: ${f.controls}. Liquidity ${f.bonding_curve ? 'on bonding curve' : money(f.liquidity_usd)}. ${f.flags.danger} red flags, ${f.flags.warn} warnings. Mint/freeze authority, Token-2022 traps, liquidity, sells and holders. SAFE is not a guarantee and not financial advice.`;
  const url = `${origin}/t/${f.token}`;
  const share = `https://x.com/intent/post?text=${encodeURIComponent(`${f.symbol ? '$' + f.symbol : f.token} scored ${f.verdict} ${f.score}/100 on SolVerdict (Solana token safety check)`)}&url=${encodeURIComponent(url)}`;
  const apiQuick = `${origin}/v1/check?mint=${f.token}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(origin)}/og/${f.verdict.toLowerCase()}.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(origin)}/og/${f.verdict.toLowerCase()}.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:dark;--bg:#0b0d12;--panel:#131722;--line:#232a3a;--text:#e6e9f0;--muted:#9aa3b5;--c:${col}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:36px 20px 64px}a{color:#7c9cff;text-decoration:none}a:hover{text-decoration:underline}
.brand{display:flex;gap:10px;align-items:center;font-weight:700;font-size:1.2rem;color:var(--text)}.brand span{color:#38bdf8}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:22px}
.card img{width:100%;height:auto;border-radius:12px;display:block}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.btn{display:inline-block;padding:10px 16px;border-radius:10px;border:1px solid var(--line);background:#0f131c;color:var(--text);cursor:pointer;font:inherit}
.btn.main{background:var(--c);color:#111;border:0;font-weight:700}.muted{color:var(--muted)}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86rem}
pre{white-space:pre-wrap;word-break:break-word;background:#0f131c;border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0 0}
input{width:100%;background:#0f131c;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}
ul.r{list-style:none;padding:0;margin:10px 0 0}ul.r li{padding:6px 0;border-bottom:1px solid var(--line)}.s-danger{color:#f87171}.s-warn{color:#fbbf24}.s-info{color:#9aa3b5}.s-good{color:#4ade80}
footer{margin-top:36px;color:var(--muted);font-size:.88rem}
</style></head>
<body><main>
<a class="brand" href="/">${LOGO_SVG.replace('width="64" height="64"', 'width="34" height="34"')}<div>Sol<span>Verdict</span></div></a>
<div class="card">
  <img src="/t/${esc(f.token)}/card.svg" alt="${esc(`${label(f)}: ${f.verdict} ${f.score}/100`)}" width="1200" height="630">
  <p style="margin:14px 0 0"><b>${esc(label(f))}</b> <span class="muted"><code>${esc(f.token)}</code> on Solana</span></p>
  <p class="muted" style="margin:4px 0 0">Verdict <b style="color:var(--c)">${esc(f.verdict)}</b>, score ${f.score}/100, confidence ${esc(f.confidence)}. ${f.flags.danger} red flag${f.flags.danger === 1 ? '' : 's'}, ${f.flags.warn} warning${f.flags.warn === 1 ? '' : 's'}. Checked ${esc(String(f.checked_at).slice(0, 16).replace('T', ' '))} UTC.</p>
  <div class="row">
    <button class="btn main" data-tier="check" type="button">Unlock full report: ${esc(prices.check)} USDC</button>
    <button class="btn" data-tier="lite" type="button">Reasons only: ${esc(prices.lite)}</button>
    <a class="btn" href="${esc(share)}" target="_blank" rel="noopener">Share on X</a>
  </div>
  <p class="muted" style="font-size:.9rem;margin-top:10px">Pay with any EVM wallet in your browser: one exact-amount USDC authorization on Base to our payee (expires in 2 minutes; no account, the facilitator pays gas). Agents can also pay in USDC on Solana via x402, or use a prepaid credits key. Only successful reports are charged.</p>
  <div id="out"></div>
</div>
<div class="card">
  <b>Check another Solana token</b>
  <form id="f" style="margin-top:10px"><input id="q" placeholder="Solana token mint address (base58)" spellcheck="false" autocomplete="off"></form>
</div>
<div class="card">
  <b>For agents</b>
  <pre>curl -i "${esc(apiQuick)}"   # 402 with x402 terms; any x402 client pays it
MCP: { "mcpServers": { "solverdict": { "type": "http", "url": "${esc(origin)}/mcp" } } }</pre>
</div>
<footer>Automated, informational risk signals from public on-chain and market data at the time of the check. Not financial advice, not an audit, no guarantee: a token that passes can still lose value or be changed by whoever controls it. <a href="/">How it works and limits</a>.</footer>
</main>
<script>
const T = ${JSON.stringify(f.token)};
const BASE = location.pathname.split('/t/')[0];
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); const v = document.getElementById('q').value.trim(); if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) location.href = BASE + '/t/' + v; else alert('Enter a Solana token mint address (base58)'); });
const out = document.getElementById('out');
const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
function show(html) { out.innerHTML = html; }
function render(j) {
  const rs = (j.reasons || []).map((r) => '<li class="s-' + escH(r.severity) + '">' + escH(r.severity.toUpperCase()) + ': ' + escH(r.text) + '</li>').join('');
  show('<h3 style="margin:18px 0 0">' + escH(j.verdict) + ' ' + escH(j.score) + '/100 <span class="muted">(' + escH(j.tier) + ' report)</span></h3><ul class="r">' + rs + '</ul><details style="margin-top:10px"><summary>Full JSON</summary><pre>' + escH(JSON.stringify(j, null, 2)) + '</pre></details>');
}
async function unlock(tier) {
  const eth = window.ethereum;
  const url = BASE + '/v1/' + tier + '?mint=' + T;
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
    show('<p class="muted">Running the check and settling...</p>');
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

export function cardErrorHtml({ message, status }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SolVerdict: ${esc(status)}</title><meta name="robots" content="noindex"><style>body{background:#0b0d12;color:#e6e9f0;font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:48px 20px}a{color:#7c9cff}</style></head><body><h1>SolVerdict</h1><p>${esc(message)}</p><p><a href="/">Check a Solana token</a></p></body></html>`;
}
