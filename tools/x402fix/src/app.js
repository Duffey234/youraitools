// x402fix: an x402 endpoint doctor for sellers, paid per call over x402 (USDC on Base, Polygon, Arbitrum One or Solana).
// Give it the URL of a paid route; it probes it unpaid (GET / HEAD / empty POST / POST {} / CORS preflight, never pays) and
// returns a graded check list with paste-ready fixes.
//   GET|POST /v1/lite?url=    PAID $0.005  transport + x402 v2 header + v1 body + accepts (asset, EIP-712 domain, feePayer, amount
//                                          units, payTo) + multichain consistency + Bazaar declaration (schema-validated) + fix list
//   GET|POST /v1/check?url=   PAID $0.02   lite + CDP's own validate verdict and Bazaar index status, /openapi.json and
//                                          /.well-known/x402 consistency, payee checks (EVM code, Solana USDC token account,
//                                          CounterpartyCheck screening) + generated extensions.bazaar block, accepts and snippet
//   GET|POST /v1/site?url=    PAID $0.05   one origin: paid routes from its discovery docs (up to 8), lite checks on each, doc drift
//   GET  /v1/preview?url=     free  grade, score, status and counts (no fixes), 10/min per IP
//   POST /mcp                 free  remote MCP (Streamable HTTP, stateless JSON): check_x402_endpoint (preview tier)
//   GET  /health  /  /openapi.json  /.well-known/x402  /v1/stats   free
// Input is validated before the 402 (bad URL = 400, never charged); a target that cannot be probed still gets a report (that is
// the diagnosis); an internal failure answers 503 (never settled).
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
import { isOwnUrl } from './sibling.js';
import { diagnose, diagnoseSite, normalizeInput, previewView, InputError, UpstreamError, DISCLAIMER, LIMITS, ENGINE_VERSION } from './doctor.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_URL, LITE_EXAMPLE, CHECK_EXAMPLE, SITE_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const PREVIEW_PATH = '/v1/preview';
export const OWN_PROBE_CAP = { route: 12, site: 24 }; // lite/check = 5 probes + <= 4 docs; site = <= 4 docs + 8 routes x 2
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-x402fix/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/x402fix';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const DESC = {
  lite: 'x402 endpoint doctor for sellers: probes your paid URL unpaid (GET, HEAD, empty POST, CORS preflight; never pays) and returns a grade and a fix list. Checks the v2 PAYMENT-REQUIRED header and v1 body, every accepts entry (USDC asset, EIP-712 domain, Solana feePayer, atomic amount, payTo), multichain price consistency and the Bazaar declaration against its own JSON Schema.',
  check: 'Full x402 endpoint check with paste-ready fixes: everything in lite plus the CDP facilitator\'s own validate verdict and Bazaar index status, /openapi.json and /.well-known/x402 consistency, payee checks (EVM code, Solana USDC token account, CounterpartyCheck screening) and a generated, self-validated extensions.bazaar block, multichain accepts (Base, Polygon, Arbitrum One, Solana) and code snippet.',
  site: 'x402 site audit for one origin: finds your paid routes from /.well-known/x402 and /openapi.json (up to 8), checks each one unpaid (402 on GET and HEAD, v2 + v1 terms, accepts, Bazaar declaration) and flags drift between the discovery documents. Grade per route and for the site, with the top fixes.',
};
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', example: LITE_EXAMPLE, returns: 'Grade, score, status, fix list and every check (transport, v2, v1, accepts, multichain, Bazaar).' },
  { tier: 'check', path: '/v1/check', key: 'priceCheck', example: CHECK_EXAMPLE, returns: 'Lite + CDP validate verdict and index status, discovery docs, payee checks, generated bazaar block, accepts and snippet.' },
  { tier: 'site', path: '/v1/site', key: 'priceSite', example: SITE_EXAMPLE, returns: 'Per-route grades and top fixes for up to 8 paid routes of one origin, plus discovery-doc drift.' },
];
export const PROPS = {
  url: { type: 'string', description: 'Full https URL of the paid x402 route (site tier: the origin or API base URL)' },
  method: { type: 'string', enum: ['GET', 'POST'], description: 'Method your paid route uses (default: from its Bazaar declaration, else GET)' },
  framework: { type: 'string', enum: ['hono', 'express', 'next'], description: 'Server framework for the generated snippet (check tier, default hono)' },
};
const Q = { properties: PROPS, required: ['url'] };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: DESC[r.tier], mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.example };
    const input = { url: r.tier === 'site' ? 'https://api.youraitools.co/counterpartycheck' : EXAMPLE_URL };
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
 * @param {object} [opts] payTo, priceLite/priceCheck/priceSite, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats,
 *   freeLimiter, v1FetchImpl, dataFetch (tests: probes + RPC + CDP), check / site (tests: stub engines), counterparty (CounterpartyCheck
 *   preview client), staticSupported, syncFacilitatorOnStart, now, cdpDeps
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
  const engine = opts.check || diagnose;
  const siteEngine = opts.site || diagnoseSite;
  const dataFetch = opts.dataFetch || ((...a) => globalThis.fetch(...a));
  // Short per-isolate cache: preview reuses a result for 60 s, lite/check/site for 20 s (sellers re-run after each fix).
  const cache = new Map();
  // Fan-out cap: subrequests to our own Workers (service bindings / api.youraitools.co / *.agentgate.workers.dev) per check.
  // Over the cap the probe fails as 'self_probe_unavailable' (=> incomplete, never F) instead of spending more requests.
  const budgeted = (f, cap) => { let n = 0; return (input, init) => { const u = typeof input === 'string' ? input : input?.url; if (isOwnUrl(u) && ++n > cap) return Promise.reject(new Error(`self_probe_unavailable: own-probe budget (${cap}) exceeded`)); return f(input, init); }; };
  const run = async (input, tier) => {
    const ttl = tier === 'preview' ? 60000 : 20000;
    const k = `${tier}:${input.method || ''}:${input.url}`;
    const hit = cache.get(k);
    if (hit && now() - hit.at < ttl) return hit.r;
    const fetchImpl = budgeted(dataFetch, tier === 'site' ? OWN_PROBE_CAP.site : OWN_PROBE_CAP.route);
    const job = tier === 'site' ? siteEngine(input, { fetchImpl, now: now() }) : engine(input, { tier: tier === 'preview' ? 'lite' : tier, fetchImpl, now: now(), counterparty: opts.counterparty });
    const r = await withDeadline(job, BUDGET.workMs + 10000, 'x402 endpoint check');
    // Fail closed: an infrastructure-incomplete result is never cached and never sold (paid tiers answer 503, not charged).
    if (r && r.status === 'incomplete') { if (tier !== 'preview') throw new UpstreamError(`could not probe ${input.url} (${(r.sources_failed?.[0]?.reason || 'infrastructure').slice(0, 120)})`); return r; }
    cache.set(k, { at: now(), r }); if (cache.size > 300) cache.delete(cache.keys().next().value);
    return r;
  };
  const fail = (c, e) => {
    if (e instanceof InputError) return c.json({ error: e.code, message: e.message }, e.status);
    console.warn(`x402fix: ${e?.message}`); c.header('Retry-After', '10');
    if (e instanceof UpstreamError) return c.json({ error: 'upstream_unavailable', message: `${e.message}. Not charged; please retry.` }, 503);
    return c.json({ error: 'internal_timeout', message: 'The check did not finish in time. Not charged; please retry.' }, 503);
  };
  const prices = { lite: `$${usd(cfg.priceLite)}`, check: `$${usd(cfg.priceCheck)}`, site: `$${usd(cfg.priceSite)}` };

  const app = new Hono();
  // Loop guard: an x402fix probe (its own user-agent) never runs another check here (preview / MCP / credit-paid tiers).
  app.use('*', async (c, next) => {
    if (/^x402fix\//.test(c.req.header('user-agent') || '') && (c.req.path === PREVIEW_PATH || c.req.path === MCP_PATH)) return c.json({ error: 'loop', message: 'x402fix does not check itself recursively' }, 508);
    return next();
  });
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'x402fix',
    description: 'x402 endpoint doctor for sellers: give it your paid URL and get a grade plus paste-ready fixes. Probes unpaid (never pays): 402 on GET / HEAD / empty POST, CORS for browser buyers, the v2 PAYMENT-REQUIRED header and v1 body, every accepts entry (USDC asset, EIP-712 domain, Solana feePayer, atomic amounts, payTo), multichain consistency, the Bazaar declaration validated against its own schema, the CDP facilitator\'s validate verdict and index status, discovery docs and payee checks. Generates a corrected extensions.bazaar block and multichain accepts.',
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, params: ['url', 'method', 'framework'], price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'grade, score, status, counts and detected x402 versions / networks; no fixes' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_x402_endpoint'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    engine: ENGINE_VERSION,
    policy: { probes: 'unpaid only: GET, HEAD, POST (empty and {}), OPTIONS; no payment header is ever sent; public hosts only (no private or link-local addresses)', data: 'the target endpoint, its /openapi.json and /.well-known/x402, the CDP facilitator validate endpoint (public, unauthenticated), public RPCs (read-only) and CounterpartyCheck', storage: 'results cached in memory for up to 60 seconds; nothing is logged per URL', charging: 'only HTTP 200 results are settled; invalid input and internal failures are free' },
    limits: LIMITS, disclaimer: DISCLAIMER,
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true, engine: ENGINE_VERSION, version: VERSION }));
  const disc = (c) => ({ origin: origin(c), cfg, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  /** Read { url, method, framework } from the query or a JSON / text body. { empty } = no input at all (discovery probe). */
  async function readInput(c) {
    let raw;
    const q = () => ({ url: c.req.query('url') ?? c.req.query('endpoint') ?? c.req.query('resource'), method: c.req.query('method'), framework: c.req.query('framework') });
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"url": "https://..."}`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"url": "https://..."}`, 413] };
      if (!text.trim()) raw = q();
      else if (/^\s*[{[]/.test(text)) {
        let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"url": "https://api.example.com/v1/data"}'] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object {"url": "https://..."}'] };
        if (!Object.keys(b).length) return { empty: true };
        raw = b;
      } else raw = { ...q(), url: text.trim() };
    } else raw = q();
    const u = raw.url ?? raw.endpoint ?? raw.resource;
    if (u === undefined || u === null || u === '') return Object.keys(raw).some((k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '') ? { error: ['"url" is required, e.g. ?url=https://api.example.com/v1/data'] } : { empty: true };
    try { return { value: normalizeInput(raw) }; } catch (e) { return { error: [e.message, e.status || 400] }; }
  }
  const links = (c, u) => { const qs = `url=${encodeURIComponent(u)}`; return { lite: `${origin(c)}/v1/lite?${qs}`, check: `${origin(c)}/v1/check?${qs}`, site: `${origin(c)}/v1/site?${qs}`, prices }; };

  // ---- free preview ----
  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/lite (x402, USDC)` }, 429); }
    const p = await readInput(c);
    if (p.empty) { count(c, 'bad_request'); return bad(c, '"url" is required, e.g. ?url=https://api.example.com/v1/data'); }
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...previewView(r), full: { ...links(c, r.url), adds: 'every check and the fix list (lite); CDP validate verdict, index status, payee checks and generated fixes (check); all paid routes of the origin (site)' }, disclaimer: DISCLAIMER });
  });

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'check_x402_endpoint', title: 'Is my x402 endpoint correct?', description: `x402 endpoint doctor: probes a paid x402 URL unpaid (never pays) and grades it A-F: 402 on GET / HEAD / empty POST, CORS, v2 PAYMENT-REQUIRED header and v1 body, accepts (USDC asset, EIP-712 domain, Solana feePayer, amounts, payTo), multichain consistency and the Bazaar declaration. Free preview tier: grade, score, status and counts. The paid x402 endpoints /v1/lite (${prices.lite}), /v1/check (${prices.check}, adds the CDP validate verdict, payee checks and generated fixes) and /v1/site (${prices.site}, whole origin) return the fix list.`, inputSchema: { type: 'object', properties: { url: PROPS.url, method: PROPS.method }, required: ['url'] }, annotations: RO },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'x402fix', title: 'x402fix', version: VERSION }, instructions: 'Call check_x402_endpoint with the URL of a paid x402 route after deploying or changing it. Returns a grade and counts; the fix list is on the paid x402 routes.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/lite`); }
        let input; try { input = normalizeInput(m.params?.arguments || {}); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(input, 'preview'); } catch (e) { return err(`${e?.code || 'internal_timeout'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const v = previewView(r); const l = links(c, r.url);
        const text = `x402fix ${r.url}: grade ${v.grade} (${v.score}/100), ${v.status.replace(/_/g, ' ')}. Errors: ${v.counts.errors}, warnings: ${v.counts.warnings}, passed: ${v.counts.passed}. x402 ${[v.x402.v2 && 'v2', v.x402.v1 && 'v1'].filter(Boolean).join('+') || 'not detected'}${v.x402.networks.length ? ` on ${v.x402.networks.join(', ')}` : ''}.\nFix list: ${l.lite} (${prices.lite}); with CDP verdict and generated fixes: ${l.check} (${prices.check}); x402 USDC.\n${DISCLAIMER}`;
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
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { url: { type: 'string', required: true, description: PROPS.url.description }, method: { type: 'string', required: false, description: PROPS.method.description }, framework: { type: 'string', required: false, description: PROPS.framework.description } } }, output: r.example },
    }));
    // Validate before payment: malformed input gets a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readInput(c);
      if (p.empty) return next();
      if (p.error) return bad(c, ...p.error);
      c.set('fx', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of ROUTES) {
    app.on(['GET', 'POST'], r.path, async (c) => {
      const input = c.get('fx');
      if (!input) return bad(c, 'provide "url" (GET ?url=https://api.example.com/v1/data or POST {"url": "https://..."})');
      let res; try { res = await run(input, r.tier); } catch (e) { return fail(c, e); } // >= 400 is never settled
      return c.json(res);
    });
  }
  return app;
}
