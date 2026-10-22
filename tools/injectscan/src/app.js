// InjectScan: prompt-injection scanner for text an AI agent is about to read. Paid per call over x402 ($0.003 USDC on Base).
//   GET  /v1/scan?text=  | ?url=                 PAID  full scan (up to 100k chars); url= fetches the page (SSRF-safe, robots.txt)
//   POST /v1/scan {text} | {url} | {tools:[...]}  PAID  same, plus MCP tool-definition scanning (tool poisoning)
//   GET|POST /v1/scan/preview  {text}             free  text up to 2,000 chars, 10/min per IP
//   POST /mcp                                     free  remote MCP (Streamable HTTP, stateless JSON), tool scan_text (preview size)
//   GET  /v1/rules  /v1/stats  /health  /  /openapi.json  /.well-known/x402   free
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
import { openapiDoc, wellKnownX402, LOGO_SVG } from './discovery.js';
import { scanText, scanPage, scanTools } from './scanner.js';
import { RULES, CATEGORIES, RULESET_VERSION } from './rules.js';
import { THRESHOLDS } from './detect.js';

export const PAID_PATH = '/v1/scan';
export const PREVIEW_PATH = '/v1/scan/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const RULES_PATH = '/v1/rules';
export const VERSION = '0.1.4';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

// Discovery example: deliberately benign. Bazaar/CDP screen listing metadata for agent-directed instructions and replay
// example inputs, so no attack strings here (the detector tests cover those).
export const EXAMPLE_TEXT = 'Please summarize this article about solar panels.';
export const OUTPUT_EXAMPLE = {
  input: 'text', risk_score: 0, verdict: 'safe', flagged: false,
  categories: [],
  findings: [],
  hidden: { zero_width: 0, bom_soft_hyphen: 0, bidi_controls: 0, unicode_tags: 0, homoglyph_words: 0 },
  decoded: [], chars_scanned: 49, truncated: false, ruleset: RULESET_VERSION, ms: 1,
};
const DESCRIPTION = 'Prompt-injection scan for text your AI agent is about to read (web pages, emails, tool output, MCP tool descriptions): risk score 0-100, verdict, categories and exact spans. Detects instruction overrides, jailbreak personas, system-prompt extraction, fake chat delimiters, data-exfiltration URLs, tool hijacking, hidden Unicode and encoded payloads. Deterministic rules, no data stored.';
const QUERY_SCHEMA = {
  properties: {
    text: { type: 'string', description: 'Text to scan (GET: up to ~8 KB in the query string; POST JSON for longer text, up to 100,000 characters)' },
    url: { type: 'string', description: 'Instead of text: absolute http(s) URL of a public page to fetch and scan (visible text plus hidden HTML)' },
  },
};
const BODY_SCHEMA = {
  properties: {
    text: { type: 'string', description: 'Text to scan, up to 100,000 characters' },
    url: { type: 'string', description: 'Absolute http(s) URL of a public page to fetch and scan' },
    tools: { type: 'array', description: 'MCP / function-calling tool definitions ({name, description, inputSchema}) to check for tool poisoning, up to 100', items: { type: 'object' } },
  },
};

