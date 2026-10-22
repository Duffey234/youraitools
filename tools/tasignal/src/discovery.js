// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges. Lists the paid routes and the free preview.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
import { ROUTES, PREVIEW, NAME, DESCRIPTION, SOURCE_URL, DISCLAIMER } from './tool.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = ROUTES;
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const params = (schema) => Object.entries(schema.properties).map(([name, s]) => ({ name, in: 'query', required: (schema.required || []).includes(name), schema: { type: s.type === 'integer' ? 'integer' : s.type, ...(s.enum ? { enum: s.enum } : {}) }, description: s.description }));
const body = (schema) => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: schema.properties, ...(schema.required?.length ? { required: schema.required } : {}) } } } });

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, cfg, asset }) {
  const paths = {};
  for (const r of ROUTES) {
    const price = cfg[r.key];
    const responses = { 200: { description: `${r.returns} (payment settled)`, content: { 'application/json': { example: r.example } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 404: { description: 'Symbol not listed (never charged)' }, 503: { description: 'Data sources unavailable: upstream_unavailable with sources_failed (never charged)' } };
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, description: r.desc, tags: ['paid'], ...pay, parameters: params(r.schema), responses },
      post: { operationId: `${r.op}_post`, summary: `Same as GET, POST ${JSON.stringify(r.input)}`, tags: ['paid'], ...pay, requestBody: body(r.schema), responses },
    };
  }
  paths[PREVIEW.path] = { get: { operationId: `${NAME.toLowerCase()}_preview`, summary: `Free: ${PREVIEW.returns}, 10/min per IP`, security: [], parameters: params(PREVIEW.schema), responses: { 200: { description: 'OK' }, 400: { description: 'Invalid input' }, 429: { description: 'Free tier rate limit' }, 503: { description: 'Data sources unavailable' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: NAME, version: VERSION,
      contact: { name: NAME, email: 'hello@youraitools.co', url: SOURCE_URL },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: `${DESCRIPTION} ${DISCLAIMER}`,
      'x-guidance': `${ROUTES.map((r) => `GET ${r.path}?${new URLSearchParams(r.input)} ($${usd(cfg[r.key])})`).join('; ')}. POST the same fields as JSON. USDC via x402 (Base, Polygon, Arbitrum One, Solana), charged only on HTTP 200. Free: ${PREVIEW.path}?${new URLSearchParams(PREVIEW.input)}.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: SOURCE_URL },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `${DESCRIPTION} Routes: ${ROUTES.map((r) => `${r.path}?${new URLSearchParams(r.input)} ($${usd(cfg[r.key])})`).join(', ')}. Paid in USDC via x402 v2 (PAYMENT-SIGNATURE; Base, Solana, Polygon, Arbitrum One) or v1 (X-PAYMENT, Base), or a prepaid credits key (Authorization: Bearer yatc_...). ${DISCLAIMER}`,
    openapi: `${origin}/openapi.json`,
  };
}
