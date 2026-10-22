// StackDetect: website technology / tech-stack detection for AI agents, sales and research workflows, paid per call over x402 (USDC on Base).
//   GET|POST /v1/detect?url=      PAID $0.003  technologies with categories, versions, confidence and evidence, plus email / DNS /
//                                               hosting providers and verified SaaS from public DNS (MX, NS, TXT)
//   GET|POST /v1/preview?url=     free  technology names + categories only (no versions, evidence or DNS), 10/min per IP
//   POST /mcp                     free  remote MCP (Streamable HTTP, stateless JSON): detect_stack (preview tier)
//   GET  /v1/categories  /v1/stats  /health  /  /openapi.json  /.well-known/x402   free
// One GET of the target page per call (SSRF-safe, 8 s, 1.5 MB cap). Inputs are validated before the 402, so a malformed URL is
// never charged; a page that can't be fetched (or answers an error with nothing detectable) gets a 4xx/5xx, which is never settled.
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
import { detectStack, normalizeTarget, FetchError, CATEGORIES, DISCLAIMER, ENGINE_VERSION, SIGNATURE_COUNT } from './detect.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_URL, DETECT_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const DETECT_PATH = '/v1/detect';
export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const CATEGORIES_PATH = '/v1/categories';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-stackdetect/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/stackdetect';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const DETECT_DESCRIPTION = `Detects the technology stack of any public website from one page load plus public DNS: CMS, ecommerce platform, JS framework, web server, CDN/hosting, analytics, ad pixels, chat, payments, consent, plus email provider, email-sending services, DNS host and verified SaaS (MX/NS/TXT). Each hit has categories, version when exposed, confidence 0-100 and evidence. ${SIGNATURE_COUNT} signatures.`;
const Q = { properties: { url: { type: 'string', description: 'Absolute http(s) URL or a bare domain, e.g. https://laravel.com or shopify.com' } }, required: ['url'] };

