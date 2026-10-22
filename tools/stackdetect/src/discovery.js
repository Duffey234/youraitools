// Discovery documents: GET /openapi.json (x402scan / agents), GET /.well-known/x402 manifest, logo/favicon.
// Built from the live config so prices and terms can't drift from the 402 challenge. Lists only the paid and preview routes.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
import { CATEGORIES } from './signatures.js';
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="StackDetect"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M32 12l20 10-20 10-20-10z" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linejoin="round"/><path d="M12 32l20 10 20-10" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linejoin="round" opacity=".7"/><path d="M12 42l20 10 20-10" fill="none" stroke="#4ade80" stroke-width="3" stroke-linejoin="round"/></svg>`;

export const OPENAPI_PATHS = ['/v1/detect', '/v1/preview'];
const usd = (price) => String(price).replace(/^\$/, '');
const TECH = { type: 'object', properties: { name: { type: 'string' }, categories: { type: 'array', items: { type: 'string', enum: Object.keys(CATEGORIES) } }, version: { type: ['string', 'null'] }, confidence: { type: 'integer', minimum: 0, maximum: 100 }, evidence: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['header', 'cookie', 'meta', 'script', 'link', 'html', 'ip', 'mx', 'ns', 'txt', 'implied'] }, value: { type: 'string' } } } } } };
export const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string' }, url: { type: 'string' }, final_url: { type: 'string' }, http_status: { type: 'integer' }, content_type: { type: ['string', 'null'] }, title: { type: ['string', 'null'] },
    technology_count: { type: 'integer' }, technologies: { type: 'array', items: TECH }, categories: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    providers: { type: 'object', properties: { email: { type: 'array' }, email_delivery: { type: 'array' }, dns: { type: 'array' }, hosting: { type: 'array' }, verified_saas: { type: 'array' } } },
    headers_seen: { type: 'object' }, dns: { type: ['object', 'null'] }, fetched: { type: 'object' }, engine: { type: 'string' }, scanned_at: { type: 'string', format: 'date-time' }, disclaimer: { type: 'string' },
  },
};
const urlParam = { name: 'url', in: 'query', required: true, schema: { type: 'string', maxLength: 2048 }, description: 'Absolute http(s) URL or bare domain, e.g. https://laravel.com' };
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 } }, required: ['url'] } } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, price, network, payTo, asset }) {
  const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(usd(price)) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] } };
  const responses = { 200: { description: 'Detection result (payment settled)', content: { 'application/json': { schema: DETECT_SCHEMA } } }, 400: { description: 'Invalid or blocked URL (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 422: { description: 'Site error page with nothing detectable, or DNS failure (never charged)' }, 502: { description: 'Site unreachable (never charged)' }, 504: { description: 'Site timed out (never charged)' } };
  const free = (operationId, summary, extra) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' }, 400: { description: 'Invalid URL' }, 429: { description: 'Free tier rate limit' } }, ...extra });
  return {
    openapi: '3.1.0',
    info: {
      title: 'StackDetect', version: VERSION,
      contact: { name: 'StackDetect', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-stackdetect/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Website technology detection (tech stack lookup) for AI agents, lead enrichment and competitor research. One page load plus public DNS: CMS, ecommerce, JS framework, server, CDN/hosting, analytics, ad pixels, live chat, payments, consent, plus email provider, email-sending services, DNS host and verified SaaS. Each technology has categories, version when exposed, confidence and evidence. Informational.',
      'x-guidance': `GET /v1/detect?url=https://example.com or POST {"url": "..."} ($${usd(price)} USDC on Base via x402, charged only on HTTP 200). Free preview (names and categories): /v1/preview?url=.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-stackdetect/' },
    paths: {
      '/v1/detect': {
        get: { operationId: 'detect_stack', summary: 'Technology stack of a website, with versions, confidence, evidence and DNS-based providers', tags: ['paid'], ...pay, parameters: [urlParam], responses },
        post: { operationId: 'detect_stack_post', summary: 'Same as GET, POST {"url": "..."}', tags: ['paid'], ...pay, requestBody: BODY, responses },
      },
      '/v1/preview': { get: free('preview_stack', 'Free: technology names and categories (10/min/IP)', { parameters: [urlParam] }), post: free('preview_stack_post', 'Free: same as GET, POST {"url": "..."}', { requestBody: BODY }) },
    },
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, price }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/detect`],
    instructions: `GET /v1/detect?url=<site> or POST {"url": "<site>"} ($${usd(price)}) returns the site's technology stack (CMS, framework, hosting/CDN, analytics, payments, email/DNS providers) with versions, confidence and evidence. Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free preview: /v1/preview?url=. Full docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
