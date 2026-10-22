// DomainCheck: domain and email trust checks for AI agents. Paid per call over x402 (USDC on Base).
//   GET|POST /v1/domain?domain=   PAID $0.002  full report: DNS, MX, SPF/DMARC/DKIM/MTA-STS/BIMI, DNSSEC, RDAP age + registrar, flags, score
//   GET|POST /v1/email?email=     PAID $0.001  syntax, disposable/role/free, MX + mail auth, domain age, verdict + score (no SMTP probing)
//   GET|POST /v1/domain/preview   free  DNS-only summary (no RDAP, no score), 10/min per IP
//   GET|POST /v1/email/preview    free  syntax + disposable / role / free-provider lists (no network), 10/min per IP
//   POST /mcp                     free  remote MCP (Streamable HTTP, stateless JSON): check_domain, check_email (preview tier)
//   GET  /v1/flags  /v1/stats  /health  /  /openapi.json  /.well-known/x402   free
import { Hono } from 'hono';
import { getDomain } from 'tldts';
import { cors } from 'hono/cors';
import { x402ResourceServer } from '@x402/hono';
import { paymentMiddleware } from './credits-gate.js'; // @x402/hono paymentMiddleware + prepaid credits keys (no key: unchanged x402)
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { multiNetworkRoutes, registerNetworks, supportedKinds, discoveryNetworks, networkStats } from './networks.js';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { ROUTE_META } from './service-meta.js';
import { ResilientFacilitatorClient } from './facilitator.js';
import { selectFacilitator } from './facilitator-select.js';
import { DEFAULTS, USER_AGENT } from './config.js';
import { Stats, paidRouteStats, isSmoke, waitUntilOf } from './stats.js';
import { x402v1 } from './x402v1.js';
import { prefersHtml, landingHtml } from './landing.js';
import { withDeadline, DeadlineError, BUDGET } from './deadline.js';
import { openapiDoc, wellKnownX402, LOGO_SVG } from './discovery.js';
import { checkDomain, checkEmail, FLAGS, ENGINE_VERSION } from './check.js';
import { DohResolver } from './dns.js';
import { Rdap } from './rdap.js';
import { normalizeDomain, parseEmail, DISPOSABLE_COUNT } from './email.js';
import { DOMAIN_EXAMPLE, EMAIL_EXAMPLE } from './examples.js';

export const DOMAIN_PATH = '/v1/domain';
export const EMAIL_PATH = '/v1/email';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const FLAGS_PATH = '/v1/flags';
export const VERSION = '0.1.3';
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-domain-check/';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const DOMAIN_DESCRIPTION = 'Domain trust report for AI agents: is this domain real, how old is it, who registered it, and is its email locked down? DNS (A/AAAA/NS/MX/CAA), DNSSEC, SPF, DMARC, DKIM (common selectors), MTA-STS, TLS-RPT, BIMI, RDAP registration date + registrar + status, parking and disposable detection, risk flags, 0-100 score and verdict. Public DNS + RDAP, no data stored.';
export const EMAIL_DESCRIPTION = 'Email address check for AI agents (signups, outreach, fraud screening): RFC syntax, disposable / role / free-provider detection, MX and null-MX, SPF/DMARC of the domain, domain age via RDAP, parking, verdict (valid | risky | undeliverable | invalid) and 0-100 score. No SMTP probing, no data stored.';
const DOMAIN_Q = { properties: { domain: { type: 'string', description: 'Domain name, URL or email address, e.g. "example.com" (IDN allowed)' } }, required: ['domain'] };
const EMAIL_Q = { properties: { email: { type: 'string', description: 'Email address to check, e.g. "jane@example.com"' } }, required: ['email'] };

