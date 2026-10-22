// SignCheck: pre-sign safety check for agent wallets, paid per call over x402 (USDC on Base).
//   GET|POST /v1/check      PAID $0.015  verdict SAFE/CAUTION/DANGER + plain-English summary + every risk flag with reasons, decoded
//                                        args, counterparties (EOA vs contract, labels, OFAC SDN), token symbol/decimals, eth_call
//                                        simulation with revert reason, x402 payment-vs-402 match. Base, Ethereum, Base Sepolia.
//   GET|POST /v1/lite       PAID $0.005  same output without RPC: reasons, decoded args, counterparties, x402 match, OFAC SDN (offline)
//   GET|POST /v1/preview    free  offline decode: verdict, summary, flag codes (no on-chain facts or reasons), 10/min per IP
//   POST /mcp               free  remote MCP (Streamable HTTP, stateless JSON): check_signature (preview tier)
//   GET  /v1/stats  /health  /  /openapi.json  /.well-known/x402   free
// Inputs: tx {to,data,value,from}, typed_data (EIP-712), authorization (EIP-7702), or payment_required (+ payment_payload / typed_data).
// Inputs are validated before the 402, so malformed input is never charged; an RPC outage answers 503 (never settled).
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { x402ResourceServer } from '@x402/hono';
import { paymentMiddleware } from './credits-gate.js'; // @x402/hono paymentMiddleware + prepaid credits keys (no key: unchanged x402)
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { multiNetworkRoutes, registerNetworks, supportedKinds, discoveryNetworks, networkStats } from './networks.js';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { ROUTE_META } from './service-meta.js';
import { ResilientFacilitatorClient } from './facilitator.js';
import { selectFacilitator } from './facilitator-select.js';
import { DEFAULTS } from './config.js';
import { Stats, paidRouteStats, isSmoke, waitUntilOf } from './stats.js';
import { x402v1 } from './x402v1.js';
import { prefersHtml, landingHtml } from './landing.js';
import { openapiDoc, wellKnownX402, LOGO_SVG } from './discovery.js';
import { normalizeInput, checkSign, openchainLookup, InputError, UpstreamError, DISCLAIMER, ENGINE_VERSION, KNOWN_SELECTOR_COUNT } from './sign.js';
import { makeRpc, BASE_RPCS, ETH_RPCS, BASE_SEPOLIA_RPCS } from './rpc.js';
import { SDN_META } from './data/sdn-evm.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_INPUT, EXAMPLE_QUERY, CHECK_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const CHECK_PATH = '/v1/check';
export const PREVIEW_PATH = '/v1/preview';
export const LITE_PATH = '/v1/lite';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-signcheck/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/signcheck';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const CHECK_DESCRIPTION = 'Pre-sign safety check for agent wallets: send a transaction, EIP-712 typed data (Permit, Permit2, EIP-3009, Seaport), an EIP-7702 authorization, or an x402 402 + payment payload. Returns SAFE/CAUTION/DANGER, a plain-English summary and every risk flag (unlimited or EOA approvals, setApprovalForAll, fake USDC domains, x402 overpay, OFAC SDN) plus on-chain facts and eth_call simulation.';
export const LITE_DESCRIPTION = 'Offline pre-sign check (no RPC, fast): decodes a transaction, EIP-712 typed data (Permit, Permit2, EIP-3009), an EIP-7702 authorization or an x402 402 + payment payload and returns SAFE/CAUTION/DANGER, every risk flag with its reason, decoded args, counterparties, x402 payment-vs-402 match and OFAC SDN screening. Use /v1/check for on-chain facts and simulation.';
const FIELDS = {
  chain: { type: 'string', description: 'base (default), ethereum, base-sepolia or a chain id' },
  tx: { type: 'object', description: 'Transaction to send: {"to":"0x…","data":"0x…","value":"0","from":"0x…"} (from enables simulation)' },
  typed_data: { type: 'object', description: 'EIP-712 request {domain, types, primaryType, message} as passed to eth_signTypedData_v4' },
  authorization: { type: 'object', description: 'EIP-7702 authorization {address (delegate contract), chainId, nonce}' },
  payment_required: { type: ['object', 'string'], description: 'x402 402 terms: the PAYMENT-REQUIRED header (base64) or JSON {accepts:[…]}' },
  payment_payload: { type: ['object', 'string'], description: 'x402 payment you are about to send: PAYMENT-SIGNATURE / X-PAYMENT (base64) or JSON' },
};
const BODY_SCHEMA = { properties: FIELDS };
const QUERY_PROPS = { chain: FIELDS.chain, to: { type: 'string', description: 'tx.to' }, data: { type: 'string', description: 'tx.data (0x hex)' }, value: { type: 'string', description: 'tx.value in wei' }, from: { type: 'string', description: 'tx.from (enables simulation)' } };

