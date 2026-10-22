// x402fix engine: an unpaid probe of a public x402 endpoint (it never pays and never sends payment headers) that returns
// a graded check list and paste-ready fixes. Tiers:
//   preview: grade, score, counts only            lite:  transport (GET / HEAD / empty POST / CORS) + v2 + v1 + accepts + Bazaar checks + fix list
//   check:   lite + CDP's own validate verdict and Bazaar index status, discovery docs, payee checks (EVM code, Solana USDC
//            token account, CounterpartyCheck screening) + a generated, self-validated extensions.bazaar block and snippet
//   site:    one origin: paid routes from /.well-known/x402 + /openapi.json (up to 8), lite checks on each, doc consistency
import { validate, externalRefs } from './jsonschema.js';
import { withDeadline } from './deadline.js';
import { ataOf } from './solana.js';

export const ENGINE_VERSION = 'x402fix-engine/0.1.2';
export const DISCLAIMER = 'Automated, unpaid probe of a public x402 endpoint: no payment is made and no payment header is sent. Fixes are suggestions to check against the x402 spec and your facilitator docs; a passing grade does not guarantee listing or settlement.';
export const LIMITS = [
  'Unpaid probes only: what happens after a payment (verify, settle, the paid response) is not tested.',
  'One request per method from Cloudflare egress; endpoints that block datacenter IPs or rate-limit may look broken.',
  'Bazaar schema validation implements the JSON Schema subset used by x402 declarations (no formats, no remote refs).',
  'Payee checks use public RPCs and CounterpartyCheck lists; a failed lookup is reported in missing_data, never as a pass.',
];
export class InputError extends Error { constructor(msg, status = 400) { super(msg); this.code = 'bad_request'; this.status = status; } }
export class UpstreamError extends Error { constructor(msg) { super(msg); this.code = 'upstream_unavailable'; } }