export function routesConfig({ priceDomain, priceEmail, network, payTo, publicUrl }) {
  const pub = (path) => (publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${path}` } : {});
  const acc = (price) => ({ scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 });
  const d = { ...pub(DOMAIN_PATH), accepts: acc(priceDomain), description: DOMAIN_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  const e = { ...pub(EMAIL_PATH), accepts: acc(priceEmail), description: EMAIL_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  return {
    [`GET ${DOMAIN_PATH}`]: { ...d, extensions: { ...declareDiscoveryExtension({ input: { domain: 'example.com' }, inputSchema: DOMAIN_Q, output: { example: DOMAIN_EXAMPLE } }) } },
    [`POST ${DOMAIN_PATH}`]: { ...d, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { domain: 'example.com' }, inputSchema: DOMAIN_Q, output: { example: DOMAIN_EXAMPLE } }) } },
    [`GET ${EMAIL_PATH}`]: { ...e, extensions: { ...declareDiscoveryExtension({ input: { email: 'jane.doe+news@gmail.com' }, inputSchema: EMAIL_Q, output: { example: EMAIL_EXAMPLE } }) } },
    [`POST ${EMAIL_PATH}`]: { ...e, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { email: 'jane.doe+news@gmail.com' }, inputSchema: EMAIL_Q, output: { example: EMAIL_EXAMPLE } }) } },
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
 * @param {object} [opts] payTo, priceDomain, priceEmail, network, facilitatorUrl, publicUrl, facilitatorClient (tests),
 *   fetchImpl (tests: DoH + RDAP), statsKv, stats, freeLimiter, v1FetchImpl, staticSupported, syncFacilitatorOnStart, workMs
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const engine = { resolver: opts.resolver || new DohResolver({ fetchImpl: opts.fetchImpl }), rdap: opts.rdap || new Rdap({ fetchImpl: opts.fetchImpl, userAgent: USER_AGENT }) };
  const stats = opts.stats || new Stats(opts.statsKv);
  const fac = selectFacilitator(cfg, opts.cdpDeps); // FACILITATOR=payai|cdp; cdp without keys falls back to PayAI
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme); // extra networks from networks.js (Base registered above, unchanged)
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };
  const workMs = opts.workMs ?? BUDGET.workMs;

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'DomainCheck',
    description: 'Domain and email trust checks for AI agents: is this domain real and how old is it, is its email locked down, is this address disposable or undeliverable? Paid per call over x402; free preview and remote MCP.',
    paid: [
      { methods: ['GET', 'POST'], path: DOMAIN_PATH, param: 'domain', price: cfg.priceDomain, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
      { methods: ['GET', 'POST'], path: EMAIL_PATH, param: 'email', price: cfg.priceEmail, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
    ],
    free: ['/health', `${DOMAIN_PATH}/preview`, `${EMAIL_PATH}/preview`, MCP_PATH, FLAGS_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      domainPreview: { methods: ['GET', 'POST'], path: `${DOMAIN_PATH}/preview`, limit: '10 requests/min per IP', returns: 'DNS, MX, SPF and DMARC (no RDAP age, DKIM, MTA-STS or score)' },
      emailPreview: { methods: ['GET', 'POST'], path: `${EMAIL_PATH}/preview`, limit: '10 requests/min per IP', returns: 'syntax, disposable, role and free-provider flags (no DNS, no score)' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_domain', 'check_email'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    data: { dns: 'DNS over HTTPS (Cloudflare 1.1.1.1, Google fallback)', registration: 'RDAP via the IANA bootstrap registry', disposableDomains: DISPOSABLE_COUNT, engine: ENGINE_VERSION },
    policy: { storage: 'inputs are not stored or logged', charging: 'only HTTP 200 results are settled; invalid input and lookup timeouts are free', smtp: 'no SMTP / mailbox probing' },
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: 'https://www.npmjs.com/package/@agentgate-builder/domaincheck',
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true }));
  const disc = (c) => ({ origin: origin(c), priceDomain: cfg.priceDomain, priceEmail: cfg.priceEmail, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });
  app.get(FLAGS_PATH, (c) => { c.header('Cache-Control', 'public, max-age=3600'); return c.json({ engine: ENGINE_VERSION, scoring: 'score = 100 minus the penalties of all raised flags (floor 0); nonexistent domain or invalid syntax = 0. Domain verdict: >=70 low_risk, 40-69 medium_risk, <40 high_risk. Email verdict: undeliverable (no domain / no MX / null MX), risky (disposable or score <70), else valid.', flags: Object.fromEntries(Object.entries(FLAGS).map(([k, [severity, penalty, description]]) => [k, { severity, penalty, description }])) }); });

  // ---- input parsing ----
  async function readParam(c, name) {
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('content-length') || 0);
      if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      const raw = await c.req.text(); // cached by Hono, safe to read again
      if (raw.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes`, 413] };
      if (!raw.trim()) return { empty: true, error: [`"${name}" (string) is required`] };
      let body;
      if ((c.req.header('content-type') || '').includes('application/json') || /^\s*[{[]/.test(raw)) {
        try { body = JSON.parse(raw); } catch { return { error: [`body must be JSON: {"${name}": "..."}`] }; }
      } else body = { [name]: raw.trim() };
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: ['body must be a JSON object'] };
      const v = body[name];
      // An empty JSON object ({}) is a discovery probe, same as a bare URL: answer with the 402 terms.
      if (v === undefined && !Object.keys(body).length) return { empty: true, error: [`"${name}" (string) is required`] };
      if (typeof v !== 'string' || !v.trim()) return { error: [`"${name}" (string) is required`] };
      return { value: v.trim() };
    }
    const v = c.req.query(name);
    if (v === undefined) return { empty: true, error: [`?${name}= is required`] };
    if (!v.trim()) return { error: [`?${name}= is required`] };
    return { value: v.trim() };
  }
  const validDomain = (v) => { const h = normalizeDomain(v); return h && getDomain(h, { allowPrivateDomains: false }) ? null : `"${String(v).slice(0, 100)}" is not a valid domain name (or is a public suffix)`; };

  async function run(kind, value, tier) {
    try {
      const r = await withDeadline(kind === 'domain' ? checkDomain(value, { ...engine, tier }) : checkEmail(value, { ...engine, tier }), workMs, 'lookup');
      if (r.error) return { ok: false, status: r.status || 400, body: { error: r.error, message: r.message } };
      return { ok: true, r };
    } catch (e) {
      if (e instanceof DeadlineError) return { ok: false, status: 504, body: { error: 'timeout', message: `${e.message}; not charged` } };
      return { ok: false, status: 502, body: { error: 'lookup_failed', message: String(e.message || e).slice(0, 200) } };
    }
  }

  // ---- free previews ----
  const preview = (kind, name) => async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `Free preview is limited per IP per minute. Unlimited: ${origin(c)}/v1/${kind} (x402, USDC on Base)` }, 429); }
    const p = await readParam(c, name);
    if (p.error) return bad(c, ...p.error);
    if (kind === 'domain') { const err = validDomain(p.value); if (err) return bad(c, err); }
    const res = await run(kind, p.value, 'preview');
    if (!res.ok) return c.json(res.body, res.status);
    count(c, 'free_preview');
    const paidUrl = `${origin(c)}/v1/${kind}`;
    return c.json({ ...res.r, full: { url: paidUrl, price: `${kind === 'domain' ? cfg.priceDomain : cfg.priceEmail} USDC on Base (x402)`, adds: kind === 'domain' ? 'RDAP registration age, registrar and status, parking detection, DKIM / MTA-STS / TLS-RPT / BIMI / CAA, mail grade, 0-100 score and verdict' : 'MX / null MX, SPF and DMARC of the domain, RDAP domain age, parking, 0-100 score and verdict (valid | risky | undeliverable)' } });
  };
  app.get(`${DOMAIN_PATH}/preview`, preview('domain', 'domain')); app.post(`${DOMAIN_PATH}/preview`, preview('domain', 'domain'));
  app.get(`${EMAIL_PATH}/preview`, preview('email', 'email')); app.post(`${EMAIL_PATH}/preview`, preview('email', 'email'));

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const TOOLS = [
    { name: 'check_domain', title: 'Check a domain (DNS + email auth)', description: 'Check a domain before your agent trusts a link, a sender or a counterparty: does it exist, where does its mail go, SPF and DMARC policy, nameservers, DNSSEC. Free tier (preview). For registration age, registrar, parking detection and a 0-100 risk score use the paid x402 endpoint /v1/domain.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain, URL or email address' } }, required: ['domain'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
    { name: 'check_email', title: 'Check an email address (syntax + disposable)', description: 'Check an email address an agent is about to store, email or trust: syntax, disposable / throwaway provider, role account, free webmail. Free tier (no network). For MX, mail auth, domain age and a verdict (valid | risky | undeliverable) use the paid x402 endpoint /v1/email.', inputSchema: { type: 'object', properties: { email: { type: 'string', description: 'Email address' } }, required: ['email'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
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
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'domaincheck', title: 'DomainCheck', version: VERSION }, instructions: 'check_domain reports whether a domain exists, how old it is and how its email is configured; check_email reports whether an address is valid, disposable or undeliverable.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (name !== 'check_domain' && name !== 'check_email') return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}/v1/${name === 'check_domain' ? 'domain' : 'email'}`); }
        const key = name === 'check_domain' ? 'domain' : 'email';
        const value = m.params?.arguments?.[key];
        if (typeof value !== 'string' || !value.trim()) return err(`bad_request: "${key}" (string) is required`);
        if (key === 'domain') { const e = validDomain(value); if (e) return err(`bad_request: ${e}`); }
        const res = await run(key, value.trim(), 'preview');
        if (!res.ok) return err(`${res.body.error}: ${res.body.message}`);
        count(c, 'free_mcp');
        const r = res.r;
        const flags = (r.flags || []).map((f) => `- ${f.id} (${f.severity})${f.detail ? `: ${f.detail}` : ''}`).join('\n');
        const summary = key === 'domain'
          ? `DomainCheck ${r.domain}: ${r.exists ? 'exists' : 'DOES NOT EXIST'}; mail: ${r.email.accepts_mail ? `accepts (${r.email.mx_provider})` : 'no mail'}; SPF ${r.email.spf.present ? r.email.spf.policy : 'missing'}; DMARC ${r.email.dmarc.present ? r.email.dmarc.policy : 'missing'}; DNSSEC ${r.dns.dnssec_validated ? 'yes' : 'no'}${flags ? `\nFlags:\n${flags}` : ''}\nRegistration age, parking and risk score: ${origin(c)}${DOMAIN_PATH} (${cfg.priceDomain} USDC, x402)`
          : `DomainCheck ${r.input}: syntax ${r.syntax.valid ? 'valid' : `INVALID (${r.syntax.reason})`}${r.syntax.valid ? `; disposable ${r.disposable ? 'YES' : 'no'}; role ${r.role ? 'yes' : 'no'}; free provider ${r.free_provider ? 'yes' : 'no'}` : ''}${flags ? `\nFlags:\n${flags}` : ''}\nMX, mail auth, domain age and verdict: ${origin(c)}${EMAIL_PATH} (${cfg.priceEmail} USDC, x402)`;
        return ok({ content: [{ type: 'text', text: summary }], structuredContent: r, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid routes ----
  const routes = [
    { path: DOMAIN_PATH, kind: 'domain', price: cfg.priceDomain, description: DOMAIN_DESCRIPTION, example: DOMAIN_EXAMPLE, q: DOMAIN_Q },
    { path: EMAIL_PATH, kind: 'email', price: cfg.priceEmail, description: EMAIL_DESCRIPTION, example: EMAIL_EXAMPLE, q: EMAIL_Q },
  ];
  const v1s = [];
  for (const r of routes) {
    app.use(r.path, paidRouteStats(stats, r.kind));
    v1s.push(x402v1({
      path: r.path, amount: atomic(r.price), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
      description: r.description, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { [r.kind]: { type: 'string', required: true, description: r.q.properties[r.kind].description } } }, output: r.example },
    }));
    // Validate before payment: malformed requests get a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      const p = await readParam(c, r.kind);
      if (p.empty) return next(); // bare URL: answer with the 402 terms; the handler 400s (never settled) if paid without input
      if (p.error) return bad(c, ...p.error);
      if (r.kind === 'domain') { const e = validDomain(p.value); if (e) return bad(c, e); }
      if (r.kind === 'email') { const s = parseEmail(p.value); if (!s.valid_syntax) return c.json({ error: 'invalid_email', message: `not a valid email address: ${s.reason}; not charged`, input: s.input, verdict: 'invalid', syntax: { valid: false, reason: s.reason } }, 422); }
      c.set('checkInput', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of routes) {
    const paid = async (c) => {
      const v = c.get('checkInput');
      if (!v) return bad(c, `provide "${r.kind}" (GET ?${r.kind}= or POST JSON {"${r.kind}": "..."})`);
      const res = await run(r.kind, v, 'full');
      if (!res.ok) return c.json(res.body, res.status); // >= 400 is never settled
      return c.json(res.r);
    };
    app.get(r.path, paid); app.post(r.path, paid);
  }
  return app;
}