export function routesConfig({ price, litePrice = DEFAULTS.litePrice, network, payTo, publicUrl }) {
  const out = { example: CHECK_EXAMPLE };
  const routes = {};
  for (const [path, p, description] of [[CHECK_PATH, price, CHECK_DESCRIPTION], [LITE_PATH, litePrice, LITE_DESCRIPTION]]) {
    const pub = publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: p, network, payTo, maxTimeoutSeconds: 120 }, description, mimeType: 'application/json', ...ROUTE_META };
    routes[`GET ${path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: EXAMPLE_QUERY, inputSchema: { properties: QUERY_PROPS, required: ['to'] }, output: out }) } };
    routes[`POST ${path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: EXAMPLE_INPUT, inputSchema: BODY_SCHEMA, output: out }) } };
  }
  return routes;
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400) => c.json({ error: 'bad_request', message }, status);
const atomic = (price) => String(Math.round(Number(String(price).replace('$', '')) * 1e6));
const RPCS = { 8453: BASE_RPCS, 1: ETH_RPCS, 84532: BASE_SEPOLIA_RPCS };

/** Turn GET query params into the JSON body shape. */
export function bodyFromQuery(q) {
  const b = {};
  const j = (k) => { const v = q[k]; if (v === undefined) return undefined; try { return JSON.parse(v); } catch { return v; } };
  if (q.chain) b.chain = q.chain;
  for (const k of ['typed_data', 'authorization', 'payment_required', 'payment_payload', 'tx']) if (q[k] !== undefined) b[k] = j(k);
  if (q.to !== undefined) b.tx = { to: q.to, data: q.data, value: q.value, from: q.from };
  return b;
}

