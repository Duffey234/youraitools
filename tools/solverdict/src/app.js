// SolVerdict: Solana SPL / Token-2022 token safety verdicts for agents and apps, paid per call over x402
// (USDC on Base or Solana; Polygon and Arbitrum One also accepted) or with a prepaid credits key.
//   GET|POST /v1/lite?mint=    PAID $0.005  verdict, score, reasons, key facts
//   GET|POST /v1/check?mint=   PAID $0.02   full report: mint / freeze authority, Token-2022 extensions (transfer fee, permanent
//                                            delegate, transfer hook, default frozen, pausable, non-transferable), metadata
//                                            authority, DEX pools / liquidity / 24 h buys vs sells, 20 largest holders split
//                                            into wallets vs program accounts (pools, bonding curves, vaults), age
//   GET  /v1/preview?mint=     free  verdict, score, flag counts (no reasons), 10/min per IP
//   GET  /t/<mint>             free  shareable card page (OG tags) + /t/<mint>/card.svg
//   POST /mcp                  free  remote MCP (Streamable HTTP, stateless JSON): check_solana_token (preview tier)
//   GET  /health  /  /openapi.json  /.well-known/x402  /v1/stats  /og/<verdict>.png   free
// Inputs are validated before the 402 (malformed address = 400, never charged). Not-a-mint = 422 and RPC outages = 503 after
// payment verification: >= 400 is never settled.
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
import { analyzeMint as analyzeToken, normalizeMint as normalizeToken, previewView, liteView, InputError, DISCLAIMER, LIMITS, ENGINE_VERSION, RPCS, HOLDER_RPCS } from './sol.js';
import { cardFacts, cardHtml, cardSvg, cardErrorHtml } from './card.js';
import { OG_PNG } from './og.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_TOKEN, LITE_EXAMPLE, CHECK_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-solverdict/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/solverdict';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

