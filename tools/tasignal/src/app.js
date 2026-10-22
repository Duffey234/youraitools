// Generic x402 tool app (shared by PerpRadar and TASignal): paid per call over x402 v2 + v1 (USDC on Base, Polygon,
// Arbitrum One or Solana) or with a prepaid credits key; free preview, remote MCP, discovery documents, usage stats.
// Everything tool-specific (routes, inputs, engine, views, copy) lives in ./tool.js.
// Inputs are validated before the 402 (a bad input is a 400, never charged). Upstream failures after payment
// verification are 503 upstream_unavailable and never settled (>= 400 is never settled).
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { x402ResourceServer } from '@x402/hono';
import { paymentMiddleware } from './credits-gate.js';
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
import { withDeadline, BUDGET } from './deadline.js';
import { VERSION_STR } from './version.js';
import * as T from './tool.js';

export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const ROUTES = T.ROUTES;
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: r.desc, mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.example };
    const inputSchema = { properties: r.schema.properties, required: r.schema.required || [] };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: r.input, inputSchema, output }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: r.input, inputSchema, output }) } };
  }
  return out;
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400, code = 'bad_request') => c.json({ error: code, message, disclaimer: T.DISCLAIMER }, status);
const atomic = (price) => String(Math.round(Number(String(price).replace('$', '')) * 1e6));
const usd = (price) => String(price).replace(/^\$/, '');