/**
 * @param {object} [opts] payTo, price, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats, freeLimiter,
 *   v1FetchImpl, rpcFetch (tests: JSON-RPC + 4-byte lookups), staticSupported, syncFacilitatorOnStart, now (tests), cdpDeps
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const stats = opts.stats || new Stats(undefined);
  const fac = selectFacilitator(cfg, opts.cdpDeps);
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme); // extra networks from networks.js (Base registered above, unchanged)
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };
  const now = () => (opts.now ? opts.now() : Date.now());
  const netFetch = opts.rpcFetch || ((...a) => globalThis.fetch(...a));
  const rpcFor = (id) => (RPCS[id] ? makeRpc({ fetchImpl: netFetch, urls: RPCS[id], ms: 5000 }) : null);
  const lookupSelectors = (sels) => openchainLookup(sels, netFetch);
  const run = (input, tier) => withDeadline(checkSign(input, { tier, now: now(), rpcFor, lookupSelectors }), BUDGET.workMs - 1000, 'check');
  const fail = (c, e) => {
    if (e instanceof InputError) return bad(c, e.message, e.status || 400);
    console.warn(`signcheck: ${e?.message}`); c.header('Retry-After', '10');
    if (e instanceof UpstreamError) return c.json({ error: 'rpc_unavailable', message: `${e.message}. Not charged; please retry.` }, 503);
    return c.json({ error: 'upstream_unavailable', message: 'The chain RPC did not answer in time. Not charged; please retry.' }, 504);
  };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'SignCheck',
    description: 'Pre-sign safety check for AI agent wallets: decodes a transaction, an EIP-712 signature request (Permit, Permit2, EIP-3009, Seaport), an EIP-7702 delegation or an x402 payment into plain English and flags what can drain the wallet, with on-chain facts and simulation. Paid per call over x402; free preview and remote MCP.',
    paid: [{ methods: ['GET', 'POST'], path: CHECK_PATH, price: cfg.price, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'], returns: 'full: reasons, on-chain facts, eth_call simulation' }, { methods: ['GET', 'POST'], path: LITE_PATH, price: cfg.litePrice, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'], returns: 'offline: reasons, decoded args, counterparties, x402 match, OFAC SDN; no RPC' }],
    free: ['/health', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { methods: ['GET', 'POST'], path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'offline decode: verdict, summary and flag codes; no reasons, decoded args, on-chain facts (EOA vs contract, token metadata), simulation or x402 match details' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_signature'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    inputs: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.description])),
    chains: { onchain: ['base (8453)', 'ethereum (1)', 'base-sepolia (84532)'], decode_only: 'any other EVM chain id' },
    known_functions: KNOWN_SELECTOR_COUNT, sanctions: { list: SDN_META.source, list_date: SDN_META.publish_date, evm_addresses: SDN_META.evm_address_count }, engine: ENGINE_VERSION,
    policy: { network: 'paid tier: one batched JSON-RPC request to public RPCs (eth_getCode, token symbol/decimals, eth_call simulation) and, for unknown selectors, the public openchain 4-byte directory', storage: 'nothing is stored or logged', charging: 'only HTTP 200 results are settled; invalid input and RPC outages are free', signing: 'read-only: SignCheck never asks for keys or signatures and never sends transactions' },
    disclaimer: DISCLAIMER,
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true, engine: ENGINE_VERSION, sdn_list_date: SDN_META.publish_date }));
  const disc = (c) => ({ origin: origin(c), price: cfg.price, litePrice: cfg.litePrice, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  /** Read + validate the request (no network). { empty } = no input at all (discovery probe). */
  async function readInput(c) {
    let body;
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      if (!text.trim()) body = bodyFromQuery(c.req.query());
      else { try { body = JSON.parse(text); } catch { return { error: ['body must be JSON, e.g. {"tx": {"to": "0x…", "data": "0x…"}}'] }; } }
    } else body = bodyFromQuery(c.req.query());
    if (!body || (typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).filter((k) => k !== 'chain').length)) return { empty: true, error: ['nothing to check: send "tx", "typed_data", "authorization" or "payment_required" (see /openapi.json)'] };
    try { return { value: normalizeInput(body) }; } catch (e) { return { error: [e.message, e.status || 400] }; }
  }

  // ---- free preview ----
  const preview = async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}${CHECK_PATH} (x402, USDC on Base)` }, 429); }
    const p = await readInput(c);
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...r, full: { url: `${origin(c)}${CHECK_PATH}`, method: 'POST (same JSON body) or GET (same query)', price: `${cfg.price} USDC on Base (x402)`, lite: { url: `${origin(c)}${LITE_PATH}`, price: `${cfg.litePrice} USDC`, adds: 'every reason, decoded args, counterparties and x402 match details, offline (no on-chain facts or simulation)' }, adds: 'the reason behind every flag, decoded arguments, counterparties (EOA vs contract, labels, OFAC SDN entity), token symbol/decimals and human amounts, eth_call simulation with revert reason, x402 payment-vs-402 match details, 4-byte name of unknown functions' } });
  };
  app.get(PREVIEW_PATH, preview); app.post(PREVIEW_PATH, preview);

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'check_signature', title: 'Is it safe to sign this?', description: `Call BEFORE your agent signs or sends anything from a wallet. Decodes a transaction, an EIP-712 typed-data request (Permit, Permit2, EIP-3009 USDC authorizations, Seaport orders), an EIP-7702 delegation or an x402 payment (402 terms + payload) into plain English and returns SAFE / CAUTION / DANGER with risk flags (unlimited approvals, setApprovalForAll, fake USDC domains, x402 overpay or wrong payTo, OFAC SDN counterparties). Free preview tier (offline). The paid x402 endpoint ${CHECK_PATH} adds reasons, on-chain facts (spender is a wallet or contract, token metadata) and an eth_call simulation.`, inputSchema: { type: 'object', properties: FIELDS }, annotations: RO },
  ];
  app.get(MCP_PATH, (c) => c.json({ error: 'method_not_allowed', message: 'POST JSON-RPC (MCP Streamable HTTP, stateless).' }, 405, { Allow: 'POST' }));
  app.post(MCP_PATH, async (c) => {
    let msg; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const batch = Array.isArray(msg); const replies = [];
    for (const m of (batch ? msg : [msg]).slice(0, 10)) { const r = await rpc(m, c); if (r) replies.push(r); }
    if (!replies.length) return c.body(null, 202);
    return c.json(batch ? replies : replies[0]);
  });
  async function rpc(m, c) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const note = m.id === undefined || m.id === null;
    const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
    const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
    switch (m.method) {
      case 'initialize': {
        const v = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'signcheck', title: 'SignCheck', version: VERSION }, instructions: 'Before signing or sending anything from a wallet, call check_signature with the transaction (tx), the EIP-712 typed_data, an EIP-7702 authorization, or the x402 payment_required (+ payment_payload). Do not sign on DANGER; ask a human on CAUTION.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${CHECK_PATH}`); }
        let input; try { input = normalizeInput(m.params?.arguments || {}); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(input, 'preview'); } catch (e) { return err(`${e?.code || 'error'}: ${e?.message || e}`); }
        count(c, 'free_mcp');
        const text = `SignCheck ${r.verdict} (risk ${r.risk_score}/100): ${r.summary}.\n${r.flags.length ? 'Flags: ' + r.flags.map((f) => `${f.code} [${f.severity}]`).join(', ') : 'No risk flags from the offline check.'}\nReasons, on-chain facts (is the spender a wallet or a contract?) and simulation: POST ${origin(c)}${CHECK_PATH} with the same arguments (${cfg.price} USDC, x402).\n${DISCLAIMER}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: r, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid route ----
  app.use(CHECK_PATH, paidRouteStats(stats, 'check'));
  app.use(LITE_PATH, paidRouteStats(stats, 'lite'));
  const mkV1 = (path, price, description) => x402v1({
    path, amount: atomic(price), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
    description, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
    outputSchema: { input: { type: 'http', method: 'POST', bodyType: 'json', discoverable: true, bodyFields: FIELDS }, output: CHECK_EXAMPLE },
  });
  const v1 = mkV1(CHECK_PATH, cfg.price, CHECK_DESCRIPTION);
  const v1lite = mkV1(LITE_PATH, cfg.litePrice, LITE_DESCRIPTION);
  // Validate before payment: bad input gets a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
  const validate = async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
    const p = await readInput(c);
    if (p.empty) return next(); // bare URL: answer with the 402 terms; the handler 400s (never settled) if paid without input
    if (p.error) return bad(c, ...p.error);
    c.set('input', p.value);
    return next();
  };
  app.use(CHECK_PATH, validate); app.use(LITE_PATH, validate);
  app.use(v1.middleware); app.use(v1lite.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  app.on(['GET', 'POST'], CHECK_PATH, async (c) => {
    const input = c.get('input');
    if (!input) return bad(c, 'nothing to check: send "tx", "typed_data", "authorization" or "payment_required" (see /openapi.json)');
    let r; try { r = await run(input, 'full'); } catch (e) { return fail(c, e); } // >= 400 is never settled
    return c.json(r);
  });
  app.on(['GET', 'POST'], LITE_PATH, async (c) => {
    const input = c.get('input');
    if (!input) return bad(c, 'nothing to check: send "tx", "typed_data", "authorization" or "payment_required" (see /openapi.json)');
    let r; try { r = await run(input, 'lite'); } catch (e) { return fail(c, e); }
    return c.json(r);
  });
  return app;
}
