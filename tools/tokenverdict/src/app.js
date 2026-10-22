// TokenVerdict: Base ERC-20 token safety verdicts for agents and apps, paid per call over x402 (USDC on Base).
//   GET|POST /v1/lite?token=    PAID $0.005  verdict, score, reasons, key facts
//   GET|POST /v1/quick?token=   PAID $0.015  full check with evidence (sell simulation + taxes, owner powers, proxy, liquidity/LP,
//                                             holders, verification, age, sources, limits)
//   GET|POST /v1/deep?token=    PAID $0.05   quick + simulations on up to 2 pools, pool table, creation block,
//                                             GeckoTerminal cross-check, creator
//   GET  /v1/preview?token=     free  verdict, score, flag counts (no reasons), 10/min per IP
//   GET  /t/<token>             free  shareable card page (OG tags) + /t/<token>/card.svg; buy the full report in-browser
//   POST /mcp                   free  remote MCP (Streamable HTTP, stateless JSON): check_token (preview tier)
//   GET  /health  /  /openapi.json  /.well-known/x402  /v1/stats  /og/<verdict>.png   free
// Inputs are validated before the 402 (malformed address = 400, never charged). Not-a-contract / not-ERC-20 = 422 and source
// outages = 503 after payment verification: >= 400 is never settled.
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
import { analyzeToken, normalizeToken, previewView, liteView, InputError, DISCLAIMER, LIMITS, ENGINE_VERSION } from './analyze.js';
import { cardFacts, cardHtml, cardSvg, cardErrorHtml } from './card.js';
import { OG_PNG } from './og.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_TOKEN, LITE_EXAMPLE, QUICK_EXAMPLE, DEEP_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-tokenverdict/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/tokenverdict';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

const DESC = {
  lite: 'Base ERC-20 token safety verdict: SAFE / CAUTION / DANGER, score 0-100 and the reasons, from a simulated buy-transfer-sell on the token\'s own pool (honeypot and tax detection), owner powers (mint, blacklist, pause, tax setters, upgradeable proxy, renounced), liquidity, LP burn, holder concentration, verified source and age.',
  quick: 'Full Base ERC-20 token safety report: honeypot / sell simulation with buy, sell and transfer tax and round-trip loss (Uniswap v2/v3/v4, Aerodrome, Pancake), owner powers with function names, proxy and upgrade admin, owner status, liquidity per pool and LP burn, holder concentration, verification, age, data sources and limits, plus SAFE / CAUTION / DANGER and a 0-100 score.',
  deep: 'Deep Base ERC-20 token due diligence: everything in the quick report plus buy-transfer-sell simulations on up to 2 pools (different venues), a table of up to 10 pools (DexScreener plus on-chain Uniswap v2/v3/v4, Aerodrome and PancakeSwap lookups) with liquidity, the contract creation block and a GeckoTerminal cross-check (gt_score, honeypot flag, developer holding).',
};
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', example: LITE_EXAMPLE, returns: 'Verdict, score 0-100, reasons, key facts.' },
  { tier: 'quick', path: '/v1/quick', key: 'priceQuick', example: QUICK_EXAMPLE, returns: 'Full evidence: simulation, taxes, owner powers, proxy, liquidity/LP, holders, age.' },
  { tier: 'deep', path: '/v1/deep', key: 'priceDeep', example: DEEP_EXAMPLE, returns: 'Quick + multi-pool simulation, pool table, creation block, cross-check.' },
];
const Q = { properties: { token: { type: 'string', description: 'Base (chain 8453) ERC-20 contract address, e.g. 0x532f27101965dd16442E59d40670FaF5eBB142E4' } }, required: ['token'] };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: DESC[r.tier], mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.example };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: { token: EXAMPLE_TOKEN }, inputSchema: Q, output }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { token: EXAMPLE_TOKEN }, inputSchema: Q, output }) } };
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

