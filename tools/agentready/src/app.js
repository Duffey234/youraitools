// AgentReady: is this website ready for AI agents? Paid per call over x402 (USDC on Base, Polygon, Arbitrum One or
// Solana) or with a prepaid credits key.
//   GET|POST /v1/lite?url=    PAID $0.005  score 0-100, grade, verdict, category scores, top 5 fixes, AI bots blocked
//   GET|POST /v1/audit?url=   PAID $0.03   full audit: 23 checks with evidence (robots.txt rules for 17 AI bots, bot
//                                           challenges, raw-HTML content, markdown, llms.txt / llms-full.txt, sitemap,
//                                           JSON-LD, meta/OG, OpenAPI, MCP (discovery + live initialize), A2A / agent
//                                           manifests, x402, HTTPS/HSTS, speed), prioritized fixes and ready-to-paste
//                                           snippets (llms.txt draft, robots.txt lines, JSON-LD, meta tags, mcp.json, agent card)
//   GET  /v1/preview?url=     free  score, grade, category scores, counts (no fixes), 10/min per IP
//   GET  /r/<host>            free  shareable report page (OG tags) with in-browser x402 purchase
//   GET  /badge/<host>.svg    free  "AgentReady score" SVG badge for READMEs and sites
//   POST /mcp                 free  remote MCP (Streamable HTTP, stateless JSON): audit_website (preview tier)
//   GET  /health  /  /openapi.json  /.well-known/x402  /v1/stats  /og/<name>.png   free
// Inputs are validated before the 402 (bad URL, private IP or internal host = 400, never charged). DNS failures or
// private DNS answers = 422 and an unreachable site = 503 checks_incomplete after payment verification: >= 400 is never settled.
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
import { auditSite, normalizeTarget, previewView, liteView, InputError, AuditIncomplete, DISCLAIMER, LIMITS, ENGINE_VERSION, USER_AGENT } from './audit.js';
import { DOH } from './net.js';
import { reportHtml, badgeSvg, reportErrorHtml } from './report.js';
import { OG_PNG } from './og.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_URL, LITE_EXAMPLE, AUDIT_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-agentready/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/agentready';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

const DESC = {
  lite: 'Is this website ready for AI agents? Score 0-100, grade A-F and verdict with category scores (agent access, readable content, discovery, agent interfaces, speed/HTTPS), the top 5 prioritized fixes and which AI bots robots.txt blocks. Checks robots.txt for 17 AI bots, bot challenges, raw-HTML content, markdown, llms.txt, sitemap, JSON-LD, meta/OG, OpenAPI, MCP, A2A agent card, x402, HTTPS and speed.',
  audit: 'Full AI-agent readiness audit of a website: 23 checks with evidence (robots.txt rules for 17 AI crawlers and agents incl. GPTBot, ClaudeBot, ChatGPT-User, PerplexityBot; WAF / bot challenges; content in the raw HTML without JavaScript; markdown via Accept: text/markdown; llms.txt and llms-full.txt validation; sitemap; schema.org JSON-LD; meta, canonical and Open Graph; OpenAPI; MCP discovery plus a live MCP initialize; A2A agent card, agents.json, ai-plugin.json; x402; HTTPS, HSTS, response time; accessibility basics), score 0-100 and grade, prioritized fixes and ready-to-paste snippets (generated llms.txt draft, robots.txt lines, JSON-LD, meta tags, mcp.json, agent card).',
};
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', example: LITE_EXAMPLE, returns: 'Score, grade, verdict, category scores, top 5 fixes, AI bots blocked.' },
  { tier: 'audit', path: '/v1/audit', key: 'priceAudit', example: AUDIT_EXAMPLE, returns: 'All 23 checks with evidence, AI-bot robots matrix, prioritized fixes, ready-to-paste snippets (llms.txt draft, robots lines, JSON-LD, meta tags, mcp.json, agent card).' },
];
// Compact example for the Bazaar declaration (PAYMENT-REQUIRED header): every top-level field, arrays cut to 1 item,
// long strings shortened. The full example stays in the v1 402 body, OpenAPI and the landing page. Keeps the header ~7 KB.
export function compactExample(v, key = '') {
  if (Array.isArray(v)) return v.slice(0, 1).map((x) => compactExample(x));
  if (typeof v === 'string') return v.length > 80 && key !== 'disclaimer' ? `${v.slice(0, 77)}...` : v;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v); // big maps of objects (e.g. robots.bots, 17 bots) keep 3 entries
    const keep = keys.length > 8 && keys.every((k) => v[k] && typeof v[k] === 'object') ? keys.slice(0, 3) : keys;
    return Object.fromEntries(keep.map((k) => [k, compactExample(v[k], k)]));
  }
  return v;
}
const Q = { properties: { url: { type: 'string', description: 'Website URL or domain to audit, e.g. https://example.com or stripe.com (public http/https only)' } }, required: ['url'] };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: DESC[r.tier], mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.tier === 'audit' ? compactExample(r.example) : r.example };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: { url: EXAMPLE_URL }, inputSchema: Q, output }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { url: EXAMPLE_URL }, inputSchema: Q, output }) } };
  }
  return out;
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400, code = 'bad_request') => c.json({ error: code, message }, status);
const atomic = (price) => String(Math.round(Number(String(price).replace('$', '')) * 1e6));
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;