export function routesConfig({ price, network, payTo, publicUrl }) {
  const resource = publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${PAID_PATH}` } : {};
  const common = { accepts: { scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 }, description: DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  return {
    [`GET ${PAID_PATH}`]: { ...resource, ...common, extensions: { ...declareDiscoveryExtension({ input: { text: EXAMPLE_TEXT }, inputSchema: QUERY_SCHEMA, output: { example: OUTPUT_EXAMPLE } }) } },
    [`POST ${PAID_PATH}`]: { ...resource, ...common, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { text: EXAMPLE_TEXT }, inputSchema: BODY_SCHEMA, output: { example: OUTPUT_EXAMPLE } }) } },
  };
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400) => c.json({ error: 'bad_request', message }, status);

/**
 * @param {object} [opts] payTo, price, network, facilitatorUrl, publicUrl, facilitatorClient (tests), reader (tests),
 *   fetchImpl (tests), dns (default true), statsKv, stats, freeLimiter, v1FetchImpl, syncFacilitatorOnStart, workMs
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const reader = opts.reader || new Reader({ fetchImpl: opts.fetchImpl, dns: opts.dns ?? true, limits: { maxBytes: cfg.maxBytes, maxHtmlChars: cfg.maxHtmlChars, timeoutMs: cfg.timeoutMs, blockedHosts: cfg.blockedHosts } });
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
    name: 'InjectScan',
    description: 'Prompt-injection scanner for AI agents: score text, web pages and MCP tool definitions before your agent reads them. Paid per call over x402; free preview and remote MCP.',
    paid: { methods: ['GET', 'POST'], path: PAID_PATH, price: cfg.price, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
    free: ['/health', PREVIEW_PATH, MCP_PATH, RULES_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { methods: ['GET', 'POST'], path: PREVIEW_PATH, limit: '10 requests/min per IP', accepts: `text up to ${cfg.previewChars} characters (full result)` },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['scan_text'], limit: '10 tool calls/min per IP' },
      rules: { method: 'GET', path: RULES_PATH }, stats: { method: 'GET', path: STATS_PATH },
    },
    limits: { maxScanChars: cfg.maxScanChars, maxTools: cfg.maxTools, previewChars: cfg.previewChars, url: { maxBytes: cfg.maxBytes, timeoutMs: cfg.timeoutMs } },
    detector: { ruleset: RULESET_VERSION, rules: RULES.length, categories: Object.keys(CATEGORIES), thresholds: THRESHOLDS, model: 'none (deterministic rules; see /v1/rules and the benchmark in the repo)' },
    policy: { storage: 'inputs are not stored or logged', charging: 'only HTTP 200 results are settled; invalid input, blocked URLs and fetch failures are free', urlFetch: 'robots.txt respected (InjectScanBot), private/reserved IPs and non-http(s) schemes refused' },
    source: 'https://agentgate-source.pages.dev/x402-prompt-injection-scan/',
    guide: 'https://youraitools.co/guides/prompt-injection-scanner-api',
    allTools: 'https://youraitools.co/built-by-us',
    mcpRegistry: 'io.github.agentgate-builder/x402-prompt-injection-scan',
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true }));
  const disc = (c) => ({ origin: origin(c), price: cfg.price, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc({ ...disc(c), exampleText: EXAMPLE_TEXT, exampleOutput: OUTPUT_EXAMPLE })); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });
  app.get(RULES_PATH, (c) => { c.header('Cache-Control', 'public, max-age=3600'); return c.json({ ruleset: RULESET_VERSION, thresholds: THRESHOLDS, categories: CATEGORIES, scoring: 'Each matching rule contributes its weight; rules of one category combine by noisy-OR, then categories combine by noisy-OR. Rules under 0.3 are weak and together add at most 0.3. Instructions found in hidden HTML get +0.15.', rules: RULES.map((r) => ({ id: r.id, category: r.category, weight: r.weight, description: r.description, pattern: r.re.source, caseSensitive: !!r.cs })), hidden: ['hidden.unicode_tags (0.8)', 'hidden.zero_width (0.1-0.45 by count)', 'hidden.bidi_controls (0.2-0.4)', 'hidden.homoglyphs (0.2-0.45)', 'hidden.instructions_in_hidden_html (0.5)', 'obfuscation.leetspeak (0.4)', 'encoded.<base64|hex|escaped>_instructions (0.5-0.9)'] }); });

  // ---- input parsing ----
  async function readInput(c, { preview }) {
    let body = {};
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      const ct = c.req.header('content-type') || '';
      try {
        if (ct.includes('application/json')) body = await c.req.json();
        else { const t = await c.req.text(); if (t.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] }; body = { text: t }; }
      } catch { return { error: ['body must be JSON: {"text": "..."} or {"url": "..."} or {"tools": [...]}'] }; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: ['body must be a JSON object'] };
    } else {
      body = { text: c.req.query('text'), url: c.req.query('url') };
    }
    const given = ['text', 'url', 'tools'].filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
    // No input at all (e.g. an empty JSON object {} from a discovery probe): flagged so the paid route answers with the 402 terms.
    const empty = !given.length && !Object.keys(body).some((k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
    if (given.length !== 1) return { empty, error: [preview ? 'provide "text" (string, up to 2,000 characters)' : 'provide exactly one of "text" (string), "url" (http(s) URL) or "tools" (array of tool definitions)'] };
    const kind = given[0];
    if (preview && kind !== 'text') return { error: [`the free preview scans text only; url= and tools= are on the paid endpoint ${PAID_PATH}`] };
    if (kind === 'text' && typeof body.text !== 'string') return { error: ['"text" must be a string'] };
    if (kind === 'url' && typeof body.url !== 'string') return { error: ['"url" must be a string'] };
    if (kind === 'tools' && (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > cfg.maxTools)) return { error: [`"tools" must be an array of 1-${cfg.maxTools} tool definitions`] };
    if (preview && body.text.length > cfg.previewChars) return { error: [`the free preview accepts up to ${cfg.previewChars} characters (got ${body.text.length}); longer text: ${PAID_PATH} (${cfg.price} USDC, x402)`, 413] };
    return { kind, value: body[kind] };
  }

  async function runScan(c, kind, value) {
    if (kind === 'text') return { ok: true, r: scanText(value, { maxChars: cfg.maxScanChars }) };
    if (kind === 'tools') return { ok: true, r: scanTools(value, { maxChars: cfg.maxScanChars }) };
    try {
      const page = await withDeadline(reader.read(value, { maxChars: cfg.maxScanChars, includeRaw: true }), opts.workMs ?? BUDGET.workMs, 'fetch');
      return { ok: true, r: scanPage(page, { maxChars: cfg.maxScanChars }) };
    } catch (e) {
      if (e instanceof DeadlineError) return { ok: false, status: 504, body: { error: 'timeout', message: `${e.message}; not charged` } };
      if (e instanceof FetchError) { if (e.code?.startsWith('robots')) count(c, 'robots_blocked'); return { ok: false, status: e.status, body: { error: e.code || 'fetch_error', message: e.message } }; }
      return { ok: false, status: 502, body: { error: 'fetch_failed', message: String(e.message || e).slice(0, 200) } };
    }
  }

  const previewHandler = async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `Free preview is limited per IP per minute. Unlimited scans: ${origin(c)}${PAID_PATH} (${cfg.price} USDC, x402)` }, 429); }
    const inp = await readInput(c, { preview: true });
    if (inp.error) return bad(c, ...inp.error);
    const res = await runScan(c, 'text', inp.value);
    count(c, 'free_preview');
    return c.json({ ...res.r, tier: 'free', full: { url: `${origin(c)}${PAID_PATH}`, price: `${cfg.price} USDC on Base (x402)`, adds: 'text up to 100,000 characters, url= page scans (visible + hidden HTML), tools= MCP tool-poisoning scans' } });
  };
  app.get(PREVIEW_PATH, previewHandler);
  app.post(PREVIEW_PATH, previewHandler);

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const TOOL = {
    name: 'scan_text', title: 'Scan text for prompt injection',
    description: `Check text your agent is about to read (a web page, email, document, tool result or another agent's message) for prompt injection before acting on it. Returns risk_score 0-100, verdict (safe | suspicious | malicious), categories and the exact matching spans. Free tier: up to ${cfg.previewChars} characters; longer text, URLs and MCP tool definitions via the paid x402 endpoint.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: `Text to scan (up to ${cfg.previewChars} characters on the free tier)` } }, required: ['text'] },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'injectscan', title: 'InjectScan', version: VERSION }, instructions: 'scan_text scores untrusted content (web pages, emails, tool output) for prompt injection. Verdicts: "safe", "suspicious" (worth a review) or "malicious" (likely an attack).' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: [TOOL] });
      case 'tools/call': {
        if (m.params?.name !== 'scan_text') return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return ok({ isError: true, content: [{ type: 'text', text: `Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${PAID_PATH}` }] }); }
        const text = m.params?.arguments?.text;
        if (typeof text !== 'string' || !text) return ok({ isError: true, content: [{ type: 'text', text: 'bad_request: "text" (string) is required' }] });
        if (text.length > cfg.previewChars) return ok({ isError: true, content: [{ type: 'text', text: `bad_request: the free tier scans up to ${cfg.previewChars} characters (got ${text.length}). Longer text: ${origin(c)}${PAID_PATH} (${cfg.price} USDC, x402)` }] });
        const r = scanText(text, { maxChars: cfg.previewChars });
        count(c, 'free_mcp');
        const top = r.findings.slice(0, 8).map((f) => `- ${f.category} (${f.rule}) at ${f.start}-${f.end}: "${(f.text || '').slice(0, 80)}"`).join('\n');
        const summary = `InjectScan: ${r.verdict.toUpperCase()} (risk ${r.risk_score}/100)${r.categories.length ? `\nCategories: ${r.categories.map((x) => `${x.category} ${x.score}`).join(', ')}` : ''}${top ? `\nFindings:\n${top}` : ''}`;
        return ok({ content: [{ type: 'text', text: summary }], structuredContent: r, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid route ----
  app.use(PAID_PATH, paidRouteStats(stats));
  const v1 = x402v1({
    path: PAID_PATH, amount: String(Math.round(Number(String(cfg.price).replace('$', '')) * 1e6)), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
    description: DESCRIPTION, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
    outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { text: { type: 'string', required: false, description: QUERY_SCHEMA.properties.text.description }, url: { type: 'string', required: false, description: QUERY_SCHEMA.properties.url.description } } }, output: OUTPUT_EXAMPLE },
  });
  // Validate before payment so malformed requests get a 400 instead of a 402 (and are never charged).
  app.use(PAID_PATH, async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
    // No input at all: answer with the 402 terms (discovery probes call the bare URL); the handler then 400s unpaid-safe.
    const q = c.req.method === 'GET' ? (c.req.query('text') || c.req.query('url')) : (c.req.header('content-length') !== '0');
    if (!q) return next();
    const inp = await readInput(c, { preview: false });
    if (inp.empty) return next(); // {} or an empty body: same as the bare URL (402 terms; the handler 400s if paid without input)
    if (inp.error) return bad(c, ...inp.error);
    c.set('scanInput', inp);
    return next();
  });
  app.use(v1.middleware);
  app.use(v1.skipIfV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  const paid = async (c) => {
    const inp = c.get('scanInput');
    if (!inp) return bad(c, 'provide exactly one of "text", "url" or "tools" (GET ?text= / ?url=, or POST JSON)'); // never settled (400)
    const { kind, value } = inp;
    const res = await runScan(c, kind, value);
    if (!res.ok) return c.json(res.body, res.status); // >= 400 is never settled
    return c.json(res.r);
  };
  app.get(PAID_PATH, paid);
  app.post(PAID_PATH, paid);
  return app;
}
