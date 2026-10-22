// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges (x402fix). Lists the paid routes and the free preview.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = [
  { path: '/v1/lite', key: 'priceLite', op: 'x402fix_lite', summary: 'Grade and fix list for one paid x402 URL: transport (GET/HEAD/empty POST/CORS), v2 header, v1 body, accepts, multichain, Bazaar declaration' },
  { path: '/v1/check', key: 'priceCheck', op: 'x402fix_check', summary: 'Lite + CDP validate verdict and Bazaar index status, discovery docs, payee checks, generated extensions.bazaar block, multichain accepts and snippet' },
  { path: '/v1/site', key: 'priceSite', op: 'x402fix_site', summary: 'Whole origin: paid routes from /.well-known/x402 and /openapi.json (up to 8), grade and top fixes per route, discovery-doc drift' },
];
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const params = [
  { name: 'url', in: 'query', required: true, schema: { type: 'string', format: 'uri' }, description: 'Full https URL of the paid x402 route (site: origin or API base URL)' },
  { name: 'method', in: 'query', required: false, schema: { type: 'string', enum: ['GET', 'POST'] }, description: 'Method your paid route uses (default from its Bazaar declaration)' },
  { name: 'framework', in: 'query', required: false, schema: { type: 'string', enum: ['hono', 'express', 'next'], default: 'hono' }, description: 'Framework for the generated snippet (check tier)' },
];
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(params.map((p) => [p.name, p.schema])), required: ['url'] } } } };
const FIX = { type: 'object', properties: { n: { type: 'integer' }, severity: { type: 'string', enum: ['error', 'warn'] }, id: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } };
export const RESULT_SCHEMA = { type: 'object', properties: { url: { type: 'string' }, tier: { type: 'string' }, method: { type: 'string' }, grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] }, score: { type: 'integer' }, status: { type: 'string', enum: ['pass', 'ok_with_warnings', 'fix_needed', 'broken'] }, summary: { type: 'string' }, counts: { type: 'object' }, x402: { type: 'object' }, probes: { type: 'object' }, fixes: { type: 'array', items: FIX }, checks: { type: 'array', items: { type: 'object' } }, cdp: { type: ['object', 'null'] }, generated: { type: 'object' }, routes: { type: 'array' }, missing_data: { type: 'array', items: { type: 'string' } }, limits: { type: 'array', items: { type: 'string' } }, disclaimer: { type: 'string' }, checked_at: { type: 'string', format: 'date-time' } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, cfg, asset }) {
  const responses = { 200: { description: 'Report (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA } } }, 400: { description: 'Invalid or private URL (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 503: { description: 'Check did not finish (never charged)' } };
  const paths = {};
  for (const r of PAID_ROUTES) {
    const price = cfg[r.key];
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, tags: ['paid'], ...pay, parameters: params, responses },
      post: { operationId: `${r.op}_post`, summary: 'Same as GET, POST {"url": "https://api.example.com/v1/data"}', tags: ['paid'], ...pay, requestBody: BODY, responses },
    };
  }
  paths['/v1/preview'] = { get: { operationId: 'x402fix_preview', summary: 'Free: grade, score, status and counts (no fixes), 10/min per IP', security: [], parameters: params, responses: { 200: { description: 'OK' }, 400: { description: 'Invalid input' }, 429: { description: 'Free tier rate limit' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'x402fix', version: VERSION,
      contact: { name: 'x402fix', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-x402fix/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'x402 endpoint doctor for sellers: probes a paid x402 URL unpaid (GET, HEAD, empty POST, POST {}, CORS preflight; never pays) and returns a grade A-F, a numbered fix list and every check: v2 PAYMENT-REQUIRED header, v1 body, accepts (canonical USDC, EIP-712 domain, Solana feePayer, atomic amounts, payTo), multichain consistency and the Bazaar declaration validated against its own JSON Schema. The check tier adds the CDP facilitator validate verdict and index status, discovery-doc consistency, payee checks and a generated, self-validated extensions.bazaar block with multichain accepts. The site tier audits up to 8 paid routes of an origin.',
      'x-guidance': `GET /v1/lite|check|site?url=https://... or POST {"url": "https://..."} ($${usd(cfg.priceLite)} / $${usd(cfg.priceCheck)} / $${usd(cfg.priceSite)} USDC via x402, charged only on HTTP 200). Free: /v1/preview?url=.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-x402fix/' },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: PAID_ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `x402 endpoint doctor. GET ${PAID_ROUTES.map((r) => `${r.path} ($${usd(cfg[r.key])})`).join(', ')} with ?url=<paid x402 URL> (site: origin). Returns grade A-F, status, fix list and checks; never pays the target. Paid in USDC via x402 v2 (PAYMENT-SIGNATURE) or v1 on Base (X-PAYMENT); only HTTP 200 results are settled. Free: /v1/preview?url=. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