/**
 * @param {object} [opts] payTo, priceLite/priceAudit, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats,
 *   freeLimiter, v1FetchImpl, dataFetch (tests: site fetches), analyze (tests: stub engine), staticSupported, syncFacilitatorOnStart, now, cdpDeps
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
  const engine = opts.analyze || auditSite;
  const dataFetch = opts.dataFetch || ((...a) => globalThis.fetch(...a));
  // Short per-isolate cache: free views reuse a result for 10 min, paid tiers for 60 s. Results with failed sources: 30 s.
  const cache = new Map(); const inflight = new Map();
  const run = async (u, tier) => {
    const key = u.href;
    const ttl = tier === 'preview' || tier === 'report' || tier === 'badge' ? 600000 : 60000;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (hit.r.sources_failed.length ? Math.min(ttl, 30000) : ttl)) return hit.r;
    if (inflight.has(key)) return inflight.get(key);
    const p = withDeadline(engine(u, { fetchImpl: dataFetch, now: now() }), BUDGET.workMs, 'audit').then((r) => {
      cache.set(key, { at: now(), r }); if (cache.size > 300) cache.delete(cache.keys().next().value); return r;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const fail = (c, e) => {
    if (e instanceof AuditIncomplete) { c.header('Retry-After', '30'); return c.json({ error: e.code, message: e.message, sources_failed: e.sources_failed, provisional: e.provisional, charged: false }, 503); }
    if (e instanceof InputError) { if (e.status >= 500) c.header('Retry-After', '10'); return c.json({ error: e.code, message: `${e.message}. Not charged.` }, e.status); }
    console.warn(`agentready: ${e?.message}`); c.header('Retry-After', '10');
    return c.json({ error: 'checks_incomplete', message: 'The audit did not finish in time. Not charged; please retry.', sources_failed: ['timeout'], charged: false }, 503);
  };
  const prices = { lite: `$${usd(cfg.priceLite)}`, audit: `$${usd(cfg.priceAudit)}` };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'AgentReady',
    description: 'Is this website ready for AI agents? An x402 audit that checks robots.txt rules for 17 AI crawlers and agents, bot challenges, content in the raw HTML, markdown, llms.txt, sitemap, JSON-LD, meta/OG, OpenAPI, MCP (live), A2A agent card, x402, HTTPS and speed, then returns a 0-100 score, a grade, prioritized fixes and ready-to-paste snippets (llms.txt draft, robots.txt lines, JSON-LD, meta tags). Paid per call over x402 or with prepaid credits; free preview, shareable report pages, a score badge and remote MCP.',
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, param: 'url', price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, '/r/<host>', '/badge/<host>.svg', MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'score, grade, verdict, category scores, pass/warn/fail counts; no findings or fixes' },
      report: { method: 'GET', path: '/r/<host>', returns: 'shareable HTML report with Open Graph tags; in-browser x402 purchase of the full audit' },
      badge: { method: 'GET', path: '/badge/<host>.svg', returns: 'SVG score badge (cached 1 h)' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['audit_website'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    engine: ENGINE_VERSION, userAgent: USER_AGENT,
    policy: { fetching: 'one-off audit requested by the caller: about 20 GET requests (plus one MCP initialize POST) to well-known public paths of the site, honest AgentReadyBot user agent, 5 s timeout each (page 7 s), bodies capped at 512 KB; private / internal addresses are refused (DNS checked), redirects capped at 5 and re-checked', storage: 'results cached in memory for up to 10 minutes; nothing is logged per site', charging: 'only HTTP 200 results are settled; invalid or private URLs (400/422) and unreachable sites (503 checks_incomplete) are free', failClosed: 'a check whose source fails or times out is "unknown", scores 0 and is listed in sources_failed; confidence drops' },
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
    const probe = async (name, url, init) => { const t0 = Date.now(); try { const r = await withDeadline(dataFetch(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init?.headers || {}) } }), 6000, name); return [name, { status: r.status, ms: Date.now() - t0 }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
    const res = await Promise.all([...DOH.map((u) => probe(`doh_${new URL(u).host}`, `${u}?name=example.org&type=A`, { headers: { accept: 'application/dns-json' } })), probe('sample_site', 'https://example.org/')]);
    return c.json({ ok: true, engine: ENGINE_VERSION, sources: Object.fromEntries(res) });
  });
  const disc = (c) => ({ origin: origin(c), cfg, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get('/og/:name{[a-z]+\\.png}', (c) => {
    const k = c.req.param('name').replace('.png', '');
    if (!OG_PNG[k]) return c.notFound();
    const bin = Uint8Array.from(atob(OG_PNG[k]), (ch) => ch.charCodeAt(0));
    return c.body(bin, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
  });
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  /** Read the URL from ?url= or a JSON / text body. { empty } = no input at all (discovery probe). */
  async function readUrl(c) {
    let raw;
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"url": "https://example.com"}`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"url": "https://example.com"}`, 413] };
      if (!text.trim()) raw = c.req.query('url') ?? c.req.query('domain') ?? c.req.query('site');
      else if (/^\s*[{[]/.test(text)) {
        let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"url": "https://example.com"}'] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object {"url": "https://example.com"}'] };
        if (!Object.keys(b).length) return { empty: true, error: ['"url" is required, e.g. {"url": "https://example.com"}'] };
        raw = b.url ?? b.domain ?? b.site;
        if (raw === undefined) return { error: ['"url" is required, e.g. {"url": "https://example.com"}'] };
      } else raw = text.trim();
    } else raw = c.req.query('url') ?? c.req.query('domain') ?? c.req.query('site');
    if (raw === undefined || raw === null || raw === '') return { empty: true, error: ['"url" is required, e.g. ?url=https://example.com'] };
    if (typeof raw !== 'string') return { error: ['"url" must be a string'] };
    try { return { value: normalizeTarget(raw) }; } catch (e) { return { error: [e.message, e.status || 400, e.code] }; }
  }

  // ---- free preview ----
  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/lite (x402 USDC on Base or Solana, or a prepaid credits key)` }, 429); }
    const p = await readUrl(c);
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    const q = encodeURIComponent(p.value.href);
    return c.json({ ...previewView(r), report: `${origin(c)}/r/${r.host}`, badge: `${origin(c)}/badge/${r.host}.svg`, full: { lite: `${origin(c)}/v1/lite?url=${q}`, audit: `${origin(c)}/v1/audit?url=${q}`, prices, adds: 'top 5 fixes and blocked AI bots (lite); all 23 checks with evidence, robots matrix for 17 AI bots, every fix and ready-to-paste snippets: llms.txt draft, robots.txt lines, JSON-LD, meta tags, mcp.json, agent card (audit)' } });
  });

  // ---- shareable report page + badge (home page of a host) ----
  const hostData = async (c, tier) => {
    const host = String(c.req.param('host') || '').toLowerCase().replace(/\.svg$/, '');
    if (!HOST_RE.test(host)) return { status: 400, message: 'Use a domain name, e.g. /r/example.com' };
    let u; try { u = normalizeTarget(host); } catch (e) { return { status: 400, message: e.message }; }
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return { status: 429, message: 'Too many free checks from your network this minute. Retry shortly.' }; }
    try { const r = await run(u, tier); count(c, tier === 'badge' ? 'free_badge' : 'free_report'); return { r, u }; } catch (e) { return { status: e.status || 503, message: e instanceof InputError || e instanceof AuditIncomplete ? e.message : 'The audit did not finish in time. Please retry.' }; }
  };
  app.get('/badge/:host', async (c) => {
    const d = await hostData(c, 'badge');
    c.header('Cache-Control', d.r ? 'public, max-age=3600' : 'no-store');
    return c.body(badgeSvg(d.r ? { score: d.r.score, grade: d.r.grade } : { error: true }), 200, { 'content-type': 'image/svg+xml; charset=utf-8' });
  });
  app.get('/r/:host', async (c) => {
    const d = await hostData(c, 'report');
    if (!d.r) return c.html(reportErrorHtml({ message: d.message, status: d.status }), d.status);
    c.header('Cache-Control', 'public, max-age=600');
    return c.html(reportHtml({ origin: origin(c), r: previewView(d.r), url: d.u.href, prices }));
  });

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'audit_website', title: 'Is this website ready for AI agents?', description: `AI-agent readiness audit of a website: score 0-100, grade and verdict across agent access (robots.txt rules for AI bots, bot challenges), readable content (raw HTML, markdown), discovery (llms.txt, sitemap, JSON-LD, meta/OG), agent interfaces (OpenAPI, MCP, A2A agent card, x402) and speed/HTTPS. Free preview tier: score, grade and category scores. The paid x402 endpoints /v1/lite (${prices.lite}) and /v1/audit (${prices.audit}) add the findings, prioritized fixes and ready-to-paste snippets (llms.txt draft, robots.txt lines, JSON-LD).`, inputSchema: { type: 'object', properties: Q.properties, required: ['url'] }, annotations: RO },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agentready', title: 'AgentReady', version: VERSION }, instructions: 'Call audit_website with a URL or domain to see how ready the site is for AI agents (score, grade, category scores). Findings, fixes and snippets are on the paid x402 routes.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/lite`); }
        const raw = m.params?.arguments?.url ?? m.params?.arguments?.domain ?? m.params?.arguments?.site;
        let u; try { u = normalizeTarget(raw); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(u, 'preview'); } catch (e) { return err(`${e?.code || 'checks_incomplete'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const v = previewView(r);
        const cats = Object.entries(v.categories).map(([k, x]) => `${k} ${x.score}/${x.max}`).join(', ');
        const text = `AgentReady ${r.host}: ${v.score}/100 (grade ${v.grade}, ${v.verdict}), confidence ${v.confidence}. ${cats}. ${v.counts.fail} failing and ${v.counts.warn} weak checks${v.sources_failed.length ? `; not checked: ${v.sources_failed.join(', ')}` : ''}.\nFindings, fixes and ready-to-paste snippets: ${origin(c)}/v1/lite?url=${encodeURIComponent(u.href)} (${prices.lite}) or /v1/audit (${prices.audit}), x402 USDC on Base or Solana. Report: ${origin(c)}/r/${r.host}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: { ...v, report: `${origin(c)}/r/${r.host}` }, isError: false });
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
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { url: { type: 'string', required: true, description: Q.properties.url.description } } }, output: r.example },
    }));
    // Validate before payment: a malformed / private URL gets a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readUrl(c);
      if (p.empty) return next();
      if (p.error) return bad(c, ...p.error);
      c.set('target', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of ROUTES) {
    app.on(['GET', 'POST'], r.path, async (c) => {
      const t = c.get('target');
      if (!t) return bad(c, 'provide "url" (GET ?url=https://example.com or POST {"url": "https://example.com"})');
      let res; try { res = await run(t, r.tier); } catch (e) { return fail(c, e); } // >= 400 is never settled
      const body = r.tier === 'lite' ? liteView(res) : { ...res, tier: r.tier };
      return c.json({ ...body, report: `${origin(c)}/r/${res.host}` });
    });
  }
  return app;
}
function usd(price) { return String(price).replace(/^\$/, ''); }
