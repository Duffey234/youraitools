// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges. Lists the paid routes and the free preview.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = [
  { path: '/v1/lite', key: 'priceLite', op: 'agent_readiness_lite', summary: 'Score 0-100, grade, verdict, category scores, top 5 fixes, AI bots blocked' },
  { path: '/v1/audit', key: 'priceAudit', op: 'agent_readiness_audit', summary: 'Full audit: 23 checks with evidence, robots.txt matrix for 17 AI bots, prioritized fixes, ready-to-paste snippets (llms.txt draft, robots lines, JSON-LD, meta tags, mcp.json, agent card)' },
];
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const urlParam = { name: 'url', in: 'query', required: true, schema: { type: 'string', maxLength: 2048 }, description: 'Website URL or domain (public http/https), e.g. https://example.com or stripe.com' };
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 } }, required: ['url'] } } } };
const CHECK = { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string' }, status: { type: 'string', enum: ['pass', 'warn', 'fail', 'unknown'] }, points: { type: 'number' }, max: { type: 'number' }, detail: { type: 'string' }, evidence: { type: 'object' } } };
const FIX = { type: 'object', properties: { check: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, points_gain: { type: 'number' }, title: { type: 'string' }, how: { type: 'string' }, finding: { type: 'string' } } };
export const RESULT_SCHEMA = { type: 'object', properties: { url: { type: 'string' }, final_url: { type: 'string' }, host: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 100 }, grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] }, verdict: { type: 'string', enum: ['agent_ready', 'partially_ready', 'not_ready'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, categories: { type: 'object' }, counts: { type: 'object' }, checks: { type: 'array', items: CHECK }, top_issues: { type: 'array' }, fixes: { type: 'array', items: FIX }, snippets: { type: 'object', description: 'llms_txt, robots_txt, json_ld, meta_tags, markdown, mcp_json, agent_card (only for checks that need them)' }, robots: { type: 'object' }, sources_failed: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } }, checked_at: { type: 'string', format: 'date-time' } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, cfg, asset }) {
  const responses = { 200: { description: 'Audit (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA } } }, 400: { description: 'Invalid, private or internal URL (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 422: { description: 'Host does not resolve or resolves to a private address (never charged)' }, 503: { description: 'checks_incomplete: the site could not be fetched (never charged)' } };
  const paths = {};
  for (const r of PAID_ROUTES) {
    const price = cfg[r.key];
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, tags: ['paid'], ...pay, parameters: [urlParam], responses },
      post: { operationId: `${r.op}_post`, summary: 'Same as GET, POST {"url": "https://example.com"}', tags: ['paid'], ...pay, requestBody: BODY, responses },
    };
  }
  paths['/v1/preview'] = { get: { operationId: 'agent_readiness_preview', summary: 'Free: score, grade, category scores and counts (no findings or fixes), 10/min per IP', security: [], parameters: [urlParam], responses: { 200: { description: 'OK' }, 400: { description: 'Invalid URL' }, 429: { description: 'Free tier rate limit' }, 503: { description: 'Site could not be fetched' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentReady', version: VERSION,
      contact: { name: 'AgentReady', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-agentready/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Is this website ready for AI agents? Audits robots.txt rules for 17 AI crawlers and agents (GPTBot, ClaudeBot, ChatGPT-User, Claude-User, PerplexityBot, Google-Extended...), WAF / bot challenges, content in the raw HTML without JavaScript, markdown (Accept: text/markdown), llms.txt and llms-full.txt, sitemap, schema.org JSON-LD, meta / canonical / Open Graph, OpenAPI, MCP (discovery and a live initialize), A2A agent card / agents.json / ai-plugin.json, x402, HTTPS / HSTS, speed and accessibility basics. Returns a 0-100 score, grade A-F, prioritized fixes and ready-to-paste snippets. Fail-closed: checks whose source fails are "unknown", score 0 and are listed in sources_failed. Pay with x402 (USDC on Base, Solana, Polygon or Arbitrum One) or a prepaid credits key (Authorization: Bearer).',
      'x-guidance': `GET /v1/lite|audit?url=<site> or POST {"url": "<site>"} ($${usd(cfg.priceLite)} / $${usd(cfg.priceAudit)} USDC via x402, charged only on HTTP 200). Free: /v1/preview?url=, the report page /r/<host> and the badge /badge/<host>.svg.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-agentready/' },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: PAID_ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `Website AI-agent readiness audits. GET ${PAID_ROUTES.map((r) => `${r.path} ($${usd(cfg[r.key])})`).join(', ')} with ?url=<site>. Returns score 0-100, grade, verdict and fixes; audit adds all 23 checks with evidence, a robots.txt matrix for 17 AI bots and ready-to-paste snippets (llms.txt, robots lines, JSON-LD, meta tags). Paid in USDC via x402 v2 (PAYMENT-SIGNATURE; Base, Solana, Polygon, Arbitrum One) or v1 (X-PAYMENT, Base), or with a prepaid credits key; only HTTP 200 results are settled. Free: /v1/preview?url= and /r/<host>. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