/**
 * @param {object} [opts] payTo, priceLite/priceQuick/priceDeep, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats,
 *   freeLimiter, v1FetchImpl, dataFetch (tests: RPC + HTTP sources), analyze (tests: stub engine), staticSupported, syncFacilitatorOnStart, now, cdpDeps
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
  const engine = opts.analyze || analyzeToken;
  const dataFetch = opts.dataFetch || ((...a) => globalThis.fetch(...a));
  // Short per-isolate cache: free views reuse a result for 5 min, lite/quick for 60 s; deep is always fresh.
  const cache = new Map();
  const run = async (token, tier) => {
    const base = tier === 'deep' ? 'deep' : 'quick';
    const ttl = tier === 'deep' ? 0 : tier === 'preview' || tier === 'card' ? 300000 : 60000;
    const hit = cache.get(`${base}:${token}`);
    if (ttl && hit && now() - hit.at < (hit.r.degraded ? Math.min(ttl, 30000) : ttl)) return hit.r;
    const r = await withDeadline(engine(token, { tier: base, fetchImpl: dataFetch, now: now() }), BUDGET.workMs, 'analysis');
    cache.set(`${base}:${token}`, { at: now(), r }); // degraded results are reused for 30 s at most
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return r;
  };
  const fail = (c, e) => {
    if (e instanceof InputError) { if (e.status >= 500) c.header('Retry-After', '10'); return c.json({ error: e.code, message: e.message }, e.status); }
    console.warn(`tokenverdict: ${e?.message}`); c.header('Retry-After', '10');
    return c.json({ error: 'upstream_unavailable', message: 'Data sources did not answer in time. Not charged; please retry.' }, 503);
  };
  const prices = { lite: `$${atomicToUsd(cfg.priceLite)}`, quick: `$${atomicToUsd(cfg.priceQuick)}`, deep: `$${atomicToUsd(cfg.priceDeep)}` };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'TokenVerdict',
    description: 'Safety check for a Base ERC-20 token before an agent or app interacts with it: honeypot / sell simulation with taxes, owner powers (mint, blacklist, pause, tax changes, upgradeable proxy, renounced), liquidity and LP burn, holder concentration, verified source and age, as SAFE / CAUTION / DANGER with a 0-100 score and reasons. Paid per call over x402; free preview, shareable cards and remote MCP. SAFE is not a guarantee and not financial advice.',
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, param: 'token', price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, '/t/<token>', '/t/<token>/card.svg', MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'verdict, score, confidence, flag counts, liquidity, sellable; no reasons or evidence' },
      card: { method: 'GET', path: '/t/<token>', returns: 'shareable HTML card with Open Graph tags and an SVG card; in-browser x402 purchase of the full report' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_token'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    chain: 'base (eip155:8453)', engine: ENGINE_VERSION,
    policy: { data: 'free public sources only: public Base RPC (eth_call simulation with state overrides; nothing is ever sent on chain), Sourcify, DexScreener, GeckoTerminal', storage: 'results cached in memory for up to 5 minutes; nothing is logged per token', charging: 'only HTTP 200 results are settled; invalid addresses, non-contracts, non-ERC-20s and source outages are free' },
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
    // Data-source reachability from this Worker (status codes only, BRETT as the probe token)
    const t = '0x532f27101965dd16442e59d40670faf5ebb142e4';
    const probe = async (name, url, init) => { const t0 = Date.now(); try { const r = await withDeadline(dataFetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': 'TokenVerdict/0.1 (+https://api.youraitools.co/tokenverdict)', ...(init?.headers || {}) } }), 6000, name); return [name, { status: r.status, ms: Date.now() - t0 }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
    const rpcBody = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }) };
    const res = await Promise.all([
      probe('rpc_publicnode', 'https://base-rpc.publicnode.com', rpcBody), probe('rpc_tenderly', 'https://gateway.tenderly.co/public/base', rpcBody), probe('rpc_blast', 'https://base-mainnet.public.blastapi.io', rpcBody), probe('rpc_meow', 'https://base.meowrpc.com', rpcBody),
      probe('dexscreener', `https://api.dexscreener.com/tokens/v1/base/${t}`), probe('geckoterminal', `https://api.geckoterminal.com/api/v2/networks/base/tokens/${t}/info`),
      probe('sourcify', `https://sourcify.dev/server/v2/contract/8453/${t}`),
    ]);
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

  /** Read the token from ?token= or a JSON / text body. { empty } = no input at all (discovery probe). */
  async function readToken(c) {
    let raw;
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"token": "0x..."}`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"token": "0x..."}`, 413] };
      if (!text.trim()) raw = c.req.query('token');
      else if (/^\s*[{[]/.test(text)) {
        let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"token": "0x..."}'] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object {"token": "0x..."}'] };
        if (!Object.keys(b).length) return { empty: true, error: ['"token" is required, e.g. {"token": "0x..."}'] };
        raw = b.token ?? b.address ?? b.contract;
        if (raw === undefined) return { error: ['"token" is required, e.g. {"token": "0x..."}'] };
      } else raw = text.trim();
    } else raw = c.req.query('token') ?? c.req.query('address');
    if (raw === undefined || raw === null || raw === '') return { empty: true, error: ['"token" is required, e.g. ?token=0x532f27101965dd16442E59d40670FaF5eBB142E4'] };
    if (typeof raw !== 'string') return { error: ['"token" must be a string'] };
    try { return { value: normalizeToken(raw) }; } catch (e) { return { error: [e.message, e.status || 400] }; }
  }

  // ---- free preview ----
  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/lite (x402, USDC on Base)` }, 429); }
    const p = await readToken(c);
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...previewView(r), card: `${origin(c)}/t/${r.token}`, full: { lite: `${origin(c)}/v1/lite?token=${r.token}`, quick: `${origin(c)}/v1/quick?token=${r.token}`, deep: `${origin(c)}/v1/deep?token=${r.token}`, prices, adds: 'reasons (lite); simulation details, taxes, owner powers, proxy, liquidity/LP, holders, age (quick); multi-pool simulation, pool table, creation block, GeckoTerminal cross-check (deep)' } });
  });

  // ---- shareable card ----
  const cardData = async (c) => {
    let token; try { token = normalizeToken(c.req.param('token')); } catch (e) { return { status: 400, message: e.message }; }
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return { status: 429, message: 'Too many free checks from your network this minute. Retry shortly.' }; }
    try { const r = await run(token, 'card'); count(c, 'free_card'); return { f: cardFacts(r) }; } catch (e) { return { status: e instanceof InputError ? e.status : 503, message: e instanceof InputError ? e.message : 'Data sources did not answer in time. Please retry.' }; }
  };
  app.get('/t/:token{0x[0-9a-fA-F]{40}}/card.svg', async (c) => {
    const d = await cardData(c);
    if (!d.f) return c.text(d.message, d.status);
    return c.body(cardSvg(d.f), 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
  });
  app.get('/t/:token', async (c) => {
    const d = await cardData(c);
    if (!d.f) return c.html(cardErrorHtml({ message: d.message, status: d.status }), d.status);
    c.header('Cache-Control', 'public, max-age=300');
    return c.html(cardHtml({ origin: origin(c), f: d.f, prices }));
  });

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'check_token', title: 'Base ERC-20 token safety check', description: `Safety verdict for a Base (chain 8453) ERC-20 token: SAFE / CAUTION / DANGER with a 0-100 score, from a simulated buy-transfer-sell (honeypot and tax detection), owner powers, proxy, liquidity, holders, verification and age. Free preview tier: verdict, score and flag counts. The paid x402 endpoints /v1/lite (${prices.lite}), /v1/quick (${prices.quick}) and /v1/deep (${prices.deep}) add the reasons and evidence. SAFE is not a guarantee and not financial advice.`, inputSchema: { type: 'object', properties: Q.properties, required: ['token'] }, annotations: RO },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tokenverdict', title: 'TokenVerdict', version: VERSION }, instructions: 'Call check_token with a Base ERC-20 contract address before an agent or app interacts with, lists or accepts a token. Returns SAFE / CAUTION / DANGER with a score; reasons and evidence are on the paid x402 routes.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/lite`); }
        const raw = m.params?.arguments?.token ?? m.params?.arguments?.address;
        let token; try { token = normalizeToken(raw); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(token, 'preview'); } catch (e) { return err(`${e?.code || 'upstream_unavailable'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const v = previewView(r);
        const text = `TokenVerdict ${r.symbol || token} (${token}, Base): ${v.verdict} ${v.score}/100, confidence ${v.confidence}. Red flags: ${v.flags.danger}, warnings: ${v.flags.warn}. Sellable: ${v.sellable == null ? 'not simulated' : v.sellable ? 'yes' : 'NO'}. Liquidity: $${v.liquidity_usd}.\nReasons and evidence: ${origin(c)}/v1/lite?token=${token} (${prices.lite}) or /v1/quick (${prices.quick}), x402 USDC on Base. Card: ${origin(c)}/t/${token}\n${DISCLAIMER}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: { ...v, card: `${origin(c)}/t/${token}` }, isError: false });
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
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { token: { type: 'string', required: true, description: Q.properties.token.description } } }, output: r.example },
    }));
    // Validate before payment: a malformed address gets a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readToken(c);
      if (p.empty) return next();
      if (p.error) return bad(c, ...p.error);
      c.set('token', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of ROUTES) {
    app.on(['GET', 'POST'], r.path, async (c) => {
      const t = c.get('token');
      if (!t) return bad(c, 'provide "token" (GET ?token=0x... or POST {"token": "0x..."})');
      let res; try { res = await run(t, r.tier); } catch (e) { return fail(c, e); } // >= 400 is never settled
      const body = r.tier === 'lite' ? liteView(res) : { ...res, tier: r.tier };
      return c.json({ ...body, card: `${origin(c)}/t/${t}` });
    });
  }
  return app;
}
function atomicToUsd(price) { return String(price).replace(/^\$/, ''); }
