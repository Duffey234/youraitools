// LeakGuard: stop AI agents leaking secrets. Paid per call over x402 (USDC on Base, Polygon, Arbitrum One or Solana) or
// with a prepaid credits key.
//   GET|POST /v1/lite   PAID $0.005  text (<= 32 KB) -> verdict, findings (type, severity, offsets, masked preview,
//                                     remediation), redacted text
//   GET|POST /v1/scan   PAID $0.02   text or a JSON payload (<= 256 KB) -> lite + findings by JSON path, redacted JSON with
//                                     the same shape, leaked-wallet exposure (public addresses derived from leaked seed
//                                     phrases / private keys + native and USDC balances on Base, Ethereum, Polygon,
//                                     Arbitrum One and Solana) and ordered actions
//   GET|POST /v1/preview free        verdict, counts and max severity only (<= 8 KB, 10/min per IP)
//   POST /mcp                 free   remote MCP (Streamable HTTP, stateless JSON): scan_for_leaks (preview tier)
//   GET  /health  /  /openapi.json  /.well-known/x402  /v1/stats   free
// Inputs are validated before the 402 (bad or oversized input = 400/413, never charged) and are processed in memory only:
// never logged, stored or cached. Only HTTP 200 results are settled.
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
import { liteScan, deepScan, previewScan, InputError, LIMITS, DISCLAIMER, ENGINE_VERSION } from './scan.js';
import { EVM_CHAINS, SOLANA } from './exposure.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_TEXT, LITE_EXAMPLE, SCAN_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-leakguard/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/leakguard';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

// Bazaar resource descriptions: keep each under ~360 chars (CDP rejects long payment payload descriptions).
const DESC = {
  lite: 'Find and redact leaked secrets before an AI agent sends text to an LLM, tool or webhook: crypto seed phrases (BIP39 checksum), EVM/Solana private keys, WIF, xprv, API keys (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack...), JWT, PEM, cards, IBAN, SSN, email, phone. Verdict, findings and redacted text.',
  scan: 'Deep leak scan of text or a JSON payload: findings by JSON path, redacted JSON, remediation steps, and for leaked seed phrases or private keys the wallet addresses they control with native and USDC balances on Base, Ethereum, Polygon, Arbitrum and Solana (funds at risk now?).',
};
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', example: LITE_EXAMPLE, returns: 'Verdict (WALLET_KEY_EXPOSED / SECRETS_FOUND / PII_FOUND / CLEAN), safe_to_send, findings with type, severity, offsets, masked preview and remediation, redacted text.' },
  { tier: 'scan', path: '/v1/scan', key: 'priceScan', example: SCAN_EXAMPLE, returns: 'Everything in lite, plus JSON payloads (findings by path, redacted_json), leaked-wallet exposure (derived public addresses, native + USDC balances on 5 chains, funds_at_risk / used_empty / no_funds_found / unknown) and ordered actions.' },
];
// Compact example for the Bazaar declaration (PAYMENT-REQUIRED header) on /v1/scan: every top-level field, arrays cut to 1 item,
// maps of >8 objects cut to 3, long strings shortened. The full example stays in the v1 402 body and OpenAPI. Keeps the header < 8 KB.
export function compactExample(v, key = '') {
  if (Array.isArray(v)) return v.slice(0, 1).map((x) => compactExample(x));
  if (typeof v === 'string') return v.length > 80 && key !== 'disclaimer' ? `${v.slice(0, 77)}...` : v;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    const keep = keys.length > 8 && keys.every((k) => v[k] && typeof v[k] === 'object') ? keys.slice(0, 3) : keys;
    return Object.fromEntries(keep.map((k) => [k, compactExample(v[k], k)]));
  }
  return v;
}
const Q = { properties: { text: { type: 'string', description: 'Text to check before it is sent (prompt, tool arguments, log, message, file content). POST /v1/scan also accepts {"json": <any JSON payload>}.' }, style: { type: 'string', enum: ['label', 'mask'], description: 'label: [REDACTED:type] (default); mask: keep the last 4 digits / email domain for PII' }, types: { type: 'string', description: 'Optional comma-separated finding types or categories to report (wallet_key, secret, pii, email, ...)' }, min_severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } }, required: ['text'] };

