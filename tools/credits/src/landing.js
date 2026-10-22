// Landing page (browsers): what credits are, prices, buy with a browser wallet (USDC on Base), check a balance.
import { LOGO_SVG, TERMS } from './discovery.js';
import { quote, usd, PACKS } from './packs.js';
import { CHAINS } from './claim.js';

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
  const q1 = quote('1'); const q5 = quote('5');
  const rows = q1.calls.map((r, i) => `<tr><td>${esc(r.tool)}</td><td><code>${esc(r.route)}</code></td><td>${esc(r.what)}</td><td>$${esc(r.price_usd)}</td><td>${r.calls.toLocaleString('en-US')}</td><td>${q5.calls[i].calls.toLocaleString('en-US')}</td></tr>`).join('');
  const agent = `import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
// 1) one x402 payment buys the pack and returns a key (store it; shown once)
const { api_key } = await (await pay('${origin}/v1/pack/1', { method: 'POST' })).json();

// 2) every later call: plain fetch with the key, no on-chain payment
const r = await fetch('https://api.youraitools.co/payguard/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96',
  { headers: { authorization: 'Bearer ' + api_key } });
console.log(r.headers.get('x-credits-remaining'), await r.json());`;
  const curl = `# what a pack buys (free)
curl -s "${origin}/v1/preview?pack=5"
# buy: any x402 client pays the 402 (USDC on Base, Polygon, Arbitrum One or Solana)
curl -i -X POST "${origin}/v1/pack/1"
# use the key on any tool
curl -s -H "Authorization: Bearer $KEY" "https://api.youraitools.co/tokenverdict/v1/quick?token=0x532f27101965dd16442E59d40670FaF5eBB142E4"
# balance
curl -s -H "Authorization: Bearer $KEY" "${origin}/v1/balance"`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YourAITools Credits: prepaid $1 / $5 packs for x402 agent APIs</title>
<meta name="description" content="${esc(info.description)}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}">
<style>:root{--bg:#0b0f17;--fg:#e6e9ef;--muted:#9aa7bd;--card:#121a29;--line:#243047;--acc:#38bdf8;--ok:#4ade80}*{box-sizing:border-box}body{font:16px/1.55 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:1.5rem 1rem 3rem;background:var(--bg);color:var(--fg)}a{color:#7cc4ff}h1{margin:.2rem 0}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.card h3{margin:.1rem 0 .3rem}button{background:var(--acc);color:#04111d;border:0;border-radius:8px;padding:.55rem .9rem;font-weight:600;cursor:pointer}button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}pre{background:#0a1220;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:13px}code{font-size:.88em;color:#b8c4d6}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:.4rem;text-align:left;vertical-align:top}th{white-space:nowrap}#out{margin-top:10px}.key{font:600 15px ui-monospace,monospace;color:var(--ok);word-break:break-all}select{background:#0a1220;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.2rem}.small{font-size:13px}input{width:100%;padding:.5rem;border-radius:8px;border:1px solid var(--line);background:#0a1220;color:var(--fg)}</style></head><body>
<p class="muted"><a href="https://youraitools.co/built-by-us">YourAITools</a> · x402 agent APIs</p>
<h1>Credits: pay once, call many times</h1>
<p>${esc(info.description)}</p>
<div class="grid">
  <div class="card"><h3>$1 pack</h3><p>$1.00 of credits. For example ${q1.calls.find((r) => r.tool === 'PayGuard').calls.toLocaleString('en-US')} OFAC address screens, ${q1.calls.find((r) => r.route.endsWith('/v1/quick')).calls} TokenVerdict quick checks or ${q1.calls.find((r) => r.tool === 'WebRead').calls} WebRead pages.</p><button data-pack="1">Buy $1 with a browser wallet</button><p class="muted small">One-click = an x402 signature. Some wallets flag our payee as an "untrusted address" only because it is a new wallet. The signature authorizes exactly this pack's amount to our payee, once, and expires in 2 minutes; it is not an open-ended approval. Prefer no signature prompt? Use "send USDC directly".</p><p><button class="ghost" data-direct="1">Or send 1 USDC directly (no signature prompt)</button></p></div>
  <div class="card"><h3>$5 pack <span class="muted">(+10%)</span></h3><p>$5.50 of credits for $5. For example ${q5.calls.find((r) => r.route.endsWith('/v1/quick')).calls} TokenVerdict quick checks or ${q5.calls.find((r) => r.tool === 'SignCheck' && r.route.endsWith('/v1/check')).calls} SignCheck full checks.</p><button data-pack="5">Buy $5 with a browser wallet</button><p class="muted small">One-click = an x402 signature. Some wallets flag our payee as an "untrusted address" only because it is a new wallet. The signature authorizes exactly this pack's amount to our payee, once, and expires in 2 minutes; it is not an open-ended approval. Prefer no signature prompt? Use "send USDC directly".</p><p><button class="ghost" data-direct="5">Or send 5 USDC directly (no signature prompt)</button></p></div>
  <div class="card"><h3>Check a key</h3><p class="muted">Balance, spend per tool and recent calls.</p><input id="k" placeholder="yatc_..." autocomplete="off"><p><button class="ghost" id="bal">Show balance</button></p></div>
</div>
<p class="muted small">Direct send network: <select id="chain">${Object.entries(CHAINS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select> · a normal USDC transfer to <code>${esc(info.payment.networks[0].payTo)}</code>; your wallet pays a small gas fee in ETH (Base, Arbitrum) or POL (Polygon), then the key appears here after a few confirmations.</p>
<div id="out"></div>
<h2>How it works</h2>
<ol><li><b>Buy</b>: <code>POST ${esc(origin)}/v1/pack/1</code> (or <code>/v1/pack/5</code>) with any x402 client, or the buttons above. You pay once in USDC on Base, Polygon, Arbitrum One or Solana. The response holds your key (<code>yatc_…</code>), <b>shown once</b>.</li>
<li><b>Or send USDC directly</b> (people, no signature prompt): the "send USDC directly" buttons make a plain USDC transfer of exactly 1 or 5 USDC on Base, Polygon or Arbitrum One with a one-time claim code attached; the page then calls the free <code>POST ${esc(origin)}/v1/claim</code>, which checks the transfer on-chain and returns your key once.</li>
<li><b>Use</b>: add <code>Authorization: Bearer &lt;key&gt;</code> to any paid call of the tools below (same URLs, same inputs). The call's normal price is debited from the balance; responses carry <code>X-Credits-Charged</code> and <code>X-Credits-Remaining</code>. Failed calls (HTTP 400+) are not charged.</li>
<li><b>Run out?</b> The tool answers with its normal x402 402 plus <code>X-Credits-Error: insufficient_balance</code>. Top up the same key at <code>/v1/topup/1</code> or <code>/v1/topup/5</code>, or just pay that call with x402.</li>
<li><b>No key?</b> Nothing changes: every tool still takes per-call x402 payments exactly as before.</li></ol>
<h2>What a pack buys (today's prices)</h2>
<div class="tw"><table><tr><th>Tool</th><th>Route</th><th>What</th><th>Price</th><th>Calls / $1</th><th>Calls / $5 pack</th></tr>${rows}</table></div>
<h2>For agents</h2>
<pre>${esc(agent)}</pre>
<pre>${esc(curl)}</pre>
<p class="muted">Also: remote MCP <code>${esc(origin)}/mcp</code> (credits_quote, credits_balance) · <a href="/openapi.json">openapi.json</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/v1/prices">/v1/prices</a> · lost or leaked key: <code>POST /v1/key/rotate</code> with the key moves the balance to a new one. Try the whole flow for half a cent: <code>/v1/pack/sample</code> ($0.005).</p>
<h2>Terms</h2><p class="muted">${esc(TERMS)} Payments go to <code>${esc(info.payment.networks[0].payTo)}</code> (EVM) or the Solana address in the 402 terms. Source: <a href="${esc(info.source)}">${esc(info.source)}</a>.</p>
<script>
const out = document.getElementById('out');
const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
const BASE = location.pathname.replace(/\\/$/, '');
function show(h) { out.innerHTML = '<div class="card">' + h + '</div>'; }
async function buy(pack) {
  const eth = window.ethereum; const url = BASE + '/v1/pack/' + pack;
  if (!eth) { show('<p class="muted">No browser wallet found. Open this page in a wallet browser (Coinbase Wallet, MetaMask, Rabby...) or buy with any x402 client: <code>POST ' + escH(location.origin + url) + '</code></p>'); return; }
  try {
    show('<p class="muted">Getting payment terms...</p>');
    const r0 = await fetch(url, { method: 'POST' });
    if (r0.status !== 402) { show('<p class="muted">Unexpected HTTP ' + r0.status + '</p>'); return; }
    const pr = unb64(r0.headers.get('PAYMENT-REQUIRED'));
    const req = pr.accepts.find((a) => a.network === 'eip155:8453' && a.scheme === 'exact');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }); } catch (e) { /* shown in the signature request */ }
    const now = Math.floor(Date.now() / 1000);
    const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const auth = { from, to: req.payTo, value: String(req.amount), validAfter: String(now - 600), validBefore: String(now + (req.maxTimeoutSeconds || 120)), nonce };
    const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, primaryType: 'TransferWithAuthorization', domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: req.asset }, message: auth };
    show('<p class="muted">Sign the USDC authorization (' + (Number(req.amount) / 1e6) + ' USDC on Base to ' + escH(req.payTo) + ') in your wallet...</p>');
    const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] });
    show('<p class="muted">Settling and creating your key...</p>');
    const r = await fetch(url, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': b64({ x402Version: 2, resource: pr.resource, accepted: req, payload: { authorization: auth, signature }, extensions: pr.extensions || {} }) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.api_key) { show('<p class="muted">Not charged: ' + escH(j.message || j.error || ('HTTP ' + r.status)) + '</p>'); return; }
    show('<h3>Your key (shown once: copy it now)</h3><p class="key">' + escH(j.api_key) + '</p><p>Balance $' + escH(j.balance_usd) + '. Use it as <code>Authorization: Bearer &lt;key&gt;</code> on any tool below.</p><p class="muted">' + escH(j.note) + '</p>');
    document.getElementById('k').value = j.api_key;
  } catch (e) { show('<p class="muted">' + escH(e && e.message ? e.message : e) + '</p>'); }
}
async function balance() {
  const k = document.getElementById('k').value.trim();
  if (!/^yatc_[A-Za-z0-9_-]{43}$/.test(k)) { show('<p class="muted">Paste a key that starts with yatc_.</p>'); return; }
  const r = await fetch(BASE + '/v1/balance', { headers: { authorization: 'Bearer ' + k } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { show('<p class="muted">' + escH(j.message || ('HTTP ' + r.status)) + '</p>'); return; }
  const tools = Object.entries(j.by_tool || {}).map(([t, v]) => escH(t) + ': ' + v.calls + ' calls, $' + escH(v.spent_usd)).join('<br>') || 'no calls yet';
  show('<h3>Balance $' + escH(j.balance_usd) + '</h3><p>Spent $' + escH(j.spent_usd) + ' over ' + j.calls + ' calls (status ' + escH(j.status) + ').</p><p class="muted">' + tools + '</p>');
}
document.querySelectorAll('button[data-pack]').forEach((b) => b.addEventListener('click', () => buy(b.dataset.pack)));
document.getElementById('bal').addEventListener('click', balance);
const CHAINS = ${JSON.stringify(Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [k, { name: v.name, chainId: v.chainId, usdc: v.usdc, explorer: v.explorer }])))};
const PAYEE = ${JSON.stringify(info.payment.networks[0].payTo)};
const AMOUNTS = ${JSON.stringify({ 1: PACKS[1].paid, 5: PACKS[5].paid })};
const PENDING = 'yat_credits_claim';
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const showKey = (j) => { show('<h3>Your key (shown once: copy it now)</h3><p class="key">' + escH(j.api_key) + '</p><p>Balance $' + escH(j.balance_usd) + '. Use it as <code>Authorization: Bearer &lt;key&gt;</code> on any tool below.</p><p class="muted">' + escH(j.note) + '</p>'); document.getElementById('k').value = j.api_key; };
async function claimLoop(p) {
  const until = Date.now() + 6 * 60 * 1000;
  while (Date.now() < until) {
    let r, j;
    try { r = await fetch(BASE + '/v1/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: p.chain, txHash: p.txHash, secret: p.secret }) }); j = await r.json().catch(() => ({})); } catch (e) { r = { status: 0 }; j = {}; }
    if (r.status === 200 && j.api_key) { localStorage.removeItem(PENDING); showKey(j); return; }
    if (r.status === 202 || r.status === 0 || r.status === 429 || r.status === 503) {
      show('<p class="muted">Payment sent (<a target="_blank" rel="noopener" href="' + escH(CHAINS[p.chain].explorer + p.txHash) + '">view tx</a>). ' + escH(j.message || 'Waiting for the network...') + '</p>');
      await new Promise((res) => setTimeout(res, 4000)); continue;
    }
    if (j.error !== 'already_claimed') localStorage.removeItem(PENDING);
    show('<p class="muted">' + escH(j.message || ('HTTP ' + r.status)) + '</p>'); return;
  }
  show('<p class="muted">Still confirming. Reload this page later and press "Resume claim": your payment and claim code are saved in this browser.</p><p><button class="ghost" id="resume">Resume claim</button></p>');
  document.getElementById('resume').addEventListener('click', () => claimLoop(p));
}
async function direct(pack) {
  const eth = window.ethereum; const chain = document.getElementById('chain').value; const c = CHAINS[chain];
  if (!eth) { show('<p class="muted">No browser wallet found. Open this page in a wallet browser (Coinbase Wallet, MetaMask, Rabby...).</p>'); return; }
  try {
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + c.chainId.toString(16) }] }); }
    catch (e) { show('<p class="muted">Switch your wallet to ' + escH(c.name) + ' and try again.</p>'); return; }
    const cid = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
    if (cid !== c.chainId) { show('<p class="muted">Your wallet is not on ' + escH(c.name) + '. Switch network and try again.</p>'); return; }
    const secret = '0x' + hex(crypto.getRandomValues(new Uint8Array(32)));
    const commit = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(secret.slice(2).match(/../g), (b) => parseInt(b, 16)))));
    const data = '0xa9059cbb' + PAYEE.slice(2).toLowerCase().padStart(64, '0') + BigInt(AMOUNTS[pack]).toString(16).padStart(64, '0') + commit;
    const p = { chain, pack, secret, from, t: Date.now() };
    show('<p class="muted">Confirm the transfer of ' + (AMOUNTS[pack] / 1e6) + ' USDC on ' + escH(c.name) + ' to ' + escH(PAYEE) + ' in your wallet...</p>');
    p.txHash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: c.usdc, data, value: '0x0' }] });
    localStorage.setItem(PENDING, JSON.stringify(p));
    await claimLoop(p);
  } catch (e) { show('<p class="muted">' + escH(e && e.message ? e.message : e) + '</p>'); }
}
document.querySelectorAll('button[data-direct]').forEach((b) => b.addEventListener('click', () => direct(b.dataset.direct)));
try { const p = JSON.parse(localStorage.getItem(PENDING) || 'null'); if (p && p.txHash) { show('<p class="muted">You have an unclaimed direct payment (' + escH(CHAINS[p.chain].name) + ', <a target="_blank" rel="noopener" href="' + escH(CHAINS[p.chain].explorer + p.txHash) + '">tx</a>).</p><p><button id="resume0">Resume claim</button></p>'); document.getElementById('resume0').addEventListener('click', () => claimLoop(p)); } } catch (e) { /* ignore */ }
</script>
</body></html>`;
}