/**
 * @param {object} [opts] payTo, price keys, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats,
 *   freeLimiter, v1FetchImpl, dataFetch (tests: upstream fetches), staticSupported, syncFacilitatorOnStart, now, cdpDeps
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const stats = opts.stats || new Stats(undefined);
  const fac = selectFacilitator(cfg, opts.cdpDeps);
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme);
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };
  const now = () => (opts.now ? opts.now() : Date.now());
  const dataFetch = opts.dataFetch || ((...a) => globalThis.fetch(...a));
  // Short per-isolate cache: 20 s for paid tiers and the preview (market data moves); failed-source results 5 s.
  const cache = new Map(); const inflight = new Map();
  const run = async (tier, value) => {
    const key = `${tier}:${JSON.stringify(value)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (hit.r.sources_failed?.length ? 5000 : 20000)) return hit.r;
    if (inflight.has(key)) return inflight.get(key);
    const p = withDeadline(T.run(tier, value, { fetchImpl: dataFetch, now: now() }), BUDGET.workMs, T.SLUG).then((r) => {
      cache.set(key, { at: now(), r }); if (cache.size > 300) cache.delete(cache.keys().next().value); return r;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const fail = (c, e) => {
    if (e instanceof T.Incomplete) { c.header('Retry-After', '15'); return c.json({ error: e.code, message: e.message, sources_failed: e.sources_failed, charged: false, disclaimer: T.DISCLAIMER }, 503); }
    if (e instanceof T.InputError) { if (e.status >= 500) c.header('Retry-After', '10'); return c.json({ error: e.code, message: `${e.message}. Not charged.`, charged: false }, e.status); }
    console.warn(`${T.SLUG}: ${e?.message}`); c.header('Retry-After', '10');
    return c.json({ error: 'upstream_unavailable', message: 'The data sources did not answer in time. Not charged; please retry.', sources_failed: ['timeout'], charged: false }, 503);
  };
  const prices = Object.fromEntries(ROUTES.map((r) => [r.tier, `$${usd(cfg[r.key])}`]));

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg));
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf }));
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: T.NAME,
    description: T.DESCRIPTION,
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, params: Object.keys(r.schema.properties), price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, params: Object.keys(T.PREVIEW.schema.properties), limit: '10 requests/min per IP', returns: T.PREVIEW.returns },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: T.MCP_TOOLS.map((t) => t.name), limit: '10 tool calls/min per IP (preview tier)' },
    },
    engine: T.ENGINE_VERSION, userAgent: T.USER_AGENT, sources: T.SOURCES,
    policy: { custody: 'read-only analytics: never trades, never holds customer funds, never asks for keys', storage: 'results cached in memory for up to 20 seconds; requests are not logged', charging: 'only HTTP 200 results are settled; bad input (400), unknown symbols (404) and upstream failures (503) are free', failClosed: 'a data source that fails or times out is listed in sources_failed and never estimated; confidence drops' },
    limits: T.LIMITS, disclaimer: T.DISCLAIMER,
    source: T.SOURCE_URL, allTools: 'https://youraitools.co/built-by-us', npm: T.NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', async (c) => {
    if (c.req.query('sources') !== '1') return c.json({ ok: true, engine: T.ENGINE_VERSION });
    if (await limited(opts.freeLimiter, c)) return c.json({ error: 'rate_limited' }, 429);
    return c.json({ ok: true, engine: T.ENGINE_VERSION, sources: await T.probeSources({ fetchImpl: dataFetch }) });
  });
  const disc = (c) => ({ origin: origin(c), cfg, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  /** Read inputs from the query string or a JSON body. { empty } = no input at all (discovery probe). */
  async function readInput(c, route) {
    let raw = {};
    const q = c.req.query();
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      if (text.trim()) {
        let b; try { b = JSON.parse(text); } catch { return { error: [`body must be JSON, e.g. ${JSON.stringify(route.input)}`] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: [`body must be a JSON object, e.g. ${JSON.stringify(route.input)}`] };
        raw = { ...q, ...b };
      } else raw = { ...q };
    } else raw = { ...q };
    const keys = Object.keys(raw).filter((k) => raw[k] !== '' && raw[k] !== undefined && raw[k] !== null);
    if (!keys.length) return { empty: true, error: [`provide input, e.g. ${route.path}?${new URLSearchParams(route.input)}`] };
    try { return { value: T.parseInput(route.tier, raw) }; } catch (e) { return { error: [e.message, e.status || 400, e.code] }; }
  }

  // ---- free preview ----
  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}${ROUTES[0].path} (x402 USDC on Base or Solana, or a prepaid credits key)` }, 429); }
    const p = await readInput(c, T.PREVIEW);
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run('preview', p.value); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...T.previewView(r), full: T.fullLinks(origin(c), p.value, prices) });
  });

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: T.SLUG, title: T.NAME, version: VERSION }, instructions: T.MCP_INSTRUCTIONS });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: T.MCP_TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!T.MCP_TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${ROUTES[0].path}`); }
        let v; try { v = T.parseInput('preview', m.params?.arguments || {}); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run('preview', v); } catch (e) { return err(`${e?.code || 'upstream_unavailable'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const pv = T.previewView(r);
        return ok({ content: [{ type: 'text', text: T.previewText(pv, origin(c), v, prices) }], structuredContent: pv, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid routes ----
  const v1s = [];
  for (const r of ROUTES) {
    app.use(r.path, paidRouteStats(stats, r.tier));
    const queryParams = Object.fromEntries(Object.entries(r.schema.properties).map(([k, s]) => [k, { type: s.type === 'array' ? 'string' : s.type, required: (r.schema.required || []).includes(k), description: s.description }]));
    v1s.push(x402v1({
      path: r.path, amount: atomic(cfg[r.key]), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
      description: r.desc, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams }, output: r.example },
    }));
    // Validate before payment: bad input = 400 (never a 402, never charged). A bare request (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readInput(c, r);
      if (p.empty) return next();
      if (p.error) return bad(c, ...p.error);
      c.set('input', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of ROUTES) {
    app.on(['GET', 'POST'], r.path, async (c) => {
      const v = c.get('input');
      if (!v) return bad(c, `provide input, e.g. GET ${r.path}?${new URLSearchParams(r.input)} or POST ${JSON.stringify(r.input)}`);
      let res; try { res = await run(r.tier, v); } catch (e) { return fail(c, e); } // >= 400 is never settled
      return c.json({ ...T.paidView(r.tier, res), tier: r.tier, disclaimer: T.DISCLAIMER });
    });
  }
  return app;
}
