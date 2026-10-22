// PayGuard: OFAC SDN sanctions screening of crypto addresses for AI agents. Paid per call over x402 (USDC on Base).
//   GET|POST /v1/address?address=   PAID $0.001  sanctioned true/false, SDN matches (entity, programs, list date), chain guess, checksum
//   POST     /v1/batch {addresses}  PAID $0.01   up to 50 addresses in one call
//   GET|POST /v1/preview            free  sanctioned true/false + chain guess (no entity details), 10/min per IP
//   POST /mcp                       free  remote MCP (Streamable HTTP, stateless JSON): screen_address (preview tier)
//   GET  /v1/list  /v1/stats  /health  /  /openapi.json  /.well-known/x402   free
// The list is a bundled snapshot of the official OFAC SDN list (src/data/sdn.js, rebuilt by scripts/refresh.sh), so
// screening makes no network calls at all; only verify/settle talk to the facilitator.
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
import { screenAddress, previewAddress, screenBatch, invalidInput, LIST, DISCLAIMER, ENGINE_VERSION, MAX_BATCH } from './screen.js';
import { SANCTIONED_EXAMPLE, BATCH_EXAMPLE, SANCTIONED_ADDRESS, CLEAN_ADDRESS } from './examples.js';
import { VERSION_STR } from './version.js';
import { mountSolanaDevnet, solanaDevnetInfo, SOLANA_DEVNET_DEFAULTS } from './solana-devnet.js';
import { mountStellarTestnet, stellarTestnetInfo } from './stellar-testnet.js';
import { mountGoatTestnet3, goatTestnet3Info } from './goat-testnet3.js';

export const ADDRESS_PATH = '/v1/address';
export const BATCH_PATH = '/v1/batch';
export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const LIST_PATH = '/v1/list';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-payguard/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/payguard';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const ADDRESS_DESCRIPTION = `Sanctions screen for one crypto address, for agents and apps that send payments: exact match against all ${LIST.address_count} digital currency addresses in the official US Treasury OFAC SDN list (EVM case-insensitive). Returns sanctioned true/false, matching SDN entity, programs and list date, a chain guess and checksum validity, plus the list date. Informational, not legal advice.`;
export const BATCH_DESCRIPTION = `Sanctions screen for up to ${MAX_BATCH} crypto addresses in one call against the official US Treasury OFAC SDN digital currency address list: per-address sanctioned true/false with SDN entity, programs and list date, chain guess and checksum. Informational, not legal advice.`;
const ADDRESS_Q = { properties: { address: { type: 'string', description: 'Blockchain address, e.g. "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" (EVM, BTC, TRX, SOL, LTC, XMR and more)' } }, required: ['address'] };
const BATCH_Q = { properties: { addresses: { type: 'array', items: { type: 'string' }, description: `1-${MAX_BATCH} blockchain addresses` } }, required: ['addresses'] };