const DESC = {
  lite: 'Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. SAFE / CAUTION / DANGER, score 0-100 and reasons: mint and freeze authority, Token-2022 extensions (transfer fee, permanent delegate, transfer hook, default-frozen, pausable), DEX liquidity and 24 h sells, holder concentration and age. SAFE is not a guarantee and not financial advice.',
  check: 'Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. Full report: mint / freeze authority, every Token-2022 extension, metadata update authority, DEX pools, liquidity and 24 h buys vs sells (pump.fun curve aware), 20 largest holders (wallets vs programs), age, sources and limits, plus SAFE / CAUTION / DANGER and a 0-100 score. SAFE is not a guarantee and not financial advice.',
};
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', example: LITE_EXAMPLE, returns: 'Verdict, score 0-100, reasons, key facts.' },
  { tier: 'check', path: '/v1/check', key: 'priceCheck', example: CHECK_EXAMPLE, returns: 'Full evidence: authorities, Token-2022 extensions, metadata, pools/liquidity/sells, holders (wallets vs programs), age.' },
];
const Q = { properties: { mint: { type: 'string', description: 'Solana token mint address (base58), e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 (BONK)' } }, required: ['mint'] };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: DESC[r.tier], mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.example };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: { mint: EXAMPLE_TOKEN }, inputSchema: Q, output }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { mint: EXAMPLE_TOKEN }, inputSchema: Q, output }) } };
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
  // Short per-isolate cache: free views reuse a result for 5 min, paid tiers for 60 s.
  const cache = new Map();
  const run = async (token, tier) => {
    const base = 'check'; // one analysis serves every tier (views differ)
    const ttl = tier === 'preview' || tier === 'card' ? 300000 : 60000;
    const hit = cache.get(`${base}:${token}`);
    if (ttl && hit && now() - hit.at < (hit.r.degraded ? Math.min(ttl, 30000) : ttl)) return hit.r;
    const r = await withDeadline(engine(token, { tier: base, fetchImpl: dataFetch, now: now() }), BUDGET.workMs, 'analysis');
    cache.set(`${base}:${token}`, { at: now(), r }); // degraded results are reused for 30 s at most
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return r;
  };
  const fail = (c, e) => {
    if (e instanceof InputError) { if (e.status >= 500) c.header('Retry-After', '10'); return c.json({ error: e.code, message: e.message }, e.status); }
    console.warn(`solverdict: ${e?.message}`); c.header('Retry-After', '10');
    return c.json({ error: 'upstream_unavailable', message: 'Data sources did not answer in time. Not charged; please retry.' }, 503);
  };
  const prices = { lite: `$${atomicToUsd(cfg.priceLite)}`, check: `$${atomicToUsd(cfg.priceCheck)}` };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'SolVerdict',
    description: 'Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. Checks mint and freeze authority, Token-2022 extensions that can block or tax sells (permanent delegate, transfer hook, transfer fee, default-frozen, pausable), metadata authority, DEX liquidity and 24 h sells, holder concentration (wallets vs pools / bonding curves) and age, as SAFE / CAUTION / DANGER with a 0-100 score and reasons. Paid per call over x402 or with prepaid credits; free preview, shareable cards and remote MCP. SAFE is not a guarantee and not financial advice.',
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, param: 'mint', price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, '/t/<mint>', '/t/<mint>/card.svg', MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '10 requests/min per IP', returns: 'verdict, score, confidence, flag counts, liquidity; no reasons or evidence' },
      card: { method: 'GET', path: '/t/<mint>', returns: 'shareable HTML card with Open Graph tags and an SVG card; in-browser x402 purchase of the full report' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_solana_token'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    chain: 'solana (mainnet-beta) tokens; payment in USDC on Base, Solana, Polygon or Arbitrum One', engine: ENGINE_VERSION,
    policy: { data: 'free public sources only: public Solana RPC (read-only account queries; nothing is ever signed or sent) DexScreener, with the Raydium API v3 and the on-chain pump.fun bonding curve as fallbacks', storage: 'results cached in memory for up to 5 minutes; nothing is logged per token', charging: 'only HTTP 200 results are settled; invalid addresses, non-mint accounts and RPC outages are free' },
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
    // Data-source reachability from this Worker (status codes only, BONK as the probe mint)
    const t = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const probe = async (name, url, init) => { const t0 = Date.now(); try { const r = await withDeadline(dataFetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': 'SolVerdict/0.1 (+https://api.youraitools.co/solverdict)', ...(init?.headers || {}) } }), 6000, name); const j = await r.clone().json().catch(() => null); return [name, { status: r.status, rpc_error: j?.error ? String(j.error.message || j.error.code).slice(0, 60) : undefined, ms: Date.now() - t0 }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
    const body = (method, params) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const res = await Promise.all([
      ...RPCS.map((u) => probe(`rpc_${new URL(u).host}`, u, body('getAccountInfo', [t, { encoding: 'jsonParsed' }]))),
      ...HOLDER_RPCS.map((u) => probe(`holders_${new URL(u).host}`, u, body('getTokenLargestAccounts', [t]))),
      probe('dexscreener', `https://api.dexscreener.com/tokens/v1/solana/${t}`),
      probe('raydium', `https://api-v3.raydium.io/pools/info/mint?mint1=${t}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=1&page=1`),
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
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"mint": "<base58>"}`, 413] };
      const text = await c.req.text();
      if (text.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; send {"mint": "<base58>"}`, 413] };
      if (!text.trim()) raw = c.req.query('mint') ?? c.req.query('token');
      else if (/^\s*[{[]/.test(text)) {
        let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"mint": "<base58 mint>"}'] }; }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object {"mint": "<base58 mint>"}'] };
        if (!Object.keys(b).length) return { empty: true, error: ['"mint" is required, e.g. {"mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}'] };
        raw = b.mint ?? b.token ?? b.address;
        if (raw === undefined) return { error: ['"mint" is required, e.g. {"mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}'] };
      } else raw = text.trim();
    } else raw = c.req.query('mint') ?? c.req.query('token') ?? c.req.query('address');
    if (raw === undefined || raw === null || raw === '') return { empty: true, error: ['"mint" is required, e.g. ?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'] };
    if (typeof raw !== 'string') return { error: ['"mint" must be a string'] };
    try { return { value: normalizeToken(raw) }; } catch (e) { return { error: [e.message, e.status || 400] }; }
  }

  // ---- free preview ----
  app.get(PREVIEW_PATH, async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/lite (x402 USDC on Base or Solana, or a prepaid credits key)` }, 429); }
    const p = await readToken(c);
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await run(p.value, 'preview'); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...previewView(r), card: `${origin(c)}/t/${r.mint}`, full: { lite: `${origin(c)}/v1/lite?mint=${r.mint}`, check: `${origin(c)}/v1/check?mint=${r.mint}`, prices, adds: 'reasons and key facts (lite); authorities, Token-2022 extensions, metadata, pools, 24 h sells, holders split wallets vs programs, age (check)' } });
  });

  // ---- shareable card ----
  const cardData = async (c) => {
    let token; try { token = normalizeToken(c.req.param('token')); } catch (e) { return { status: 400, message: e.message }; }
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return { status: 429, message: 'Too many free checks from your network this minute. Retry shortly.' }; }
    try { const r = await run(token, 'card'); count(c, 'free_card'); return { f: cardFacts(r) }; } catch (e) { return { status: e instanceof InputError ? e.status : 503, message: e instanceof InputError ? e.message : 'Data sources did not answer in time. Please retry.' }; }
  };
  app.get('/t/:token{[1-9A-HJ-NP-Za-km-z]{32,44}}/card.svg', async (c) => {
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
    { name: 'check_solana_token', title: 'Solana token safety check', description: `Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. SAFE / CAUTION / DANGER with a 0-100 score, from mint and freeze authority, Token-2022 extensions that can block or tax sells, liquidity and recent sells, holder concentration and age. Free preview tier: verdict, score and flag counts. The paid x402 endpoints /v1/lite (${prices.lite}) and /v1/check (${prices.check}) add the reasons and evidence. SAFE is not a guarantee and not financial advice.`, inputSchema: { type: 'object', properties: Q.properties, required: ['mint'] }, annotations: RO },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'solverdict', title: 'SolVerdict', version: VERSION }, instructions: 'Call check_solana_token with a Solana token mint address before an agent or app interacts with, lists or accepts a token. Returns SAFE / CAUTION / DANGER with a score; reasons and evidence are on the paid x402 routes.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/lite`); }
        const raw = m.params?.arguments?.mint ?? m.params?.arguments?.token ?? m.params?.arguments?.address;
        let token; try { token = normalizeToken(raw); } catch (e) { return err(`bad_request: ${e.message}`); }
        let r; try { r = await run(token, 'preview'); } catch (e) { return err(`${e?.code || 'upstream_unavailable'}: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const v = previewView(r);
        const text = `SolVerdict ${r.symbol || token} (${token}, Solana): ${v.verdict} ${v.score}/100, confidence ${v.confidence}. Red flags: ${v.flags.danger}, warnings: ${v.flags.warn}. Liquidity: $${v.liquidity_usd ?? 'n/a'}.\nReasons and evidence: ${origin(c)}/v1/lite?mint=${token} (${prices.lite}) or /v1/check (${prices.check}), x402 USDC on Base or Solana. Card: ${origin(c)}/t/${token}\n${DISCLAIMER}`;
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
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { mint: { type: 'string', required: true, description: Q.properties.mint.description } } }, output: r.example },
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
      if (!t) return bad(c, 'provide "mint" (GET ?mint=<base58> or POST {"mint": "<base58>"})');
      let res; try { res = await run(t, r.tier); } catch (e) { return fail(c, e); } // >= 400 is never settled
      const body = r.tier === 'lite' ? liteView(res) : { ...res, tier: r.tier };
      return c.json({ ...body, card: `${origin(c)}/t/${t}` });
    });
  }
  return app;
}
function atomicToUsd(price) { return String(price).replace(/^\$/, ''); }