export function routesConfig({ price, network, payTo, publicUrl }) {
  const pub = publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${DETECT_PATH}` } : {};
  const base = { ...pub, accepts: { scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 }, description: DETECT_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  const out = { example: DETECT_EXAMPLE };
  return {
    [`GET ${DETECT_PATH}`]: { ...base, extensions: { ...declareDiscoveryExtension({ input: { url: EXAMPLE_URL }, inputSchema: Q, output: out }) } },
    [`POST ${DETECT_PATH}`]: { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { url: EXAMPLE_URL }, inputSchema: Q, output: out }) } },
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
 * @param {object} [opts] payTo, price, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats, freeLimiter,
 *   v1FetchImpl, targetFetch (tests: page + DoH fetch), staticSupported, syncFacilitatorOnStart, now (tests), cdpDeps
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
  const targetFetch = opts.targetFetch || ((...a) => globalThis.fetch(...a));
  const run = (url, tier) => withDeadline(detectStack(url, { tier, fetchImpl: targetFetch, now: now(), cfEdge: !!cfg.cfEdge }), BUDGET.workMs - 1000, 'detect');
  const fail = (c, e) => {
    if (e instanceof FetchError) { if (e.status >= 500) c.header('Retry-After', '10'); return c.json({ error: e.code, message: `${e.message}. Not charged.` }, e.status >= 400 && e.status < 600 ? e.status : 502); }
    console.warn(`stackdetect: ${e?.message}`); c.header('Retry-After', '10');
    return c.json({ error: 'upstream_unavailable', message: 'The site did not answer in time. Not charged; please retry.' }, 504);
  };
  /** A site error page with nothing detectable is not a result: answer 422 (never settled). */
  const empty = (r) => r.http_status >= 400 && r.technology_count === 0;

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'StackDetect',
    description: 'Website technology detection for AI agents: CMS, frameworks, hosting/CDN, analytics, ad pixels, payments, plus email / DNS providers and verified SaaS from public DNS, with versions, confidence and evidence. Paid per call over x402; free preview and remote MCP.',
    paid: [{ methods: ['GET', 'POST'], path: DETECT_PATH, param: 'url', price: cfg.price, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] }],
    free: ['/health', PREVIEW_PATH, MCP_PATH, CATEGORIES_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { methods: ['GET', 'POST'], path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'technology names and categories from the page; no versions, confidence, evidence or DNS-based providers' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['detect_stack'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    signatures: SIGNATURE_COUNT, categories: Object.keys(CATEGORIES).length, engine: ENGINE_VERSION,
    policy: { fetch: 'one GET of the URL you pass (redirects followed, 8 s timeout, 1.5 MB cap, private/internal addresses refused) plus 3 public DNS queries (MX, NS, TXT) on the paid tier', storage: 'nothing is stored or logged; cookie values are never kept, only cookie names', charging: 'only HTTP 200 results are settled; invalid URLs, unreachable sites and error pages with nothing detectable are free' },
    disclaimer: DISCLAIMER,
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true, engine: ENGINE_VERSION }));
  const disc = (c) => ({ origin: origin(c), price: cfg.price, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });
  app.get(CATEGORIES_PATH, (c) => { c.header('Cache-Control', 'public, max-age=3600'); return c.json({ categories: CATEGORIES, signatures: SIGNATURE_COUNT, engine: ENGINE_VERSION }); });

  /** Read the target from ?url= or a JSON / text body. { empty } = no input at all (discovery probe). */
  async function readTarget(c) {
    let raw;
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"url": "https://..."}`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"url": "https://..."}`, 413] };
      if (!text.trim()) raw = c.req.query('url');
      else if (/^\s*[{[]/.test(text)) {
        let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"url": "https://example.com"}'] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object {"url": "..."}'] };
        if (!Object.keys(b).length) return { empty: true, error: ['"url" is required, e.g. {"url": "https://example.com"}'] };
        raw = b.url ?? b.domain ?? b.host;
        if (raw === undefined) return { error: ['"url" is required, e.g. {"url": "https://example.com"}'] };
      } else raw = text.trim();
    } else raw = c.req.query('url') ?? c.req.query('domain');
    if (raw === undefined || raw === null || raw === '') return { empty: true, error: ['"url" is required, e.g. ?url=https://example.com'] };
    if (typeof raw !== 'string') return { error: ['"url" must be a string'] };
    try { normalizeTarget(raw); } catch (e) { return { error: [e.message, e.status || 400] }; }
    return { value: raw };
  }

  // ---- free preview ----
  const preview = async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}${DETECT_PATH} (x402, USDC on Base)` }, 429); }
    const p = await readTarget(c);
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...r, full: { url: `${origin(c)}${DETECT_PATH}?url=${encodeURIComponent(p.value)}`, price: `${cfg.price} USDC on Base (x402)`, adds: 'versions, confidence 0-100 and evidence per technology, plus email provider, email-sending services, DNS host and verified SaaS from public DNS (MX/NS/TXT)' } });
  };
  app.get(PREVIEW_PATH, preview); app.post(PREVIEW_PATH, preview);

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'detect_stack', title: 'What is this website built with?', description: `Detects the technologies a website uses (CMS, ecommerce platform, JS framework, web server, CDN/hosting, analytics, ad pixels, chat, payments, consent tools) from one page load. Free preview tier: technology names and categories. The paid x402 endpoint ${DETECT_PATH} adds versions, confidence and evidence plus email / DNS / hosting providers and verified SaaS from public DNS.`, inputSchema: { type: 'object', properties: Q.properties, required: ['url'] }, annotations: RO },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'stackdetect', title: 'StackDetect', version: VERSION }, instructions: 'Call detect_stack with a URL or domain to see what the site is built with (CMS, framework, hosting, analytics, payments). Useful for lead research, competitor analysis and choosing how to integrate with or scrape a site.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${DETECT_PATH}`); }
        const url = m.params?.arguments?.url ?? m.params?.arguments?.domain;
        if (typeof url !== 'string' || !url.trim()) return err('bad_request: "url" is required, e.g. https://example.com');
        try { normalizeTarget(url); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(url, 'preview'); } catch (e) { return err(`${e?.code || 'upstream_unavailable'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const cats = Object.entries(r.categories).map(([k, v]) => `${CATEGORIES[k] || k}: ${v.join(', ')}`).join('\n');
        const text = `StackDetect ${r.final_url} (HTTP ${r.http_status}): ${r.technology_count} technologies.\n${cats || 'Nothing detected from the page alone.'}\nVersions, confidence, evidence and email/DNS/hosting providers: ${origin(c)}${DETECT_PATH}?url=${encodeURIComponent(url)} (${cfg.price} USDC, x402).\n${DISCLAIMER}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: r, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid route ----
  app.use(DETECT_PATH, paidRouteStats(stats, 'detect'));
  const v1 = x402v1({
    path: DETECT_PATH, amount: atomic(cfg.price), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
    description: DETECT_DESCRIPTION, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
    outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { url: { type: 'string', required: true, description: Q.properties.url.description } } }, output: DETECT_EXAMPLE },
  });
  // Validate before payment: a malformed URL gets a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
  app.use(DETECT_PATH, async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
    const p = await readTarget(c);
    if (p.empty) return next(); // bare URL: answer with the 402 terms; the handler 400s (never settled) if paid without input
    if (p.error) return bad(c, ...p.error);
    c.set('target', p.value);
    return next();
  });
  app.use(v1.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  app.on(['GET', 'POST'], DETECT_PATH, async (c) => {
    const t = c.get('target');
    if (!t) return bad(c, 'provide "url" (GET ?url= or POST {"url": "..."})');
    let r; try { r = await run(t, 'full'); } catch (e) { return fail(c, e); } // >= 400 is never settled
    if (empty(r)) return c.json({ error: 'site_error', message: `The site answered HTTP ${r.http_status} and nothing could be detected. Not charged.`, http_status: r.http_status }, 422);
    return c.json(r);
  });
  return app;
}