export function routesConfig({ priceAddress, priceBatch, network, payTo, publicUrl }) {
  const pub = (path) => (publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${path}` } : {});
  const acc = (price) => ({ scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 });
  const a = { ...pub(ADDRESS_PATH), accepts: acc(priceAddress), description: ADDRESS_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  const b = { ...pub(BATCH_PATH), accepts: acc(priceBatch), description: BATCH_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  return {
    [`GET ${ADDRESS_PATH}`]: { ...a, extensions: { ...declareDiscoveryExtension({ input: { address: SANCTIONED_ADDRESS }, inputSchema: ADDRESS_Q, output: { example: SANCTIONED_EXAMPLE } }) } },
    [`POST ${ADDRESS_PATH}`]: { ...a, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { address: SANCTIONED_ADDRESS }, inputSchema: ADDRESS_Q, output: { example: SANCTIONED_EXAMPLE } }) } },
    [`POST ${BATCH_PATH}`]: { ...b, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { addresses: [SANCTIONED_ADDRESS, CLEAN_ADDRESS] }, inputSchema: BATCH_Q, output: { example: BATCH_EXAMPLE } }) } },
  };
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400) => c.json({ error: 'bad_request', message }, status);
const atomic = (price) => String(Math.round(Number(String(price).replace('$', '')) * 1e6));

/**
 * @param {object} [opts] payTo, priceAddress, priceBatch, network, facilitatorUrl, publicUrl, facilitatorClient (tests),
 *   statsKv, stats, freeLimiter, v1FetchImpl, staticSupported, syncFacilitatorOnStart, now (tests), cdpDeps
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const stats = opts.stats || new Stats(opts.statsKv);
  const fac = selectFacilitator(cfg, opts.cdpDeps); // FACILITATOR=payai|cdp; cdp without keys falls back to PayAI
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme); // extra networks from networks.js (Base registered above, unchanged)
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };
  const now = () => (opts.now ? opts.now() : Date.now());
  const solCfg = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k.startsWith('solanaDevnet') && v !== undefined));
  const xlmCfg = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k.startsWith('stellarTestnet') && v !== undefined));
  const goatCfg = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k.startsWith('goatTestnet3') && v !== undefined && typeof v !== 'function'));

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'PayGuard',
    description: 'Sanctions screening of crypto addresses for AI agents: reports whether an address appears in the US Treasury OFAC SDN list, with the matching entity, programs and list date. Paid per call over x402; free preview and remote MCP.',
    paid: [
      { methods: ['GET', 'POST'], path: ADDRESS_PATH, param: 'address', price: cfg.priceAddress, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
      { methods: ['POST'], path: BATCH_PATH, param: 'addresses', max: MAX_BATCH, price: cfg.priceBatch, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
    ],
    testnet: [solanaDevnetInfo({ ...SOLANA_DEVNET_DEFAULTS, ...solCfg }, origin(c)), stellarTestnetInfo(xlmCfg, origin(c)), goatTestnet3Info(goatCfg, origin(c))],
    free: ['/health', PREVIEW_PATH, MCP_PATH, LIST_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { methods: ['GET', 'POST'], path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'sanctioned true/false, match count and chain guess (no entity, program, list date or checksum details)' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['screen_address'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    data: { list: LIST.source, source_url: LIST.source_url, list_updated_at: LIST.list_updated_at, sdn_address_count: LIST.address_count, sdn_entities_with_addresses: LIST.entity_count, by_currency: LIST.by_currency, refresh: 'daily rebuild from the official Treasury file; unchanged lists are not redeployed', engine: ENGINE_VERSION },
    policy: { storage: 'inputs are not stored or logged', charging: 'only HTTP 200 results are settled; invalid input is free', network: 'screening is an in-memory lookup; no third-party calls' },
    disclaimer: DISCLAIMER,
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true, list_updated_at: LIST.list_updated_at, sdn_address_count: LIST.address_count }));
  const disc = (c) => ({ origin: origin(c), priceAddress: cfg.priceAddress, priceBatch: cfg.priceBatch, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });
  app.get(LIST_PATH, (c) => { c.header('Cache-Control', 'public, max-age=3600'); return c.json({ ...LIST, list_age_days: Math.floor((now() - Date.parse(`${LIST.list_updated_at}T00:00:00Z`)) / 86400000), matching: 'exact; 0x-hex EVM and bech32 / cashaddr are case-insensitive, base58 formats (BTC legacy, TRX, SOL, LTC ...) are exact', disclaimer: DISCLAIMER, engine: ENGINE_VERSION }); });

  // ---- input parsing ----
  async function readBody(c, name) {
    const len = Number(c.req.header('content-length') || 0);
    if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
    const raw = await c.req.text(); // cached by Hono, safe to read again
    if (raw.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
    if (!raw.trim()) return { empty: true, error: [`"${name}" is required`] };
    let body;
    if ((c.req.header('content-type') || '').includes('application/json') || /^\s*[{[]/.test(raw)) {
      try { body = JSON.parse(raw); } catch { return { error: [`body must be JSON: {"${name}": ...}`] }; }
    } else body = { [name]: raw.trim() };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: ['body must be a JSON object'] };
    return { body };
  }
  async function readAddress(c) {
    if (c.req.method === 'POST') {
      const p = await readBody(c, 'address'); if (p.error) return p;
      const v = p.body.address;
      // An empty JSON object ({}) is a discovery probe, same as a bare URL: answer with the 402 terms.
      if (v === undefined && !Object.keys(p.body).length) return { empty: true, error: ['"address" (string) is required'] };
      if (typeof v !== 'string' || !v.trim()) return { error: ['"address" (string) is required'] };
      return { value: v.trim() };
    }
    const v = c.req.query('address');
    if (v === undefined) return { empty: true, error: ['?address= is required'] };
    if (!v.trim()) return { error: ['?address= is required'] };
    return { value: v.trim() };
  }
  async function readBatch(c) {
    if (c.req.method !== 'POST') return { error: ['POST a JSON body {"addresses": ["0x...", ...]}', 405] };
    const p = await readBody(c, 'addresses'); if (p.error) return p;
    const v = p.body.addresses;
    if (v === undefined && !Object.keys(p.body).length) return { empty: true, error: ['"addresses" must be a non-empty array of strings'] };
    if (!Array.isArray(v) || !v.length) return { error: ['"addresses" must be a non-empty array of strings'] };
    if (v.length > MAX_BATCH) return { error: [`at most ${MAX_BATCH} addresses per batch`] };
    for (const [i, a] of v.entries()) { const e = invalidInput(a); if (e) return { error: [`addresses[${i}]: ${e}`] }; }
    return { value: v.map((a) => a.trim()) };
  }

  // ---- free preview ----
  const preview = async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}${ADDRESS_PATH} (x402, USDC on Base)` }, 429); }
    const p = await readAddress(c);
    if (p.error) return bad(c, ...p.error);
    const r = previewAddress(p.value, { now: now() });
    if (r.error) return bad(c, r.message);
    count(c, 'free_preview');
    return c.json({ ...r, full: { url: `${origin(c)}${ADDRESS_PATH}`, price: `${cfg.priceAddress} USDC on Base (x402)`, adds: 'SDN entity name and type, sanctions programs, list date, listed currency, checksum validation and chain candidates' } });
  };
  app.get(PREVIEW_PATH, preview); app.post(PREVIEW_PATH, preview);

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const TOOLS = [
    { name: 'screen_address', title: 'OFAC SDN screen of a crypto address', description: 'Reports whether a crypto address (EVM, BTC, TRX, SOL, LTC, XMR and more) appears in the US Treasury OFAC SDN list of digital currency addresses, with a chain guess. Free preview tier; the paid x402 endpoint /v1/address adds the SDN entity, programs, list date and checksum validation. Informational screening, not legal advice.', inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'Blockchain address' } }, required: ['address'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  ];
  app.get(MCP_PATH, (c) => c.json({ error: 'method_not_allowed', message: 'POST JSON-RPC (MCP Streamable HTTP, stateless).' }, 405, { Allow: 'POST' }));
  app.post(MCP_PATH, async (c) => {
    let msg; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const batch = Array.isArray(msg); const replies = [];
    for (const m of batch ? msg : [msg]) { const r = await rpc(m, c); if (r) replies.push(r); }
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'payguard', title: 'PayGuard', version: VERSION }, instructions: 'screen_address reports whether a crypto address appears in the OFAC SDN list of digital currency addresses. Informational screening, not legal advice.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (name !== 'screen_address') return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${ADDRESS_PATH}`); }
        const value = m.params?.arguments?.address;
        const r = previewAddress(value, { now: now() });
        if (r.error) return err(`bad_request: ${r.message}`);
        count(c, 'free_mcp');
        const text = `PayGuard ${r.address}: ${r.sanctioned ? `SANCTIONED (${r.match_count} OFAC SDN match${r.match_count > 1 ? 'es' : ''})` : 'no OFAC SDN match'}; chain guess ${r.chain.guess}; list ${r.list_updated_at}.\nSDN entity, programs, list date and checksum: ${origin(c)}${ADDRESS_PATH} (${cfg.priceAddress} USDC, x402).\n${DISCLAIMER}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: r, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid routes ----
  const routes = [
    { path: ADDRESS_PATH, kind: 'address', price: cfg.priceAddress, description: ADDRESS_DESCRIPTION, read: readAddress,
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { address: { type: 'string', required: true, description: ADDRESS_Q.properties.address.description } } }, output: SANCTIONED_EXAMPLE } },
    { path: BATCH_PATH, kind: 'batch', price: cfg.priceBatch, description: BATCH_DESCRIPTION, read: readBatch,
      outputSchema: { input: { type: 'http', method: 'POST', discoverable: true, bodyType: 'json', bodyFields: { addresses: { type: 'array', required: true, description: BATCH_Q.properties.addresses.description } } }, output: BATCH_EXAMPLE } },
  ];
  const v1s = [];
  for (const r of routes) {
    app.use(r.path, paidRouteStats(stats, r.kind));
    v1s.push(x402v1({
      path: r.path, amount: atomic(r.price), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
      description: r.description, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl, outputSchema: r.outputSchema,
    }));
    // Validate before payment: malformed requests get a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      if (r.kind === 'batch' && c.req.method === 'GET') return c.json({ error: 'method_not_allowed', message: 'POST a JSON body {"addresses": ["0x...", ...]}' }, 405, { Allow: 'POST' });
      const p = await r.read(c);
      if (p.empty) return next(); // bare URL: answer with the 402 terms; the handler 400s (never settled) if paid without input
      if (p.error) return bad(c, ...p.error);
      if (r.kind === 'address') { const e = invalidInput(p.value); if (e) return bad(c, e); }
      c.set('screenInput', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  app.on(['GET', 'POST'], ADDRESS_PATH, (c) => {
    const v = c.get('screenInput');
    if (!v) return bad(c, 'provide "address" (GET ?address= or POST JSON {"address": "..."})');
    const r = screenAddress(v, { now: now() });
    if (r.error) return bad(c, r.message); // >= 400 is never settled
    return c.json(r);
  });
  // ---- Testnet routes: Solana devnet + Stellar testnet (x402.org facilitator) + GOAT Testnet3 (own facilitator) (separate x402 servers; Base terms above unchanged) ----
  const testnetRoute = (network) => ({
    syncFacilitatorOnStart: opts.syncFacilitatorOnStart,
    validate: async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readAddress(c);
      if (p.empty) return next();
      if (p.error) return bad(c, ...p.error);
      const e = invalidInput(p.value); if (e) return bad(c, e);
      c.set('screenInput', p.value);
      return next();
    },
    handler: (c) => {
      const v = c.get('screenInput');
      if (!v) return bad(c, 'provide "address" (GET ?address= or POST JSON {"address": "..."})');
      const r = screenAddress(v, { now: now() });
      if (r.error) return bad(c, r.message);
      return c.json({ ...r, payment: { network, testnet: true } });
    },
  });
  mountSolanaDevnet(app, cfg, { ...testnetRoute('solana-devnet'), facilitatorClient: opts.solanaDevnetFacilitatorClient });
  mountStellarTestnet(app, cfg, { ...testnetRoute('stellar:testnet'), facilitatorClient: opts.stellarTestnetFacilitatorClient });
  mountGoatTestnet3(app, cfg, { ...testnetRoute('eip155:48816'), facilitatorClient: opts.goatTestnet3FacilitatorClient });
  app.post(BATCH_PATH, (c) => {
    const v = c.get('screenInput');
    if (!v) return bad(c, 'provide "addresses" (POST JSON {"addresses": ["0x...", ...]})');
    const r = screenBatch(v, { now: now() });
    if (r.error) return bad(c, r.message);
    return c.json(r);
  });
  return app;
}
