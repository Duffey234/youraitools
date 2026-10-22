// WebRead: URL -> clean Markdown for AI agents, paid per call over x402 ($0.002 USDC on Base).
//   GET  /v1/read?url=&maxChars=        PAID  full Markdown (up to 200k chars), metadata
//   GET  /v1/read/preview?url=          free  first 2,000 chars, 10/min per IP
//   POST /mcp                           free  remote MCP (Streamable HTTP, stateless JSON), tool read_url (preview size)
//   GET  /v1/stats  /health  /           free
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
import { Reader, FetchError } from './reader.js';
import { Stats, paidRouteStats, isSmoke, waitUntilOf } from './stats.js';
import { x402v1 } from './x402v1.js';
import { prefersHtml, landingHtml } from './landing.js';
import { withDeadline, DeadlineError, BUDGET } from './deadline.js';
import { openapiDoc, wellKnownX402, FAVICON_ICO, FAVICON_SVG } from './discovery.js';

export const PAID_PATH = '/v1/read';
export const PREVIEW_PATH = '/v1/read/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = '0.1.4';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const OUTPUT_EXAMPLE = {
  url: 'https://example.com/', finalUrl: 'https://example.com/', status: 200, contentType: 'text/html; charset=utf-8',
  title: 'Example Domain', description: null, lang: 'en', canonical: null,
  markdown: 'This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.',
  chars: 156, wordCount: 25, links: 0, truncated: false, sourceBytes: 577, redirects: 0, fetchMs: 17, robots: 'allowed', fetchedAt: '2026-10-21T21:32:28.690Z',
};
const DESCRIPTION = 'Converts a public web page into clean Markdown for LLMs and RAG pipelines: main content only (no nav, ads or scripts), absolute links, plus title, description and language metadata. Suited to AI agents that read, cite or summarize web pages. Respects robots.txt; only successful reads are charged.';
const QUERY_SCHEMA = {
  properties: {
    url: { type: 'string', description: 'Absolute http(s) URL of a public web page (HTML or plain text)' },
    maxChars: { type: 'integer', minimum: 100, maximum: 200000, description: 'Truncate the Markdown to this many characters (default 200000)' },
  },
  required: ['url'],
};