// Canonical USDC per CAIP-2 network with the EIP-712 domain (name, version) that EIP-3009 signatures are checked against.
export const USDC = {
  'eip155:8453': { name: 'Base', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', domain: ['USD Coin', '2'], rpcs: ['https://base-rpc.publicnode.com', 'https://gateway.tenderly.co/public/base', 'https://mainnet.base.org'] },
  'eip155:84532': { name: 'Base Sepolia', asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', domain: ['USDC', '2'], testnet: true },
  'eip155:137': { name: 'Polygon', asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', domain: ['USD Coin', '2'], rpcs: ['https://gateway.tenderly.co/public/polygon', 'https://polygon-bor-rpc.publicnode.com'] },
  'eip155:42161': { name: 'Arbitrum One', asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', domain: ['USD Coin', '2'], rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  'eip155:1': { name: 'Ethereum', asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', domain: ['USD Coin', '2'], rpcs: ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet'] },
  'eip155:10': { name: 'OP Mainnet', asset: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', domain: ['USD Coin', '2'] },
  'eip155:43114': { name: 'Avalanche C-Chain', asset: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', domain: ['USD Coin', '2'] },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', svm: true, rpcs: ['https://solana.api.pocket.network', 'https://public.rpc.solanavibestation.com', 'https://solana-rpc.publicnode.com'] },
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { name: 'Solana Devnet', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', svm: true, testnet: true },
};
// x402 v1 network names -> CAIP-2
export const V1_NETWORKS = { base: 'eip155:8453', 'base-sepolia': 'eip155:84532', polygon: 'eip155:137', 'polygon-amoy': 'eip155:80002', avalanche: 'eip155:43114', 'avalanche-fuji': 'eip155:43113', arbitrum: 'eip155:42161', 'arbitrum-sepolia': 'eip155:421614', ethereum: 'eip155:1', optimism: 'eip155:10', solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', iotex: 'eip155:4689', sei: 'eip155:1329', 'sei-testnet': 'eip155:1328', peaq: 'eip155:3338', xlayer: 'eip155:196' };
// Networks the CDP facilitator settles and indexes (its validate preflight, 2026-10-22)
export const CDP_NETWORKS = ['eip155:8453', 'eip155:84532', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'eip155:137', 'eip155:42161', 'eip155:480', 'eip155:143'];
const MULTICHAIN = ['eip155:8453', 'eip155:137', 'eip155:42161', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
const EVM_RE = /^0x[0-9a-fA-F]{40}$/; const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const UA = 'x402fix/0.1 (+https://api.youraitools.co/x402fix; unpaid x402 endpoint check)';
const SEV = { error: 15, warn: 5, info: 0, pass: 0 };

// ---------- input ----------
function privateHost(h) {
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.') && !h.includes(':')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) { const [a, b] = [+m[1], +m[2]]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}
/** { url, method?, framework } from query/body fields. Throws InputError (400, never charged). */
export function normalizeInput(raw = {}) {
  const u = raw.url ?? raw.endpoint ?? raw.resource;
  if (typeof u !== 'string' || !u.trim()) throw new InputError('"url" is required: the full https URL of a paid x402 endpoint, e.g. ?url=https://api.example.com/v1/data');
  const s = u.trim();
  if (s.length > 2048) throw new InputError('"url" is longer than 2048 characters');
  let p; try { p = new URL(s); } catch { throw new InputError('"url" is not a valid absolute URL (include https://)'); }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') throw new InputError('"url" must be http(s)');
  if (p.username || p.password) throw new InputError('"url" must not contain credentials');
  if (privateHost(p.hostname)) throw new InputError('"url" must be a public host (no localhost, private or link-local addresses)');
  if (p.port && !['80', '443', '8080', '8443', '3000', '8000', '8787'].includes(p.port)) throw new InputError('"url" port must be 80, 443, 8080, 8443, 3000, 8000 or 8787');
  p.hash = '';
  const method = raw.method ? String(raw.method).toUpperCase() : undefined;
  if (method && !['GET', 'POST'].includes(method)) throw new InputError('"method" must be GET or POST (the method your paid route uses)');
  const framework = raw.framework ? String(raw.framework).toLowerCase() : 'hono';
  if (!['hono', 'express', 'next'].includes(framework)) throw new InputError('"framework" must be hono, express or next');
  return { url: p.toString(), method, framework };
}

// ---------- probes ----------
async function probe(fetchImpl, url, init = {}, ms = 8000) {
  const t0 = Date.now();
  try {
    const res = await withDeadline(fetchImpl(url, { redirect: 'manual', ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) } }), ms, `probe ${init.method || 'GET'}`);
    const headers = {}; res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let body = '';
    if (init.method !== 'HEAD' && init.method !== 'OPTIONS') { try { body = (await withDeadline(res.text(), ms, 'body')).slice(0, 65536); } catch { body = ''; } }
    return { status: res.status, headers, body, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, error: String(e?.message || e).slice(0, 160), headers: {}, body: '', ms: Date.now() - t0 }; }
}
function b64json(s) {
  if (!s) return { error: 'missing' };
  try {
    const norm = s.trim().replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch { return { error: 'not base64-encoded JSON' }; }
}
export function parse402(p) {
  const v2 = p.headers['payment-required'] ? b64json(p.headers['payment-required']) : { error: 'missing' };
  let v1 = { error: 'missing' };
  if (p.body && /^\s*\{/.test(p.body)) { try { const j = JSON.parse(p.body); v1 = j && j.x402Version === 1 && Array.isArray(j.accepts) ? { value: j } : j && j.x402Version === 2 && Array.isArray(j.accepts) ? { error: 'missing', v2body: j } : { error: 'missing', json: j }; } catch { v1 = { error: 'missing' }; } }
  return { v2, v1 };
}

// ---------- check helpers ----------
function collector() {
  const list = [];
  const add = (severity, id, area, title, extra = {}) => { list.push({ severity, id, area, title, ...extra }); };
  return { list, add };
}
const usdOf = (amount, decimals = 6) => (/^\d+$/.test(String(amount)) ? Number(amount) / 10 ** decimals : null);
const fmtUsd = (n) => (n == null ? '?' : `$${n < 0.01 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(2)}`);
const hasHeader = (list, name) => !!list && (list.trim() === '*' || list.toLowerCase().split(',').map((s) => s.trim()).includes(name));
const declaredMethod = (v2, v1) => {
  const m2 = v2?.extensions?.bazaar?.info?.input?.method; if (typeof m2 === 'string') return m2.toUpperCase();
  const m1 = v1?.accepts?.[0]?.outputSchema?.input?.method; if (typeof m1 === 'string') return m1.toUpperCase();
  return null;
};

function checkTransport({ add }, url, P, method) {
  const u = new URL(url);
  if (u.protocol !== 'https:') add('error', 'url_https', 'transport', 'Endpoint is not HTTPS', { fix: 'Serve the paid route over HTTPS. CDP Bazaar rejects http:// resources and wallets refuse to sign for them.' });
  else add('pass', 'url_https', 'transport', 'HTTPS');
  const g = P.get;
  if (g.status === 0) { add('error', 'reachable', 'transport', `Unreachable from the public internet (${g.error})`, { fix: 'Make sure the URL resolves publicly, answers within 6 s and does not block datacenter IPs (Cloudflare, AWS) that agents and crawlers use.' }); return false; }
  if (g.status === 402) add('pass', 'get_402', 'transport', `${method === 'POST' ? 'GET' : 'Unpaid GET'} answers 402 Payment Required (${g.ms} ms)`);
  else if (g.status >= 300 && g.status < 400) add('warn', 'get_redirect', 'transport', `Unpaid GET redirects (${g.status} to ${String(g.headers.location || '?').slice(0, 120)})`, { fix: 'List and probe the final URL. Many x402 clients do not re-send payment across redirects and Bazaar indexes the exact resource URL.' });
  else if (g.status === 200) add('error', 'get_200', 'transport', 'Unpaid GET answers 200: the route is free or the paywall is not on this path', { fix: 'Mount the x402 payment middleware before the handler for this exact path (route keys like "GET /v1/data" must match, including any proxy prefix).' });
  else if (g.status === 401 || g.status === 403) add('error', 'get_auth_wall', 'transport', `Unpaid GET answers ${g.status} before the 402`, { fix: 'Run x402 before API-key/auth middleware (or exempt this route) so unpaid clients get the 402 terms instead of an auth error. A Cloudflare/WAF challenge also causes this.' });
  else if ((g.status === 405 || g.status === 404) && method === 'POST') add('info', 'get_405', 'transport', `GET answers ${g.status} (route declares POST)`, { fix: 'Optional: also answer GET with the same 402 so directory crawlers that only GET can read your terms.' });
  else if (g.status === 400 || g.status === 422) add('error', 'get_400', 'transport', `Unpaid GET without input answers ${g.status} instead of 402`, { fix: 'Return the 402 when no input is sent (crawlers and directory checks call the bare URL). Validate input after the 402 or only when input is present.' });
  else add('error', 'get_status', 'transport', `Unpaid GET answers ${g.status}, not 402`, { fix: 'The paid URL must answer 402 with payment terms to unpaid requests.' });
  const h = P.head;
  if (h) {
    if (h.status === 402) add('pass', 'head_402', 'transport', 'HEAD answers 402');
    else if (method === 'POST' && h.status === g.status) add('info', 'head_402', 'transport', `HEAD answers ${h.status} like GET (POST route)`, { fix: 'Optional: answer GET and HEAD with the same 402 so directory health checks (402index HEAD-probes) see the route as up.' });
    else add('warn', 'head_402', 'transport', `HEAD answers ${h.status || h.error}, not 402`, { fix: 'Answer HEAD like GET without a body (402 + PAYMENT-REQUIRED header). 402index and other directory health checks probe with HEAD and mark the endpoint down otherwise.' });
  }
  const pe = P.postEmpty;
  if (pe) {
    if (pe.status === 402) add('pass', 'post_empty_402', 'transport', 'Empty POST answers 402');
    else if (method === 'POST') add('error', 'post_empty_402', 'transport', `Empty POST answers ${pe.status || pe.error}, not 402`, { fix: 'For a POST route, an empty POST (no body) must get the 402 terms: crawlers (x402scan, Agent402) probe that way.' });
    else if (pe.status === 404 || pe.status === 405) add('info', 'post_empty_402', 'transport', `Empty POST answers ${pe.status} (fine for a GET-only route)`);
    else add('info', 'post_empty_402', 'transport', `Empty POST answers ${pe.status || pe.error}`);
  }
  const pj = P.postJson;
  if (pj && method === 'POST') {
    if (pj.status === 402) add('pass', 'post_json_402', 'transport', 'POST {} answers 402');
    else add('warn', 'post_json_402', 'transport', `POST {} answers ${pj.status || pj.error}, not 402`, { fix: 'Treat an empty JSON object like no input and return the 402 (some probes send {}). Only reject malformed, non-empty input with 400.' });
  }
  const o = P.options;
  if (o) {
    const acao = o.headers['access-control-allow-origin']; const allowH = o.headers['access-control-allow-headers'] || '';
    if (!acao) add('warn', 'cors_preflight', 'transport', 'No CORS on preflight (OPTIONS): browser and web-wallet buyers cannot pay', { fix: 'Answer OPTIONS with Access-Control-Allow-Origin: * and Access-Control-Allow-Headers: Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Authorization.' });
    else if (!(hasHeader(allowH, 'payment-signature') && hasHeader(allowH, 'x-payment'))) add('warn', 'cors_allow_headers', 'transport', `CORS preflight does not allow PAYMENT-SIGNATURE and X-PAYMENT (allows: ${allowH.slice(0, 80) || 'none'})`, { fix: 'Add PAYMENT-SIGNATURE (x402 v2) and X-PAYMENT (v1) to Access-Control-Allow-Headers, or browsers drop the paid retry.' });
    else add('pass', 'cors_preflight', 'transport', 'CORS preflight allows the payment headers');
  }
  if (g.status === 402) {
    const acao = g.headers['access-control-allow-origin']; const expose = g.headers['access-control-expose-headers'] || '';
    if (g.headers['payment-required'] && !(acao && hasHeader(expose, 'payment-required'))) add('warn', 'cors_expose', 'transport', 'Browsers cannot read the PAYMENT-REQUIRED header (not in Access-Control-Expose-Headers)', { fix: 'Send Access-Control-Allow-Origin: * and Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE on 402 and 200 responses.' });
    else if (g.headers['payment-required']) add('pass', 'cors_expose', 'transport', 'PAYMENT-REQUIRED is exposed to browsers');
    const cc = g.headers['cache-control'] || '';
    if (/s-maxage=[1-9]|max-age=[1-9]/.test(cc) && !/no-store|private|no-cache/.test(cc)) add('warn', 'cache_402', 'transport', `The 402 is cacheable (Cache-Control: ${cc.slice(0, 60)})`, { fix: 'Send Cache-Control: no-store on 402 responses so CDNs never serve a stale payment challenge (or a paid 200 to an unpaid client).' });
    if (g.ms > 3000) add('warn', 'latency', 'transport', `Slow 402 (${g.ms} ms)`, { fix: 'The 402 should be instant (no upstream work before payment). Agents time out and directories mark slow endpoints unhealthy.' });
  }
  return g.status === 402;
}

function checkResource({ add }, res, probedUrl) {
  if (!res || typeof res !== 'object') { add('warn', 'v2_resource', 'v2', 'v2 PaymentRequired has no resource object', { fix: 'Include resource: { url (absolute), description, mimeType }. Bazaar needs it to catalog the route.' }); return; }
  if (typeof res.url !== 'string' || !/^https?:\/\//.test(res.url)) add('error', 'resource_url_absolute', 'v2', `resource.url is ${res.url ? 'relative' : 'missing'} (${String(res.url || '').slice(0, 80)})`, { fix: 'Set resource.url to the absolute public URL (https://host/path). Behind a proxy, configure the public base URL instead of the internal host.' });
  else {
    const a = new URL(res.url); const b = new URL(probedUrl);
    if (a.host !== b.host || a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '')) add('warn', 'resource_url_match', 'v2', `resource.url (${res.url.slice(0, 100)}) differs from the probed URL`, { fix: 'resource.url should be the URL buyers call. A different host usually means a proxy/CDN in front: advertise the public URL.' });
    else add('pass', 'resource_url', 'v2', 'resource.url is absolute and matches');
  }
  const d = typeof res.description === 'string' ? res.description.trim() : '';
  if (d.length < 20) add('warn', 'description', 'v2', d ? `Description is very short (${d.length} chars)` : 'No description', { fix: 'Write 1-3 sentences: what it returns, for which input, from which data. Agents choose tools from this text and directories show it.' });
  else add('pass', 'description', 'v2', `Description present (${d.length} chars)`);
  if (!res.mimeType) add('info', 'mime_type', 'v2', 'No resource.mimeType', { fix: 'Add mimeType (e.g. application/json).' });
  if (res.serviceName !== undefined && !(typeof res.serviceName === 'string' && /^[\x20-\x7e]{1,32}$/.test(res.serviceName))) add('warn', 'service_name', 'bazaar', 'resource.serviceName is not 1-32 printable ASCII characters (soft-dropped by the Bazaar)', { fix: 'Use a short ASCII name, at most 32 characters.' });
  if (res.tags !== undefined && !(Array.isArray(res.tags) && res.tags.length <= 5 && res.tags.every((t) => typeof t === 'string'))) add('warn', 'tags', 'bazaar', 'resource.tags must be at most 5 strings (soft-dropped otherwise)', { fix: 'Keep 1-5 short tags.' });
  if (res.iconUrl !== undefined && !(typeof res.iconUrl === 'string' && /^https:\/\//.test(res.iconUrl))) add('warn', 'icon_url', 'bazaar', 'resource.iconUrl must be an absolute https URL', { fix: 'Host a square PNG/SVG over https and use its absolute URL.' });
}

function checkAccept({ add }, a, i, ver) {
  const tag = `${ver} accepts[${i}]`;
  if (!a || typeof a !== 'object') { add('error', 'accept_shape', ver, `${tag} is not an object`); return null; }
  const errs = []; const warns = [];
  let net = a.network;
  if (ver === 'v1') {
    if (typeof net !== 'string' || !(net in V1_NETWORKS)) (CAIP2_RE.test(String(net)) ? warns : errs).push([`network "${net}" is not a v1 network name`, 'v1 uses names like "base", "polygon", "solana" (CAIP-2 ids are v2 only).']);
    net = V1_NETWORKS[net] || net;
  } else if (typeof net !== 'string' || !CAIP2_RE.test(net)) errs.push([`network "${net}" is not a CAIP-2 id`, `v2 networks are CAIP-2: ${V1_NETWORKS[net] ? `"${V1_NETWORKS[net]}" for "${net}"` : 'e.g. "eip155:8453" (Base), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"'}.`]);
  const info = USDC[net]; const svm = String(net).startsWith('solana:');
  if (!['exact', 'upto'].includes(a.scheme)) warns.push([`scheme "${a.scheme}" is not exact/upto`, 'Most clients and the CDP facilitator only pay "exact" (and "upto").']);
  const amtKey = ver === 'v1' ? 'maxAmountRequired' : 'amount';
  const amt = a[amtKey];
  if (typeof amt !== 'string' || !/^\d+$/.test(amt)) errs.push([`${amtKey} is ${typeof amt === 'number' ? 'a JSON number' : JSON.stringify(amt)?.slice(0, 40)}, not an atomic-units string`, `Send ${amtKey} as a string of base units, e.g. "10000" for $0.01 USDC (6 decimals).`]);
  else if (BigInt(amt) === 0n) errs.push([`${amtKey} is 0`, 'A zero-amount exact payment cannot settle; make the route free instead.']);
  else if (BigInt(amt) < 1000n && info) warns.push([`${amtKey} ${amt} is below $0.001`, 'CDP Bazaar indexes only amounts >= 1000 base units ($0.001 USDC).']);
  else if (BigInt(amt) > 100_000_000n && a.scheme === 'exact') warns.push([`price ${fmtUsd(usdOf(amt))} per call`, 'Check the decimals: USDC has 6 (1 USDC = "1000000"). If intended, consider the "upto" scheme or a prepaid pack.']);
  if (typeof a.asset !== 'string') errs.push([`asset is ${a.asset === undefined ? 'missing' : typeof a.asset}`, 'asset must be the token address string (not an object).']);
  const isUsdc = !!info && typeof a.asset === 'string' && a.asset.toLowerCase() === info.asset.toLowerCase();
  const vc = typeof a.extra?.verifyingContract === 'string' && typeof a.asset === 'string' && a.extra.verifyingContract.toLowerCase() !== a.asset.toLowerCase() ? a.extra.verifyingContract : null;
  const infos = [];
  if (info && typeof a.asset === 'string' && !isUsdc) infos.push([`asset ${a.asset.slice(0, 12)}… is not canonical USDC on ${info.name}`, `USDC on ${info.name} is ${info.asset}. Fine if intended (e.g. USDT0): only facilitators that support this token can settle it; the CDP facilitator settles USDC.`]);
  if (vc) infos.push([`EIP-712 domain "${a.extra.name}" v${a.extra.version} belongs to verifyingContract ${vc.slice(0, 12)}… (e.g. Circle Gateway batched), not the token: domain and validity window not checked`, 'Buyers need a client that supports this scheme variant; keep a plain EIP-3009 entry for everyone else.']);
  if (typeof a.payTo !== 'string' || !a.payTo) errs.push(['payTo is missing', 'Set payTo to your receiving wallet.']);
  else if (svm ? !SOL_RE.test(a.payTo) : String(net).startsWith('eip155:') && !EVM_RE.test(a.payTo)) errs.push([`payTo ${a.payTo.slice(0, 20)} is not a valid ${svm ? 'Solana' : 'EVM'} address`, `Use a ${svm ? 'base58 wallet address' : '0x + 40 hex address'} on this network.`]);
  else if (/^0x0{40}$/i.test(a.payTo)) errs.push(['payTo is the zero address', 'Funds sent there are burned. Set your wallet.']);
  else if (typeof a.asset === 'string' && a.payTo.toLowerCase() === a.asset.toLowerCase()) errs.push(['payTo is the token contract itself', 'Payments to a token contract are lost. Set your wallet as payTo.']);
  if (a.maxTimeoutSeconds === undefined) warns.push(['maxTimeoutSeconds is missing', 'Set maxTimeoutSeconds (60-300 is typical); clients use it for the signature validity window.']);
  else if (!(Number.isInteger(a.maxTimeoutSeconds) && a.maxTimeoutSeconds >= 10 && (vc || a.maxTimeoutSeconds <= 3600))) warns.push([`maxTimeoutSeconds ${a.maxTimeoutSeconds} is outside 10-3600`, 'Use an integer between 60 and 300 seconds.']);
  if (svm && a.scheme === 'exact' && !(a.extra && typeof a.extra.feePayer === 'string' && SOL_RE.test(a.extra.feePayer))) errs.push(['Solana exact entry has no extra.feePayer', "Set extra.feePayer to your facilitator's Solana fee payer (from its /supported). Without it SVM clients cannot build the transaction."]);
  if (!svm && String(net).startsWith('eip155:') && a.scheme === 'exact') {
    const n = a.extra?.name; const v = a.extra?.version;
    if (!n || !v) warns.push(['extra.name / extra.version (EIP-712 domain) missing', `Add extra: { name: "${info?.domain?.[0] || 'USD Coin'}", version: "${info?.domain?.[1] || '2'}" }. Clients sign EIP-3009 against this domain; guessing fails on some chains.`]);
    else if (isUsdc && !vc && info?.domain && (n !== info.domain[0] || String(v) !== info.domain[1])) errs.push([`EIP-712 domain "${n}" v${v} does not match USDC on ${info.name} ("${info.domain[0]}" v${info.domain[1]})`, `Set extra: { name: "${info.domain[0]}", version: "${info.domain[1]}" }. Signatures over the wrong domain fail verification, so every payment is rejected.`]);
  }
  if (ver === 'v1') {
    if (typeof a.resource !== 'string' || !/^https?:\/\//.test(a.resource)) errs.push(['resource is not an absolute URL', 'v1 accepts[].resource must be the absolute URL.']);
    if (!a.description) warns.push(['description missing', 'v1 directories (x402scan) show accepts[].description.']);
    if (!a.outputSchema?.input) warns.push(['outputSchema.input missing', 'v1 crawlers read outputSchema.input ({ type: "http", method, queryParams | bodyFields }) to list how to call the route.']);
  }
  for (const [t, f] of errs) add('error', `${ver}_accept_${i}`, ver, `${tag} (${info?.name || net}): ${t}`, { fix: f });
  for (const [t, f] of warns) add('warn', `${ver}_accept_${i}`, ver, `${tag} (${info?.name || net}): ${t}`, { fix: f });
  for (const [t, f] of infos) add('info', `${ver}_accept_${i}_note`, ver, `${tag} (${info?.name || net}): ${t}`, { fix: f });
  if (!errs.length && !warns.length) add('pass', `${ver}_accept_${i}`, ver, `${tag}: ${a.scheme} ${fmtUsd(usdOf(amt))} on ${info?.name || net}`);
  return { network: net, name: info?.name || net, amount: typeof amt === 'string' ? amt : null, usd: usdOf(amt), payTo: a.payTo, asset: a.asset, scheme: a.scheme, svm, testnet: !!info?.testnet, usdc: isUsdc, vc, method: a.extra?.assetTransferMethod || '' };
}

function checkBazaar({ add }, ext, method) {
  const bz = ext?.bazaar;
  if (!bz) { add('warn', 'bazaar_missing', 'bazaar', 'No extensions.bazaar: CDP Bazaar / Agentic.Market will not catalog this route', { fix: 'Declare discovery metadata (input example + JSON Schema, output example) with declareDiscoveryExtension from @x402/extensions/bazaar. The check tier generates it for you.' }); return { ok: false }; }
  const info = bz.info; const schema = bz.schema; let ok = true;
  const e = (id, title, fix) => { ok = false; add('error', id, 'bazaar', title, { fix }); };
  if (!info || typeof info !== 'object') e('bazaar_info', 'extensions.bazaar.info is missing', 'Add info: { input: { type: "http", method, queryParams | body }, output: { type: "json", example } }.');
  else {
    const t = info.input?.type;
    if (t !== 'http' && t !== 'mcp') e('bazaar_input_type', `info.input.type is ${JSON.stringify(t)} (must be "http" or "mcp")`, 'Set info.input.type: "http" for HTTP routes.');
    if (t === 'http') {
      const m = info.input?.method;
      if (!METHODS.includes(String(m).toUpperCase())) e('bazaar_method', `info.input.method is ${JSON.stringify(m)}`, 'Set info.input.method to the HTTP method buyers use ("GET" or "POST").');
      else if (method && String(m).toUpperCase() !== method) add('warn', 'bazaar_method_match', 'bazaar', `Declared method ${m} but you said the route uses ${method}`, { fix: 'Declare the method the paid route actually serves.' });
      if (String(m).toUpperCase() === 'GET' && info.input?.body !== undefined) add('warn', 'bazaar_get_body', 'bazaar', 'GET declaration carries a body', { fix: 'Use queryParams for GET; body + bodyType: "json" for POST.' });
      if (String(m).toUpperCase() === 'POST' && info.input?.body !== undefined && !info.input?.bodyType) add('warn', 'bazaar_body_type', 'bazaar', 'POST body declared without bodyType', { fix: 'Add bodyType: "json" (or "form-data" / "text").' });
    }
    if (t === 'mcp' && !(info.input?.toolName && info.input?.inputSchema)) e('bazaar_mcp', 'MCP declaration lacks toolName / inputSchema', 'MCP declarations need input.toolName and input.inputSchema.');
    if (info.output !== undefined && (typeof info.output !== 'object' || !info.output.type)) e('bazaar_output_type', 'info.output is present without output.type', 'Add output.type (e.g. "json"); validators reject output without a type.');
    if (!info.output) add('info', 'bazaar_output', 'bazaar', 'No output example', { fix: 'Add output: { type: "json", example: {...} } with a real response; agents decide from it.' });
  }
  if (!schema || typeof schema !== 'object') e('bazaar_schema', 'extensions.bazaar.schema is missing', 'Add a JSON Schema (draft 2020-12) describing info; facilitators validate info against it before cataloging.');
  else {
    if (schema.$schema && !/2020-12/.test(schema.$schema)) add('warn', 'bazaar_schema_draft', 'bazaar', `schema.$schema is ${String(schema.$schema).slice(0, 80)} (spec: draft 2020-12)`, { fix: 'Use "$schema": "https://json-schema.org/draft/2020-12/schema".' });
    const ext2 = externalRefs(schema);
    if (ext2.length) e('bazaar_external_ref', `Schema uses external $ref/$id (${ext2.slice(0, 2).join(', ')})`, 'Only same-document refs ("#/...") are allowed; facilitators reject external refs (SSRF protection). Inline the definitions.');
    if (!schema.properties?.input) e('bazaar_schema_input', 'schema.properties.input is missing', 'The schema must define properties.input (required).');
    if (info && !ext2.length) {
      const v = validate(schema, info);
      if (v.length) e('bazaar_schema_mismatch', `info does not validate against its own schema (${v.slice(0, 3).map((x) => `${x.path}: ${x.message}`).join('; ')})`, 'Make the example in info satisfy the schema (types, required keys, enums), or relax the schema. Mismatches are silently dropped by the Bazaar.');
    }
  }
  if (ok) add('pass', 'bazaar_valid', 'bazaar', 'extensions.bazaar is well-formed and info validates against its schema');
  return { ok, method: info?.input?.method };
}

function crossChecks({ add }, terms2, terms1) {
  const live = terms2.filter((t) => t && t.usd != null && !t.testnet && t.usdc); // compare USDC entries only (other tokens have other decimals)
  const prices = [...new Set(live.map((t) => t.usd))];
  if (prices.length > 1) add('warn', 'price_consistency', 'multichain', `Different prices per network (${live.map((t) => `${t.name} ${fmtUsd(t.usd)}`).join(', ')})`, { fix: 'Charge the same USD amount on every network (unless intended); agents compare networks by price.' });
  const nets = terms2.filter(Boolean).map((t) => t.network);
  const keys = terms2.filter(Boolean).map((t) => `${t.network}|${t.scheme}|${String(t.asset).toLowerCase()}|${String(t.vc || '').toLowerCase()}|${String(t.payTo).toLowerCase()}|${t.method || ''}`); // same network with another token / verifying contract is fine
  const dups = keys.filter((k, i) => keys.indexOf(k) !== i).map((k) => k.split('|')[0]);
  if (dups.length) add('warn', 'duplicate_network', 'multichain', `Same network, scheme and asset listed twice (${[...new Set(dups)].join(', ')})`, { fix: 'One accepts entry per network, scheme and asset; clients pick the first and the rest is noise.' });
  const missing = MULTICHAIN.filter((n) => !nets.includes(n));
  if (terms2.length && missing.length) add('info', 'multichain_coverage', 'multichain', `Accepts ${[...new Set(terms2.filter(Boolean).map((t) => t.name))].join(', ')}; not ${missing.map((n) => USDC[n].name).join(', ')}`, { fix: 'Agents funded on other chains cannot pay without bridging. The CDP facilitator also settles USDC on Polygon, Arbitrum One and Solana: add an accepts entry per network (the check tier prints them).' });
  const nonCdp = terms2.filter((t) => t && !CDP_NETWORKS.includes(t.network));
  if (nonCdp.length) add('info', 'facilitator_support', 'multichain', `${[...new Set(nonCdp.map((t) => t.name))].join(', ')}: not settled by the CDP facilitator (use one that supports it, e.g. PayAI)`);
  if (terms1.length && terms2.length) {
    for (const t1 of terms1.filter(Boolean)) {
      const t2 = terms2.find((t) => t && t.network === t1.network);
      if (!t2) continue;
      if (t2.amount !== t1.amount || String(t2.payTo).toLowerCase() !== String(t1.payTo).toLowerCase()) add('error', 'v1_v2_mismatch', 'v1', `v1 and v2 terms disagree on ${t1.name} (v1 ${fmtUsd(t1.usd)} to ${String(t1.payTo).slice(0, 10)}…, v2 ${fmtUsd(t2.usd)} to ${String(t2.payTo).slice(0, 10)}…)`, { fix: 'Generate both from one config so price and payTo cannot drift.' });
    }
  }
}

// ---------- check-tier extras ----------
async function rpcJson(fetchImpl, urls, body, ms = 4000) {
  let last;
  for (const u of urls || []) {
    try { const r = await withDeadline(fetchImpl(u, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(body) }), ms, 'rpc'); if (!r.ok) { last = `HTTP ${r.status}`; continue; } const j = await r.json(); if (j.error) { last = j.error.message; continue; } return j.result; } catch (e) { last = e.message; }
  }
  throw new UpstreamError(`rpc failed (${String(last).slice(0, 60)})`);
}
async function payeeChecks({ add }, terms, { fetchImpl, counterparty, missing }) {
  const seen = new Set();
  for (const t of terms.filter((x) => x && x.payTo && !x.testnet)) {
    const k = `${t.network}|${t.payTo}`; if (seen.has(k)) continue; seen.add(k);
    const info = USDC[t.network];
    if (t.svm && info?.rpcs && SOL_RE.test(t.payTo)) {
      try {
        const ata = ataOf(t.payTo, info.asset);
        const r = await rpcJson(fetchImpl, info.rpcs, { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[t.payTo, ata], { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] });
        const [own, tok] = r?.value || [];
        if (tok) add('pass', 'solana_usdc_account', 'payee', `Solana payTo has a USDC token account (${ata.slice(0, 6)}…)`);
        else if (own?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') add('warn', 'solana_payto_token_account', 'payee', 'Solana payTo is itself a token account, not a wallet', { fix: 'x402 SVM clients derive the USDC token account from payTo: use the owner wallet address as payTo.' });
        else add('warn', 'solana_usdc_account', 'payee', `Solana payTo has no USDC token account yet (expected ${ata})`, { fix: 'Create the USDC associated token account once (receive any USDC, or create it in a wallet). Until then Solana buyers must pay the account rent or their payment fails.' });
      } catch (e) { missing.push(`solana_rpc: ${e.message}`); }
    } else if (!t.svm && info?.rpcs && EVM_RE.test(t.payTo)) {
      try {
        const code = await rpcJson(fetchImpl, info.rpcs, { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [t.payTo, 'latest'] });
        if (!code || code === '0x') add('pass', `payto_kind_${info.name}`, 'payee', `payTo on ${info.name} is a plain wallet (EOA)`);
        else if (/^0xef0100/i.test(code)) add('info', `payto_kind_${info.name}`, 'payee', `payTo on ${info.name} is an EIP-7702 delegated wallet`);
        else add('info', `payto_kind_${info.name}`, 'payee', `payTo on ${info.name} is a contract (${(code.length - 2) / 2} bytes)`, { fix: 'Fine for a Safe or smart wallet you control on this chain; make sure it exists at the same address on every network you list.' });
      } catch (e) { missing.push(`${info.name.toLowerCase().replace(/ /g, '_')}_rpc: ${e.message}`); }
    }
    if (counterparty) {
      try {
        const chain = t.svm ? 'solana' : ({ 'eip155:8453': 'base', 'eip155:137': 'polygon', 'eip155:42161': 'arbitrum', 'eip155:1': 'ethereum' })[t.network];
        if (chain) {
          const v = await counterparty(t.payTo, chain);
          if (v?.verdict === 'block') add('error', 'payto_flagged', 'payee', `payTo ${t.payTo.slice(0, 10)}… is flagged by CounterpartyCheck (${chain}: block)`, { fix: 'Buyer agents that screen payees will refuse to pay. Use a clean wallet you control; check the reasons at https://api.youraitools.co/counterpartycheck.' });
          else if (v?.verdict === 'caution') add('info', 'payto_screen', 'payee', `CounterpartyCheck on payTo (${chain}): caution (${v.kind || 'address'}; new or unused wallets often show this)`);
          else if (v?.verdict === 'ok') add('pass', 'payto_screen', 'payee', `CounterpartyCheck on payTo (${chain}): ok`);
        }
      } catch (e) { missing.push(`counterpartycheck: ${String(e.message).slice(0, 60)}`); }
    }
  }
}
export const CDP_VALIDATE_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/validate';
async function cdpVerdict({ add }, url, { fetchImpl, missing }) {
  try {
    const r = await withDeadline(fetchImpl(CDP_VALIDATE_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify({ resource: url }) }), 9000, 'cdp validate');
    if (!r.ok) { missing.push(`cdp_validate: HTTP ${r.status}`); return null; }
    const j = await r.json();
    const failed = (j.preflight || []).filter((p) => p && p.passed === false);
    const req = failed.filter((p) => p.severity === 'required');
    if (j.valid) add('pass', 'cdp_validate', 'cdp', `CDP validate: would be indexed (${(j.preflight || []).length} preflight checks passed)`);
    else add('error', 'cdp_validate', 'cdp', `CDP validate: would NOT be indexed (${req.length || failed.length} failed: ${(req.length ? req : failed).slice(0, 4).map((p) => `${p.check}${p.detail ? ` - ${String(p.detail).slice(0, 80)}` : ''}`).join('; ')})`, { fix: 'Fix the failed CDP preflight checks above; they are exactly what the CDP facilitator checks before cataloging.' });
    for (const p of failed.filter((x) => x.severity !== 'required').slice(0, 3)) add('info', `cdp_${p.check}`, 'cdp', `CDP (optional) ${p.check}: ${String(p.detail || '').slice(0, 120)}`);
    if (j.index?.active) add('pass', 'bazaar_indexed', 'cdp', `Listed in CDP Bazaar (last crawled ${j.index.lastCrawledAt || '?'})`);
    else add('info', 'bazaar_indexed', 'cdp', 'Not in the CDP Bazaar index yet', { fix: 'CDP catalogs a route after the first settled payment whose payload echoes extensions.bazaar (one small self-payment through a v2 client is enough).' });
    return { valid: !!j.valid, indexed: !!j.index?.active, last_crawled_at: j.index?.lastCrawledAt || null, failed: failed.map((p) => ({ check: p.check, severity: p.severity, detail: p.detail })), simulation: j.simulation || null };
  } catch (e) { missing.push(`cdp_validate: ${String(e.message).slice(0, 60)}`); return null; }
}
const docBases = (url) => {
  const u = new URL(url); const segs = u.pathname.split('/').filter(Boolean); const out = [u.origin];
  if (segs.length >= 2) out.unshift(`${u.origin}/${segs[0]}`);
  return out;
};
async function fetchDocs(fetchImpl, bases) {
  const out = { openapi: null, wellKnown: null, openapiUrl: null, wellKnownUrl: null, infra: [] };
  const note = (p, u) => { if (p.status === 0 && String(p.error || '').startsWith(SELF_PROBE_UNAVAILABLE)) out.infra.push({ source: 'discovery', url: u, reason: p.error }); return p; };
  await Promise.all(bases.flatMap((b) => [
    probe(fetchImpl, `${b}/openapi.json`, {}, 5000).then((p) => note(p, `${b}/openapi.json`)).then((p) => { if (!out.openapi && p.status === 200) { try { const j = JSON.parse(p.body); if (j?.paths) { out.openapi = j; out.openapiUrl = `${b}/openapi.json`; } } catch { /* not JSON */ } } }),
    probe(fetchImpl, `${b}/.well-known/x402`, {}, 5000).then((p) => note(p, `${b}/.well-known/x402`)).then((p) => { if (!out.wellKnown && p.status === 200) { try { const j = JSON.parse(p.body); if (j && (j.resources || j.version)) { out.wellKnown = j; out.wellKnownUrl = `${b}/.well-known/x402`; } } catch { /* not JSON */ } } }),
  ]));
  return out;
}
const wkResources = (wk) => (Array.isArray(wk?.resources) ? wk.resources.map((r) => (typeof r === 'string' ? r : r?.url || r?.resource)).filter((x) => typeof x === 'string') : []);
function openapiPaid(doc, fallbackOrigin) {
  if (!doc?.paths) return [];
  const server = (doc.servers?.[0]?.url || fallbackOrigin || '').replace(/\/$/, '');
  const out = [];
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops || {})) {
    if (!op || typeof op !== 'object' || !['get', 'post'].includes(m)) continue;
    const pay = op['x-payment-info'] || op['x-x402'];
    if (pay) out.push({ url: /^https?:/.test(server) ? `${server}${p}` : null, path: p, method: m.toUpperCase(), price: pay?.price?.amount ?? null, op });
  }
  return out;
}
function checkDocs({ add }, url, docs, liveUsd) {
  const path = new URL(url).pathname.replace(/\/$/, '');
  if (!docs.openapi) add('info', 'openapi', 'discovery', 'No /openapi.json found next to the route', { fix: 'Publish /openapi.json with an x-payment-info block per paid operation: x402scan, Agent402 and agent frameworks discover routes from it.' });
  else {
    const paid = openapiPaid(docs.openapi);
    const hit = paid.find((o) => path.endsWith(o.path.replace(/\/$/, '')) || (o.url && o.url.replace(/\/$/, '') === url.split('?')[0].replace(/\/$/, '')));
    if (!hit) add('warn', 'openapi_route', 'discovery', `${docs.openapiUrl} does not list this route with x-payment-info`, { fix: 'Add the paid operation with "x-payment-info": { "price": { "mode": "fixed", "currency": "USD", "amount": "0.01" }, "protocols": [{ "x402": {} }] }.' });
    else if (hit.price != null && liveUsd != null && Math.abs(Number(hit.price) - liveUsd) > 1e-9) add('warn', 'openapi_price', 'discovery', `openapi.json says $${hit.price}, the live 402 asks ${fmtUsd(liveUsd)}`, { fix: 'Build openapi.json from the same price config as the 402.' });
    else add('pass', 'openapi_route', 'discovery', 'openapi.json lists this route with x-payment-info');
  }
  if (!docs.wellKnown) add('info', 'well_known', 'discovery', 'No /.well-known/x402 manifest', { fix: 'Publish /.well-known/x402 { "version": 1, "resources": ["https://.../v1/route"] } (x402scan origin discovery).' });
  else if (!wkResources(docs.wellKnown).some((r) => r.split('?')[0].replace(/\/$/, '') === url.split('?')[0].replace(/\/$/, ''))) add('info', 'well_known_route', 'discovery', '/.well-known/x402 does not list this exact URL', { fix: 'List every paid route as an absolute URL in resources.' });
  else add('pass', 'well_known_route', 'discovery', '/.well-known/x402 lists this URL');
}

// ---------- generated fixes ----------
const jsType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'object' ? 'object' : 'string');
const propsOf = (obj) => Object.fromEntries(Object.entries(obj || {}).slice(0, 30).map(([k, v]) => [k, { type: jsType(v) }]));
/** A corrected extensions.bazaar block built from what the route declares (or the URL's query), validated against itself. */
export function generateBazaar({ url, method, info, docOp }) {
  const m = (method || info?.input?.method || docOp?.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const u = new URL(url);
  let query = info?.input?.queryParams && typeof info.input.queryParams === 'object' ? info.input.queryParams : Object.fromEntries(u.searchParams);
  if (!Object.keys(query).length && docOp?.op?.parameters) query = Object.fromEntries(docOp.op.parameters.filter((p) => p?.in === 'query').slice(0, 20).map((p) => [p.name, p.example ?? p.schema?.example ?? p.schema?.default ?? (p.schema?.type === 'integer' || p.schema?.type === 'number' ? 1 : 'example')]));
  let body = info?.input?.body && typeof info.input.body === 'object' ? info.input.body : null;
  if (m === 'POST' && !body) body = Object.keys(query).length ? query : {};
  const input = m === 'GET' ? { type: 'http', method: 'GET', ...(Object.keys(query).length ? { queryParams: query } : {}) } : { type: 'http', method: 'POST', bodyType: 'json', body };
  const example = info?.output?.example && typeof info.output.example === 'object' ? info.output.example : { result: 'replace with a real response example' };
  const required = Object.keys(m === 'GET' ? query : body || {});
  const inputSchema = { type: 'object', properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: [m] }, ...(m === 'GET' ? (Object.keys(query).length ? { queryParams: { type: 'object', properties: propsOf(query), ...(required.length ? { required } : {}) } } : {}) : { bodyType: { type: 'string', enum: ['json'] }, body: { type: 'object', properties: propsOf(body), ...(required.length ? { required } : {}) } }) }, required: ['type', 'method'] };
  const bazaar = { info: { input, output: { type: 'json', example } }, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { input: inputSchema, output: { type: 'object', properties: { type: { type: 'string' }, example: { type: 'object' } }, required: ['type'] } }, required: ['input'] } };
  const self = validate(bazaar.schema, bazaar.info);
  const args = m === 'GET' ? `input: ${JSON.stringify(query)},\n    inputSchema: { properties: ${JSON.stringify(propsOf(query))}${required.length ? `, required: ${JSON.stringify(required)}` : ''} },` : `bodyType: 'json',\n    input: ${JSON.stringify(body)},\n    inputSchema: { properties: ${JSON.stringify(propsOf(body))}${required.length ? `, required: ${JSON.stringify(required)}` : ''} },`;
  const snippet = `import { declareDiscoveryExtension } from '@x402/extensions/bazaar';\n// in your route config (@x402/hono, @x402/express or @x402/next paymentMiddleware):\n'${m} ${u.pathname}': {\n  accepts: [/* see generated.accepts */],\n  description: '...',\n  mimeType: 'application/json',\n  extensions: { ...declareDiscoveryExtension({\n    ${args}\n    output: { example: ${JSON.stringify(example).slice(0, 400)} },\n  }) },\n},`;
  return { bazaar, self_valid: self.length === 0, snippet };
}
function generateAccepts(terms) {
  const base = terms.find((t) => t && !t.testnet && t.amount);
  if (!base) return null;
  const evmPay = terms.find((t) => t && !t.svm && EVM_RE.test(String(t.payTo)))?.payTo || '<your 0x wallet>';
  const solPay = terms.find((t) => t && t.svm)?.payTo || '<your Solana wallet>';
  return MULTICHAIN.map((n) => {
    const i = USDC[n];
    return i.svm ? { scheme: 'exact', network: n, amount: base.amount, asset: i.asset, payTo: solPay, maxTimeoutSeconds: 120, extra: { feePayer: "<your facilitator's Solana feePayer from /supported>" } } : { scheme: 'exact', network: n, amount: base.amount, asset: toChecksum(i.asset, n), payTo: evmPay, maxTimeoutSeconds: 120, extra: { name: i.domain[0], version: i.domain[1] } };
  });
}
const CHECKSUM = { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', '0xaf88d065e77c8cc2239327c5edb3a432268e5831': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' };
const toChecksum = (a) => CHECKSUM[a] || a;

// ---------- scoring ----------
function grade(list, reached402) {
  const errors = list.filter((x) => x.severity === 'error').length; const warns = list.filter((x) => x.severity === 'warn').length;
  const score = Math.max(0, 100 - list.reduce((s, x) => s + SEV[x.severity], 0));
  const g = !reached402 ? 'F' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  const status = !reached402 ? 'broken' : errors ? 'fix_needed' : warns ? 'ok_with_warnings' : 'pass';
  return { grade: g, score: reached402 ? score : Math.min(score, 30), status, counts: { errors, warnings: warns, info: list.filter((x) => x.severity === 'info').length, passed: list.filter((x) => x.severity === 'pass').length } };
}
const ORDER = { error: 0, warn: 1, info: 2, pass: 3 };
const fixesOf = (list) => list.filter((x) => (x.severity === 'error' || x.severity === 'warn') && x.fix).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]).map((x, i) => ({ n: i + 1, severity: x.severity, id: x.id, problem: x.title, fix: x.fix }));

/** Diagnose one endpoint. tier: preview | lite | check (| route = lite checks with GET + HEAD only, used by site). */
export async function diagnose(input, { tier = 'lite', fetchImpl = (...a) => globalThis.fetch(...a), counterparty, now = Date.now() } = {}) {
  const { url } = input; const C = collector(); const missing = [];
  const light = tier === 'route';
  const [get, head, postEmpty, postJson, options] = await Promise.all([
    probe(fetchImpl, url),
    probe(fetchImpl, url, { method: 'HEAD' }),
    light ? null : probe(fetchImpl, url, { method: 'POST' }),
    light ? null : probe(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    light ? null : probe(fetchImpl, url, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': input.method || 'GET', 'access-control-request-headers': 'content-type,payment-signature,x-payment' } }),
  ]);
  // Fail closed on our own infrastructure: if one of our own tools could not be reached from this Worker (loopback /
  // missing service binding, see sibling.js), the result is 'incomplete' (grade 'unknown'), never a false F.
  const infra = [get, head, postEmpty, postJson, options].filter((p) => p && p.status === 0 && String(p.error || '').startsWith(SELF_PROBE_UNAVAILABLE));
  if (infra.length && ![get, postEmpty, postJson].some((p) => p && p.status === 402)) return incompleteReport(url, tier, input.method, infra[0].error, now);
  // POST-only routes: take the terms from the POST probe when GET is not a 402
  const src = get.status === 402 ? get : postEmpty?.status === 402 ? postEmpty : postJson?.status === 402 ? postJson : get;
  const parsed = src.status === 402 ? parse402(src) : { v2: { error: 'missing' }, v1: { error: 'missing' } };
  const v2 = parsed.v2.value; const v1 = parsed.v1.value;
  const method = input.method || declaredMethod(v2, v1) || (get.status === 402 ? 'GET' : (postEmpty?.status === 402 || postJson?.status === 402) ? 'POST' : 'GET');
  const reached = checkTransport(C, url, { get, head, postEmpty, postJson, options }, method) || src.status === 402;
  if (src !== get && src.status === 402) C.add('info', 'post_terms', 'transport', 'Terms read from the POST 402 (GET does not return them)');
  const terms2 = []; const terms1 = [];
  if (src.status === 402) {
    if (v2) {
      if (v2.x402Version !== 2) C.add('error', 'v2_version', 'v2', `PAYMENT-REQUIRED has x402Version ${JSON.stringify(v2.x402Version)}, expected 2`, { fix: 'Set x402Version: 2 in the PaymentRequired object.' });
      else C.add('pass', 'v2_header', 'v2', 'x402 v2 PAYMENT-REQUIRED header decodes');
      checkResource(C, v2.resource, url);
      if (!Array.isArray(v2.accepts) || !v2.accepts.length) C.add('error', 'v2_accepts', 'v2', 'v2 accepts is empty or missing', { fix: 'List at least one payment option in accepts.' });
      else v2.accepts.slice(0, 12).forEach((a, i) => terms2.push(checkAccept(C, a, i, 'v2')));
    } else if (parsed.v2.error !== 'missing') C.add('error', 'v2_header', 'v2', `PAYMENT-REQUIRED header is ${parsed.v2.error}`, { fix: 'Base64-encode the JSON PaymentRequired object (standard base64) into the PAYMENT-REQUIRED header.' });
    else if (parsed.v1.v2body) C.add('error', 'v2_in_body', 'v2', 'v2 terms are in the body, not the PAYMENT-REQUIRED header', { fix: 'x402 v2 clients read the base64 PAYMENT-REQUIRED header. Use the official @x402/* server middleware.' });
    else C.add(v1 ? 'warn' : 'error', 'v2_missing', 'v2', 'No x402 v2 PAYMENT-REQUIRED header', { fix: 'Add x402 v2 (the @x402/hono, @x402/express or @x402/next middleware). v2 clients and the CDP Bazaar read the PAYMENT-REQUIRED header; v1-only is legacy.' });
    if (v1) {
      C.add('pass', 'v1_body', 'v1', 'x402 v1 body present (legacy clients can pay)');
      v1.accepts.slice(0, 12).forEach((a, i) => terms1.push(checkAccept(C, a, i, 'v1')));
    } else if (v2) C.add('info', 'v1_missing', 'v1', 'No x402 v1 body: v1-only clients (x402-fetch 1.x, x402-axios, older agent SDKs) cannot pay', { fix: 'Optional: also return the v1 JSON body ({ x402Version: 1, accepts: [...] }) for Base so legacy clients can pay.' });
    if (v2) checkBazaar(C, v2.extensions, input.method);
    crossChecks(C, terms2, terms1);
  }
  let cdp = null, generated = null, docs = null;
  if (tier === 'check' && src.status === 402) {
    const bases = docBases(url);
    const [cdpR, docsR] = await Promise.all([cdpVerdict(C, url, { fetchImpl, missing }), fetchDocs(fetchImpl, bases), payeeChecks(C, terms2.length ? terms2 : terms1, { fetchImpl, counterparty, missing })]);
    cdp = cdpR; docs = docsR;
    checkDocs(C, url, docs, (terms2.find((t) => t && !t.testnet) || terms1[0] || {}).usd ?? null);
    const docOp = openapiPaid(docs.openapi).find((o) => new URL(url).pathname.replace(/\/$/, '').endsWith(o.path.replace(/\/$/, '')));
    const gb = generateBazaar({ url, method, info: v2?.extensions?.bazaar?.info, docOp });
    generated = { bazaar: gb.bazaar, bazaar_self_valid: gb.self_valid, accepts: generateAccepts(terms2.length ? terms2 : terms1), snippet: gb.snippet, note: 'Paste-ready: the bazaar block validates against its own schema. Replace placeholders in <> before deploying.' };
  }
  const g = grade(C.list, reached);
  const networks = [...new Set([...terms2, ...terms1].filter(Boolean).map((t) => t.name))];
  const out = {
    url, tier: tier === 'route' ? 'site_route' : tier, method, ...g,
    summary: summaryOf(g, C.list, networks, !!v2, !!v1),
    x402: { v2: !!v2, v1: !!v1, networks, price_usd: (terms2.find((t) => t && !t.testnet) || terms1.find((t) => t && !t.testnet) || {}).usd ?? null, bazaar: !!v2?.extensions?.bazaar },
    probes: { get: get.status || get.error, head: head.status || head.error, ...(postEmpty ? { post_empty: postEmpty.status || postEmpty.error } : {}), ...(postJson ? { post_json: postJson.status || postJson.error } : {}), ...(options ? { options: options.status || options.error } : {}), ms: get.ms },
    fixes: fixesOf(C.list),
    checks: C.list,
    ...(cdp ? { cdp } : tier === 'check' && src.status === 402 ? { cdp: null } : {}),
    ...(docs ? { discovery: { openapi: docs.openapiUrl, well_known: docs.wellKnownUrl } } : {}),
    ...(generated ? { generated } : {}),
    missing_data: missing, limits: LIMITS, disclaimer: DISCLAIMER, engine: ENGINE_VERSION, checked_at: new Date(now).toISOString(),
  };
  return out;
}
const SITE_MAX_ROUTES = 8;
const SELF_PROBE_UNAVAILABLE = 'self_probe_unavailable'; // same marker as sibling.js (kept here so the engine has no Worker imports)
function incompleteReport(url, tier, method, error, now) {
  return {
    url, tier: tier === 'route' ? 'site_route' : tier, method: method || 'GET', grade: 'unknown', score: null, status: 'incomplete',
    counts: { errors: 0, warnings: 0, info: 0, passed: 0 },
    summary: 'INCOMPLETE: the endpoint could not be probed from x402fix for infrastructure reasons (not graded; retry later).',
    x402: { v2: false, v1: false, networks: [], price_usd: null, bazaar: false },
    probes: { get: String(error).slice(0, 160) }, fixes: [], checks: [],
    sources_failed: [{ source: 'target', url, reason: String(error).slice(0, 200) }],
    missing_data: ['target'], limits: LIMITS, disclaimer: DISCLAIMER, engine: ENGINE_VERSION, checked_at: new Date(now).toISOString(),
  };
}
function summaryOf(g, list, networks, v2, v1) {
  if (g.status === 'broken') { const top = list.find((x) => x.severity === 'error'); return `BROKEN: ${top ? top.title : 'no 402 payment terms'}.`; }
  const proto = [v2 && 'v2', v1 && 'v1'].filter(Boolean).join('+') || 'no x402';
  const head = `${g.grade} (${g.score}/100): x402 ${proto}, ${networks.length ? networks.join(', ') : 'no valid network'}`;
  if (g.status === 'pass') return `${head}. No problems found.`;
  return `${head}. ${g.counts.errors} error(s), ${g.counts.warnings} warning(s); first fix: ${(list.find((x) => x.severity === 'error') || list.find((x) => x.severity === 'warn')).title}.`;
}
export const previewView = (r) => ({ url: r.url, grade: r.grade, score: r.score, status: r.status, counts: r.counts, x402: r.x402, method: r.method, engine: r.engine, checked_at: r.checked_at, ...(r.sources_failed ? { sources_failed: r.sources_failed } : {}) });

/** Site audit: discover the paid routes of an origin (/.well-known/x402 + /openapi.json), lite-check up to 8, check doc consistency. */
export async function diagnoseSite(input, { fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now() } = {}) {
  const u = new URL(input.url); const base = `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  const bases = [...new Set([base, ...(u.pathname.split('/').filter(Boolean).length ? [`${u.origin}/${u.pathname.split('/').filter(Boolean)[0]}`] : []), u.origin])].slice(0, 2);
  const docs = await fetchDocs(fetchImpl, bases);
  const C = collector(); const missing = [];
  const fromWk = wkResources(docs.wellKnown); const fromOa = openapiPaid(docs.openapi, u.origin).map((o) => o.url).filter(Boolean);
  if (!docs.wellKnown) C.add('warn', 'well_known', 'discovery', 'No /.well-known/x402 manifest', { fix: 'Publish /.well-known/x402 { "version": 1, "resources": [absolute URLs of every paid route] } (x402scan origin discovery).' }); else C.add('pass', 'well_known', 'discovery', `/.well-known/x402 lists ${fromWk.length} resource(s)`);
  if (!docs.openapi) C.add('warn', 'openapi', 'discovery', 'No /openapi.json', { fix: 'Publish /openapi.json with x-payment-info per paid operation (x402scan, Agent402, agent frameworks).' }); else C.add(fromOa.length ? 'pass' : 'warn', 'openapi_paid', 'discovery', `openapi.json marks ${fromOa.length} paid operation(s) with x-payment-info`, fromOa.length ? {} : { fix: 'Add "x-payment-info" to each paid operation.' });
  const norm = (x) => x.split('?')[0].replace(/\/$/, '');
  const onlyOa = fromOa.filter((x) => !fromWk.map(norm).includes(norm(x))); const onlyWk = fromWk.filter((x) => !fromOa.map(norm).includes(norm(x)));
  if (docs.wellKnown && docs.openapi && (onlyOa.length || onlyWk.length)) C.add('warn', 'docs_drift', 'discovery', `Discovery docs disagree (${onlyOa.length} only in openapi.json, ${onlyWk.length} only in /.well-known/x402)`, { fix: 'Generate both documents from one route table.', detail: { only_openapi: onlyOa.slice(0, 8), only_well_known: onlyWk.slice(0, 8) } });
  const routes = [...new Set([...fromWk, ...fromOa].map(norm))].filter((x) => { try { const p = new URL(x); return !privateHost(p.hostname) && /^https?:$/.test(p.protocol); } catch { return false; } });
  if (!routes.length) C.add('error', 'no_routes', 'discovery', 'No paid routes discoverable from this origin', { fix: 'Publish /.well-known/x402 and /openapi.json (x-payment-info) listing your paid routes; directories and agents cannot find them otherwise.' });
  if (!routes.length && docs.infra.length) return { ...incompleteReport(input.url, 'site', undefined, docs.infra[0].reason, now), tier: 'site', origin: u.origin, sources_failed: docs.infra, discovery: { openapi: null, well_known: null, routes_found: 0, routes_checked: 0 }, routes: [] };
  const picked = routes.slice(0, SITE_MAX_ROUTES); // fan-out cap (each route = 2 unpaid probes)
  const results = await Promise.all(picked.map((r) => diagnose({ url: r }, { tier: 'route', fetchImpl, now }).catch((e) => ({ url: r, grade: 'F', score: 0, status: 'broken', counts: {}, fixes: [{ problem: String(e.message) }] }))));
  const sourcesFailed = results.filter((r) => r.status === 'incomplete').flatMap((r) => r.sources_failed || [{ source: 'route', url: r.url }]);
  const graded = results.filter((r) => r.status !== 'incomplete');
  if (picked.length && !graded.length) return { ...incompleteReport(input.url, 'site', undefined, sourcesFailed[0]?.reason || SELF_PROBE_UNAVAILABLE, now), tier: 'site', origin: u.origin, sources_failed: sourcesFailed, discovery: { openapi: docs.openapiUrl, well_known: docs.wellKnownUrl, routes_found: routes.length, routes_checked: picked.length }, routes: results.map((r) => ({ url: r.url, grade: r.grade, score: r.score, status: r.status, x402: r.x402, counts: r.counts, top_fixes: [] })) };
  const reached = results.some((r) => r.status !== 'broken');
  for (const r of results) if (r.status === 'broken') C.add('error', 'route_broken', 'routes', `${r.url}: ${r.summary || 'broken'}`, { fix: (r.fixes?.[0]?.fix) || 'Make the route answer 402.' });
  const avg = graded.length ? Math.round(graded.reduce((s, r) => s + (r.score || 0), 0) / graded.length) : 0;
  const own = grade(C.list, reached || !routes.length ? true : false);
  const score = Math.max(0, Math.min(own.score, graded.length ? avg : own.score) - (100 - own.score) * 0);
  const g = !routes.length ? 'F' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  return {
    url: input.url, tier: 'site', origin: u.origin, grade: g, score: routes.length ? score : 0, status: !routes.length ? 'broken' : results.some((r) => r.status === 'broken' || r.status === 'fix_needed') || own.counts.errors ? 'fix_needed' : results.some((r) => r.status === 'ok_with_warnings') || own.counts.warnings ? 'ok_with_warnings' : 'pass',
    summary: routes.length ? `${g} (${score}/100) across ${results.length} of ${routes.length} paid route(s); ${results.filter((r) => r.status === 'pass').length} pass, ${results.filter((r) => r.status === 'fix_needed' || r.status === 'broken').length} need fixes.` : 'No paid routes discoverable (no /.well-known/x402 or openapi.json x-payment-info).',
    discovery: { openapi: docs.openapiUrl, well_known: docs.wellKnownUrl, routes_found: routes.length, routes_checked: picked.length },
    routes: results.map((r) => ({ url: r.url, grade: r.grade, score: r.score, status: r.status, x402: r.x402, counts: r.counts, top_fixes: (r.fixes || []).slice(0, 3) })),
    fixes: fixesOf(C.list), checks: C.list,
    ...(sourcesFailed.length ? { sources_failed: sourcesFailed } : {}),
    missing_data: missing, limits: LIMITS, disclaimer: DISCLAIMER, engine: ENGINE_VERSION, checked_at: new Date(now).toISOString(),
  };
}