export function routesConfig(cfg) {
  const out = {};
  for (const r of ROUTES) {
    const pub = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${r.path}` } : {};
    const base = { ...pub, accepts: { scheme: 'exact', price: cfg[r.key], network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 }, description: DESC[r.tier], mimeType: 'application/json', ...ROUTE_META };
    const output = { example: r.tier === 'scan' ? compactExample(r.example) : r.example };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: { text: EXAMPLE_TEXT }, inputSchema: Q, output }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { text: EXAMPLE_TEXT }, inputSchema: Q, output }) } };
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
const MAX_BODY = { preview: LIMITS.previewBytes * 2 + 2048, lite: LIMITS.liteBytes * 2 + 2048, scan: LIMITS.scanBytes * 2 + 4096 };
const TEXT_MAX = { preview: LIMITS.previewBytes, lite: LIMITS.liteBytes, scan: LIMITS.scanBytes };

/**
 * @param {object} [opts] payTo, priceLite/priceScan, network, facilitatorUrl, publicUrl, facilitatorClient (tests), stats,
 *   freeLimiter, v1FetchImpl, dataFetch (tests: balance RPCs), staticSupported, syncFacilitatorOnStart, cdpDeps
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
  const dataFetch = opts.dataFetch || ((...a) => globalThis.fetch(...a));
  const fail = (c, e) => {
    if (e instanceof InputError) return c.json({ error: e.code, message: `${e.message}. Not charged.` }, e.status);
    console.warn(`leakguard: ${e?.name || 'error'} ${String(e?.message || '').slice(0, 120)}`); c.header('Retry-After', '10'); // never logs the input
    return c.json({ error: 'checks_incomplete', message: 'The scan did not finish in time. Not charged; please retry.', sources_failed: ['timeout'], charged: false }, 503);
  };
  const prices = { lite: `$${usd(cfg.priceLite)}`, scan: `$${usd(cfg.priceScan)}` };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'LeakGuard',
    description: 'Stop AI agents leaking secrets. Before an agent sends text or a JSON payload to an LLM, tool, log or webhook, LeakGuard finds and redacts crypto wallet keys (BIP39 seed phrases with checksum, EVM and Solana private keys, WIF, xprv), API secrets (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack, Telegram, npm, JWT, PEM, credentialed URLs, password= assignments) and PII (Luhn-checked cards, IBAN, SSN, email, phone, IP). The deep scan also tells you which wallet a leaked key controls and whether it holds funds right now on Base, Ethereum, Polygon, Arbitrum One or Solana. Paid per call over x402 or with prepaid credits; free preview and remote MCP. Inputs are never logged or stored.',
    paid: ROUTES.map((r) => ({ tier: r.tier, methods: ['GET', 'POST'], path: r.path, param: 'text', price: cfg[r.key], returns: r.returns, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] })),
    payTo: cfg.payTo,
    free: ['/health', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { methods: ['GET', 'POST'], path: PREVIEW_PATH, limit: `10 requests/min per IP, text up to ${LIMITS.previewBytes} bytes`, returns: 'verdict, safe_to_send, max severity, counts by type and category; no positions, no redacted text' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['scan_for_leaks'], limit: '10 tool calls/min per IP (preview tier)' },
      local: { npm: '@agentgate-builder/leakguard', note: 'the same detection engine runs locally and offline (library + stdio MCP), zero dependencies' },
    },
    limits: { previewBytes: LIMITS.previewBytes, liteBytes: LIMITS.liteBytes, scanBytes: LIMITS.scanBytes, jsonStrings: LIMITS.jsonStrings, addressesChecked: LIMITS.maxAddresses },
    engine: ENGINE_VERSION,
    exposureSources: { evm: Object.fromEntries(Object.entries(EVM_CHAINS).map(([k, v]) => [k, v.rpcs.map((u) => new URL(u).host)])), solana: SOLANA.rpcs.map((u) => new URL(u).host) },
    policy: { privacy: 'inputs are processed in memory for the duration of the request only: never logged, stored, cached or forwarded; only public addresses derived from leaked keys are sent to public RPCs (deep scan)', charging: 'only HTTP 200 results are settled; invalid or oversized input (400/413) is free', failClosed: 'when a balance lookup fails or times out the wallet is reported as "unknown" (assume funds at risk), listed in sources_failed, and confidence is low; it is never reported as empty' },
    disclaimer: DISCLAIMER,
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
    const probe = async (name, url, body) => { const t0 = Date.now(); try { const r = await withDeadline(dataFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 6000, name); const j = await r.json().catch(() => null); const okBody = Array.isArray(body) ? Array.isArray(j) && j.length === body.length && j.every((x) => x.result !== undefined) : j?.result !== undefined; return [name, { status: r.status, ok: r.ok && okBody, ms: Date.now() - t0 }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
    const jobs = []; // the same request shapes the scan uses: a JSON-RPC batch (EVM) and getMultipleAccounts (Solana)
    const zero = '0x0000000000000000000000000000000000000001';
    for (const [k, ch] of Object.entries(EVM_CHAINS)) for (const u of ch.rpcs) jobs.push(probe(`${k}_${new URL(u).host}`, u, [{ jsonrpc: '2.0', id: 0, method: 'eth_getBalance', params: [zero, 'latest'] }, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [zero, 'latest'] }]));
    for (const u of SOLANA.rpcs) jobs.push(probe(`solana_${new URL(u).host}`, u, { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [['11111111111111111111111111111111'], { encoding: 'jsonParsed' }] }));
    return c.json({ ok: true, engine: ENGINE_VERSION, sources: Object.fromEntries(await Promise.all(jobs)) });
  });
  const disc = (c) => ({ origin: origin(c), cfg, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });

  /** Read the input from ?text= or a JSON / text body. { empty } = no input at all (discovery probe -> 402 on paid routes). */
  async function readInput(c, tier) {
    const q = (k) => c.req.query(k);
    let raw = {}; let fromBody = false;
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      const tooBig = [`body larger than ${MAX_BODY[tier]} bytes for this tier (text limit ${TEXT_MAX[tier]} bytes)`, 413, 'too_large'];
      if (len > MAX_BODY[tier]) return { error: tooBig };
      const text = await c.req.text();
      if (text.length > MAX_BODY[tier]) return { error: tooBig };
      const ct = (c.req.header('content-type') || '').toLowerCase();
      if (text.trim()) {
        fromBody = true;
        if (/json/.test(ct) || (!ct.startsWith('text/') && /^\s*\{/.test(text))) {
          let b; try { b = JSON.parse(text); } catch { return { error: ['body must be JSON: {"text": "..."} (or send Content-Type: text/plain with the raw text)'] }; }
          if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: ['body must be a JSON object: {"text": "..."}'] };
          if (!Object.keys(b).length) return { empty: true, error: ['"text" is required, e.g. {"text": "..."}'] };
          raw = b;
        } else raw = { text };
      }
    }
    const pick = (k) => (fromBody && raw[k] !== undefined ? raw[k] : q(k));
    const input = { text: pick('text'), json: fromBody ? raw.json : undefined };
    const options = { style: pick('style'), types: pick('types'), min_severity: pick('min_severity') };
    if ((input.text === undefined || input.text === '') && input.json === undefined) {
      if (fromBody) return { error: [tier === 'scan' ? '"text" or "json" is required' : '"text" is required'] };
      return { empty: true, error: ['"text" is required, e.g. ?text=... or POST {"text": "..."}'] };
    }
    if (input.json !== undefined && tier !== 'scan') return { error: ['"json" payloads are scanned by /v1/scan; send {"text": "..."} here'] };
    if (input.json !== undefined && input.text !== undefined) return { error: ['send either "text" or "json", not both'] };
    if (input.text !== undefined && typeof input.text !== 'string') return { error: ['"text" must be a string'] };
    // validate sizes and options now (before any payment): run the cheap checks of the engine wrappers
    try {
      if (input.text !== undefined) { const n = new TextEncoder().encode(input.text).length; if (n > TEXT_MAX[tier]) throw new InputError(`text is ${n} bytes; this tier accepts at most ${TEXT_MAX[tier]} bytes${tier === 'scan' ? '' : ' (use /v1/scan for up to ' + LIMITS.scanBytes + ')'}`, 413, 'too_large'); }
      if (options.style !== undefined && !['label', 'mask'].includes(options.style)) throw new InputError('"style" must be "label" or "mask"');
      if (options.min_severity !== undefined && !['low', 'medium', 'high', 'critical'].includes(options.min_severity)) throw new InputError('"min_severity" must be low, medium, high or critical');
    } catch (e) { return { error: [e.message, e.status || 400, e.code] }; }
    return { value: { input, options } };
  }

  // ---- free preview ----
  const previewHandler = async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/lite (x402 USDC on Base or Solana, or a prepaid credits key)` }, 429); }
    const p = await readInput(c, 'preview');
    if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
    let r; try { r = await previewScan(p.value.input.text); } catch (e) { return fail(c, e); }
    count(c, 'free_preview');
    c.header('Cache-Control', 'no-store');
    return c.json({ ...r, full: { lite: `${origin(c)}/v1/lite`, scan: `${origin(c)}/v1/scan`, prices, adds: 'positions, masked previews, remediation and the redacted text (lite); JSON payloads by path, redacted JSON and leaked-wallet exposure with live balances on 5 chains (scan)' }, local: 'npx -y @agentgate-builder/leakguard (same engine, offline)' });
  };
  app.get(PREVIEW_PATH, previewHandler);
  app.post(PREVIEW_PATH, previewHandler);

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const TOOLS = [
    { name: 'scan_for_leaks', title: 'Check text for leaked secrets before sending it', description: `Check text BEFORE your agent sends it to an LLM, tool, log or webhook: finds crypto wallet keys (BIP39 seed phrases with checksum, EVM/Solana private keys, WIF, xprv), API secrets (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack, Telegram, npm, JWT, PEM) and PII (cards, IBAN, SSN, email, phone). Free preview tier: verdict, safe_to_send and counts by type (text up to ${LIMITS.previewBytes} bytes). Redacted text: paid x402 endpoint /v1/lite (${prices.lite}); JSON payloads and live balances of wallets whose keys leaked: /v1/scan (${prices.scan}).`, inputSchema: { type: 'object', properties: { text: Q.properties.text }, required: ['text'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'leakguard', title: 'LeakGuard', version: VERSION }, instructions: 'Call scan_for_leaks with the text your agent is about to send to an LLM, tool or webhook. If safe_to_send is false, redact first (paid /v1/lite) or remove the secrets.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/lite`); }
        const text = m.params?.arguments?.text;
        if (typeof text !== 'string' || !text) return err('bad_request: "text" (string) is required');
        let r; try { r = await previewScan(text); } catch (e) { return err(`${e?.code || 'error'}: ${e?.message || e}`); }
        count(c, 'free_mcp');
        const types = Object.entries(r.counts).map(([k, n]) => `${k} x${n}`).join(', ');
        const out = `LeakGuard: ${r.verdict}, safe_to_send ${r.safe_to_send}, max severity ${r.max_severity}${r.total ? `. Found: ${types}` : ''}.${r.total ? `\nRedacted text + remediation: POST ${origin(c)}/v1/lite (${prices.lite}); wallet balances for leaked keys: /v1/scan (${prices.scan}); x402 USDC on Base or Solana.` : ''}`;
        return ok({ content: [{ type: 'text', text: out }], structuredContent: r, isError: false });
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
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { text: { type: 'string', required: true, description: Q.properties.text.description } } }, output: r.example },
    }));
    // Validate before payment: malformed / oversized input gets a 400/413 (never a 402, never charged). No input (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readInput(c, r.tier);
      if (p.empty) return next();
      if (p.error) { count(c, 'bad_request'); return bad(c, ...p.error); }
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
      if (!v) return bad(c, 'provide "text" (GET ?text=... or POST {"text": "..."})');
      let res;
      try {
        res = r.tier === 'lite' ? await liteScan(v.input.text, v.options) : await withDeadline(deepScan(v.input, v.options, { fetchImpl: dataFetch }), BUDGET.workMs, 'scan');
      } catch (e) { return fail(c, e); } // >= 400 is never settled
      c.header('Cache-Control', 'no-store');
      return c.json(res);
    });
  }
  return app;
}
function usd(price) { return String(price).replace(/^\$/, ''); }
