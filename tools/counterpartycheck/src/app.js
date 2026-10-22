// CounterpartyCheck: pre-payment due diligence for agents, paid per call over x402 (USDC on Base, Polygon, Arbitrum One or Solana).
// Before paying, approving or interacting with an address, one call returns ok / caution / block with reasons and a confidence.
//   GET|POST /v1/lite?address=   PAID $0.005  OFAC SDN + ScamSniffer + x402 directory + labels + one on-chain read (kind, activity, token/Safe)
//   GET|POST /v1/quick?address=  PAID $0.015  lite + Sourcify verification and deployer, ENS / Basename, cross-chain presence, explorer labels
//   GET|POST /v1/full?address=   PAID $0.05   quick + age, recent activity and exposure to listed addresses, recent approvals, TokenVerdict
//   GET  /v1/preview?address=    free  verdict, confidence and flag counts (no reasons), 10/min per IP
//   POST /mcp                    free  remote MCP (Streamable HTTP, stateless JSON): check_counterparty (preview tier)
//   GET  /health  /  /openapi.json  /.well-known/x402  /v1/stats   free
// Inputs: address (EVM 0x... or Solana base58), chain (base | ethereum | polygon | arbitrum | solana; base58 implies solana), intent
// (pay | approve | interact, default pay). Inputs are validated before the 402 (malformed = 400, never charged); a chain RPC outage
// answers 503 after verification (>= 400 is never settled). Optional sources degrade into missing_data + a lower confidence.
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
import { checkCounterparty, normalizeInput, previewView, InputError, UpstreamError, DISCLAIMER, LIMITS, ENGINE_VERSION, CHAINS } from './counterparty.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_ADDRESS, LITE_EXAMPLE, QUICK_EXAMPLE, FULL_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';
import { SCAM_META } from './data/scamsniffer.js';
import { X402_META } from './data/x402-payees.js';
import { LIST } from './screen.js';

export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-counterpartycheck/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/counterpartycheck';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const DESC = {
  lite: 'Pre-payment counterparty check for agents: before paying or approving an EVM (Base, Ethereum, Polygon, Arbitrum) or Solana address, get ok / caution / block with reasons. Screens OFAC SDN and ScamSniffer scam lists, x402 Bazaar payee directory and known labels, and reads the address on-chain (wallet, contract, token contract, Safe, EIP-7702 delegation, activity, USDC balance).',
  quick: 'Counterparty due-diligence report: everything in lite plus contract verification and deployer screening (Sourcify), ENS and Basename (forward-verified), cross-chain presence (wrong-chain protection for smart wallets and Safes), Safe owner and contract owner screening and explorer labels. Verdict ok / caution / block with reasons and confidence.',
  full: 'Full counterparty due diligence before an agent pays or interacts: quick plus age (first transaction or creation block), recent activity and direct exposure to sanctioned or scam-listed addresses, recent token approvals to the address (drainer pattern) and TokenVerdict for Base tokens; Solana adds history depth. Verdict ok / caution / block with reasons, confidence and missing_data.',
};
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', example: LITE_EXAMPLE, returns: 'Verdict, reasons, lists, address type and activity.' },
  { tier: 'quick', path: '/v1/quick', key: 'priceQuick', example: QUICK_EXAMPLE, returns: 'Lite + verification, deployer, names, cross-chain, owners, labels.' },
  { tier: 'full', path: '/v1/full', key: 'priceFull', example: FULL_EXAMPLE, returns: 'Quick + age, recent activity and exposure, approvals, TokenVerdict.' },
];
export const PROPS = {
  address: { type: 'string', description: 'Counterparty address: EVM 0x + 40 hex, or a Solana base58 address' },
  chain: { type: 'string', enum: ['base', 'ethereum', 'polygon', 'arbitrum', 'solana'], description: 'Chain of the payment (default base; a base58 address implies solana)' },
  intent: { type: 'string', enum: ['pay', 'approve', 'interact'], description: 'What you are about to do (default pay): changes which signals matter, e.g. paying a token contract or approving an EOA' },
};
const Q = { properties: PROPS, required: ['address'] };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: DESC[r.tier], mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.example };
    const input = { address: EXAMPLE_ADDRESS, chain: 'base', intent: 'pay' };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input, inputSchema: Q, output }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input, inputSchema: Q, output }) } };
  }
  return out;
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400) => c.json({ error: 'bad_request', message }, status);
const atomic = (price) => String(Math.round(Number(String(price).replace('$', '')) * 1e6));
const usd = (price) => String(price).replace(/^\$/, '');