export function routesConfig({ price, network, payTo, publicUrl }) {
  return {
    [`GET ${PAID_PATH}`]: {
      ...(publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${PAID_PATH}` } : {}),
      accepts: { scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 },
      description: DESCRIPTION, mimeType: 'application/json', ...ROUTE_META,
      extensions: { ...declareDiscoveryExtension({ input: { url: 'https://example.com/' }, inputSchema: QUERY_SCHEMA, output: { example: OUTPUT_EXAMPLE } }) },
    },
  };
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const errBody = (e) => ({ error: e.code || 'error', message: e.message });
const clampChars = (v, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, 100), max) : max; };

/**
 * @param {object} [opts] payTo, price, network, facilitatorUrl, publicUrl, facilitatorClient (tests), reader (tests),
 *   fetchImpl (tests, used by the default Reader), dns (default true), statsKv, stats, freeLimiter, v1FetchImpl, syncFacilitatorOnStart
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const reader = opts.reader || new Reader({ fetchImpl: opts.fetchImpl, dns: opts.dns ?? true });
  const stats = opts.stats || new Stats(opts.statsKv);
  const fac = selectFacilitator(cfg, opts.cdpDeps); // FACILITATOR=payai|cdp; cdp without keys falls back to PayAI
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme); // extra networks from networks.js (Base registered above, unchanged)
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'WebRead',
    description: 'URL to clean Markdown for AI agents. Paid per call over x402; free preview and remote MCP.',
    paid: { method: 'GET', path: PAID_PATH, price: cfg.price, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
    free: ['/health', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: `first ${cfg.previewChars} characters of the Markdown` },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['read_url'], limit: '10 tool calls/min per IP' },
      stats: { method: 'GET', path: STATS_PATH },
    },
    limits: { maxBytes: cfg.maxBytes, timeoutMs: cfg.timeoutMs, maxMarkdownChars: 200000 },
    policy: { robotsTxt: 'respected (user-agent token WebReadBot)', blocked: 'private/reserved IPs, non-http(s) schemes, non-default ports', charging: 'only successful reads (HTTP 200 from this API) are settled' },
    source: 'https://agentgate-source.pages.dev/x402-url-to-markdown/',
    guide: 'https://youraitools.co/guides/pay-per-call-web-scraper-api',
    allTools: 'https://youraitools.co/built-by-us',
    mcpRegistry: 'io.github.agentgate-builder/x402-url-to-markdown',
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true }));
  // Discovery: OpenAPI (x402scan, agents), /.well-known/x402 manifest, favicon. All static, no I/O.
  const disc = (c) => ({ origin: origin(c), price: cfg.price, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  app.get('/favicon.ico', (c) => c.body(FAVICON_ICO, 200, { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=86400' }));
  app.get('/favicon.svg', (c) => c.body(FAVICON_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  async function doRead(c, url, maxChars) {
    // One hard deadline for robots.txt + DNS + redirects + body (each step also has its own timeout).
    try { return { ok: true, r: await withDeadline(reader.read(url, { maxChars }), opts.workMs ?? BUDGET.workMs, 'read') }; } catch (e) {
      if (e instanceof DeadlineError) return { ok: false, status: 504, body: { error: 'timeout', message: `${e.message}; not charged` } };
      if (e instanceof FetchError) { if (e.code?.startsWith('robots')) count(c, 'robots_blocked'); return { ok: false, status: e.status, body: errBody(e) }; }
      return { ok: false, status: 502, body: { error: 'read_failed', message: String(e.message || e).slice(0, 200) } };
    }
  }
  const preview = (r) => ({ ...r, markdown: r.markdown.slice(0, cfg.previewChars), chars: Math.min(r.chars, cfg.previewChars), truncated: r.truncated || r.chars > cfg.previewChars, tier: 'free', full: { path: PAID_PATH, price: `${cfg.price} USDC on Base (x402)` } });

  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `Free preview is limited per IP per minute. Unlimited full reads: ${origin(c)}${PAID_PATH} (${cfg.price} USDC, x402)` }, 429); }
    const res = await doRead(c, c.req.query('url'), cfg.previewChars + 1000);
    if (!res.ok) return c.json(res.body, res.status);
    count(c, 'free_preview');
    return c.json({ ...preview(res.r), full: { url: `${origin(c)}${PAID_PATH}?url=${encodeURIComponent(res.r.url)}`, price: `${cfg.price} USDC on Base (x402)` } });
  });

  // Remote MCP (stateless JSON-RPC over Streamable HTTP).
  const TOOL = {
    name: 'read_url', title: 'Read a web page as Markdown',
    description: `Fetch a public web page and return its main content as clean Markdown (no navigation, scripts or ads), with title and description. Respects robots.txt. Free tier returns the first ${cfg.previewChars} characters; the paid x402 endpoint returns up to 200,000.`,
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL' } }, required: ['url'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
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
    switch (m.method) {
      case 'initialize': {
        const v = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'webread', title: 'WebRead', version: VERSION }, instructions: 'read_url returns a public web page as clean Markdown (main content, absolute links, title and metadata).' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: [TOOL] });
      case 'tools/call': {
        if (m.params?.name !== 'read_url') return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return ok({ isError: true, content: [{ type: 'text', text: `Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${PAID_PATH}` }] }); }
        const res = await doRead(c, m.params?.arguments?.url, cfg.previewChars + 1000);
        if (!res.ok) return ok({ isError: true, content: [{ type: 'text', text: `${res.body.error}: ${res.body.message}` }] });
        count(c, 'free_mcp');
        const p = preview(res.r);
        const head = `# ${p.title || p.finalUrl}\nSource: ${p.finalUrl}\n${p.truncated ? `(free tier: first ${cfg.previewChars} characters; full page via ${origin(c)}${PAID_PATH})\n` : ''}\n`;
        return ok({ content: [{ type: 'text', text: head + p.markdown }], structuredContent: { ...p, markdown: p.markdown }, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  app.use(PAID_PATH, paidRouteStats(stats));
  const v1 = x402v1({
    path: PAID_PATH, amount: String(Math.round(Number(String(cfg.price).replace('$', '')) * 1e6)), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
    description: DESCRIPTION, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
    outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { url: { type: 'string', required: true, description: QUERY_SCHEMA.properties.url.description }, maxChars: { type: 'integer', required: false, description: QUERY_SCHEMA.properties.maxChars.description } } }, output: OUTPUT_EXAMPLE },
  });
  app.use(v1.middleware);
  app.use(v1.skipIfV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));

  app.get(PAID_PATH, async (c) => {
    // >= 400 is never settled, so bad URLs, robots blocks and upstream failures are free.
    const res = await doRead(c, c.req.query('url'), clampChars(c.req.query('maxChars'), 200000));
    if (!res.ok) return c.json(res.body, res.status);
    return c.json(res.r);
  });
  return app;
}