/**
 * @param {object} [opts] payTo, priceLite/priceQuick/priceFull, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats,
 *   freeLimiter, v1FetchImpl, dataFetch (tests: RPC + HTTP sources), check (tests: stub engine), tokenVerdict (TokenVerdict preview
 *   client), staticSupported, syncFacilitatorOnStart, now, cdpDeps
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
  const engine = opts.check || checkCounterparty;
  const dataFetch = opts.dataFetch || ((...a) => globalThis.fetch(...a));
  // Short per-isolate cache: preview reuses a result for 2 min, lite/quick for 30 s; full is always fresh.
  const cache = new Map();
  const run = async (input, tier) => {
    const ttl = tier === 'full' ? 0 : tier === 'preview' ? 120000 : 30000;
    const k = `${tier}:${input.chain}:${input.intent}:${input.address}`;
    const hit = cache.get(k);
    if (ttl && hit && now() - hit.at < ttl) return hit.r;
    const r = await withDeadline(engine(input, { tier, fetchImpl: dataFetch, now: now(), tokenVerdict: opts.tokenVerdict }), BUDGET.workMs + 5000, 'counterparty check');
    if (ttl && r.confidence !== 'low') { cache.set(k, { at: now(), r }); if (cache.size > 300) cache.delete(cache.keys().next().value); }
    return r;
  };
  const fail = (c, e) => {
    if (e instanceof InputError) return c.json({ error: e.code, message: e.message }, e.status);
    console.warn(`counterpartycheck: ${e?.message}`); c.header('Retry-After', '10');
    if (e instanceof UpstreamError) return c.json({ error: 'rpc_unavailable', message: `${e.message}. Not charged; please retry.` }, 503);
    return c.json({ error: 'upstream_unavailable', message: 'Data sources did not answer in time. Not charged; please retry.' }, 503);
  };
  const prices = { lite: `$${usd(cfg.priceLite)}`, quick: `$${usd(cfg.priceQuick)}`, full: `$${usd(cfg.priceFull)}` };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'CounterpartyCheck',
    description: 'Pre-payment due diligence for AI agents: before paying, approving or interacting with an address on Base, Ethereum, Polygon, Arbitrum One or Solana, get one decision (ok / caution / block) with reasons and a confidence. Composes OFAC SDN and ScamSniffer screening, x402 Bazaar payee directory, contract vs wallet, verification and deployer, ENS / Basename, cross-chain presence, age, recent activity and exposure, approvals and TokenVerdict. Paid per call over x402; free preview and remote MCP.',
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, params: ['address', 'chain', 'intent'], price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'verdict, confidence, address kind, flag counts and x402-payee flag; no reasons' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_counterparty'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    chains: Object.values(CHAINS).map((x) => ({ chain: x.key, id: x.caip2 })), intents: ['pay', 'approve', 'interact'], engine: ENGINE_VERSION,
    data: { sanctions: { source: LIST.source, list_updated_at: LIST.list_updated_at, addresses: LIST.address_count }, scam_list: SCAM_META, x402_directory: X402_META },
    policy: { data: 'free public sources only: bundled OFAC SDN and ScamSniffer snapshots, a CDP x402 Bazaar catalog snapshot, public RPCs (read-only calls), Sourcify, Blockscout public API, TokenVerdict', storage: 'results cached in memory for up to 2 minutes; nothing is logged per address', charging: 'only HTTP 200 results are settled; invalid input, chain RPC outages and incomplete required checks (503, provisional verdict never ok) are free' },
    limits: LIMITS, disclaimer: DISCLAIMER,
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', async (c) => {
    if (c.req.query('sources') !== '1') return c.json({ ok: true, engine: ENGINE_VERSION });
    if (await limited(opts.freeLimiter, c)) return c.json({ error: 'rate_limited' }, 429);
    // Data-source reachability from this Worker (status codes only)
    const probe = async (name, url, init) => { const t0 = Date.now(); try { const r = await withDeadline(dataFetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': 'CounterpartyCheck/0.1 (+https://api.youraitools.co/counterpartycheck)', ...(init?.headers || {}) } }), 6000, name); const t = await r.text(); return [name, { status: r.status, ms: Date.now() - t0, ...(init?.body ? { rpc_error: /"error"/.test(t) ? t.slice(0, 80) : undefined } : {}) }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
    const rpcBody = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0x100000'] }) };
    const list = [];
    for (const k of ['base', 'ethereum', 'polygon', 'arbitrum']) {
      for (const u of CHAINS[k].rpcs) list.push(probe(`rpc_${k}_${new URL(u).host}`, u, { ...rpcBody, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }));
      for (const u of CHAINS[k].archive) list.push(probe(`archive_${k}_${new URL(u).host}`, u, rpcBody));
      list.push(probe(`blockscout_${k}`, `${CHAINS[k].blockscout}/api/v2/addresses/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`));
    }
    for (const u of CHAINS.solana.rpcs) list.push(probe(`rpc_solana_${new URL(u).host}`, u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }) }));
    list.push(probe('sourcify', 'https://sourcify.dev/server/v2/contract/8453/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'));
    return c.json({ ok: true, engine: ENGINE_VERSION, sources: Object.fromEntries(await Promise.all(list)) });
  });
  const disc = (c) => ({ origin: origin(c), cfg, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  /** Read { address, chain, intent } from the query or a JSON / text body. { empty } = no input at all (discovery probe). */
  async function readInput(c) {
    let raw;
    const q = () => ({ address: c.req.query('address') ?? c.req.query('counterparty'), chain: c.req.query('chain'), intent: c.req.query('intent') });
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"address": "0x..."}`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"address": "0x..."}`, 413] };
      if (!text.trim()) raw = q();
      else if (/^\s*[{[]/.test(text)) {
        let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"address": "0x...", "chain": "base", "intent": "pay"}'] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object {"address": "0x..."}'] };
        if (!Object.keys(b).length) return { empty: true };
        raw = b;
      } else raw = { ...q(), address: text.trim() };
    } else raw = q();
    const addr = raw.address ?? raw.counterparty ?? raw.wallet;
    if (addr === undefined || addr === null || addr === '') return Object.keys(raw).some((k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '') ? { error: ['"address" is required, e.g. ?address=0x...&chain=base'] } : { empty: true };
    try { return { value: normalizeInput(raw) }; } catch (e) { return { error: [e.message, e.status || 400] }; }
  }

  // ---- free preview ----
  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/lite (x402, USDC)` }, 429); }
    const p = await readInput(c);
    if (p.empty) { count(c, 'bad_request'); return bad(c, '"address" is required, e.g. ?address=0x...&chain=base'); }
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    const qs = `address=${encodeURIComponent(r.address || r.name)}&chain=${r.chain}&intent=${r.intent}`;
    return c.json({ ...previewView(r), full: { lite: `${origin(c)}/v1/lite?${qs}`, quick: `${origin(c)}/v1/quick?${qs}`, full: `${origin(c)}/v1/full?${qs}`, prices, adds: 'reasons and list matches (lite); verification, deployer, names, cross-chain, owners (quick); age, activity and exposure, approvals, TokenVerdict (full)' } });
  });

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'check_counterparty', title: 'Is it safe to pay this address?', description: `Pre-payment counterparty check: before paying, approving or interacting with an EVM (Base, Ethereum, Polygon, Arbitrum One) or Solana address, get ok / caution / block. Free preview tier: verdict, confidence, address kind and flag counts. The paid x402 endpoints /v1/lite (${prices.lite}), /v1/quick (${prices.quick}) and /v1/full (${prices.full}) add the reasons and evidence (OFAC SDN, scam lists, x402 directory, verification, deployer, names, cross-chain, age, exposure). Informational safety check, not legal or financial advice.`, inputSchema: { type: 'object', properties: PROPS, required: ['address'] }, annotations: RO },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'counterpartycheck', title: 'CounterpartyCheck', version: VERSION }, instructions: 'Call check_counterparty with the address (and chain, intent) before your agent pays, approves or interacts with it. Returns ok / caution / block; reasons and evidence are on the paid x402 routes.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/lite`); }
        let input; try { input = normalizeInput(m.params?.arguments || {}); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(input, 'preview'); } catch (e) { return err(`${e?.code || 'upstream_unavailable'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const v = previewView(r);
        const qs = `address=${encodeURIComponent(r.address || r.name)}&chain=${r.chain}&intent=${r.intent}`;
        const text = `CounterpartyCheck ${r.name ? `${r.name} -> ` : ''}${r.address || '(unresolved)'} (${r.chain}, intent ${r.intent}): ${v.verdict.toUpperCase()}, confidence ${v.confidence}. Kind: ${v.kind.replace(/_/g, ' ')}. Blocking signals: ${v.flags.danger}, cautions: ${v.flags.warn}, positive signals: ${v.flags.good}${v.signals.length ? ` (${v.signals.join(', ')})` : ''}.${v.sources_failed.length ? ` Checks that did not complete: ${v.sources_failed.join(', ')} (verdict is not final; retry).` : ''} Known x402 payee: ${v.x402_payee ? 'yes' : 'no'}.\nReasons and evidence: ${origin(c)}/v1/lite?${qs} (${prices.lite}), /v1/quick (${prices.quick}) or /v1/full (${prices.full}), x402 USDC.\n${DISCLAIMER}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: v, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid routes ----
  const v1s = [];
  for (const r of ROUTES) {
    app.use(r.path, paidRouteStats(stats, r.tier));
    v1s.push(x402v1({
      path: r.path, amount: atomic(cfg[r.key]), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
      description: DESC[r.tier], mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { address: { type: 'string', required: true, description: PROPS.address.description }, chain: { type: 'string', required: false, description: PROPS.chain.description }, intent: { type: 'string', required: false, description: PROPS.intent.description } } }, output: r.example },
    }));
    // Validate before payment: malformed input gets a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readInput(c);
      if (p.empty) return next();
      if (p.error) return bad(c, ...p.error);
      c.set('cp', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of ROUTES) {
    app.on(['GET', 'POST'], r.path, async (c) => {
      const input = c.get('cp');
      if (!input) return bad(c, 'provide "address" (GET ?address=0x...&chain=base&intent=pay or POST {"address": "0x..."})');
      let res; try { res = await run(input, r.tier); } catch (e) { return fail(c, e); } // >= 400 is never settled
      // Fail closed: a required check that did not complete is never sold as a result. 503 (not settled, not charged), with the
      // provisional verdict (caution or block, never ok) and sources_failed in the body so the caller can still act on it.
      if (res.sources_failed?.length) { c.header('Retry-After', '10'); return c.json({ error: 'checks_incomplete', message: `Required check(s) did not complete: ${res.sources_failed.join(', ')}. Not charged; please retry. Provisional verdict: ${res.verdict} (never ok while checks are incomplete).`, sources_failed: res.sources_failed, provisional: res }, 503); }
      return c.json(res);
    });
  }
  return app;
}
