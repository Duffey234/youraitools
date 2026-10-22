// Discovery documents: GET /openapi.json (x402scan / agents), GET /.well-known/x402 manifest, logo/favicon.
// Built from the live config so prices and terms can't drift from the 402 challenge.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="PayGuard"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M32 10l17 6v13c0 11-7.5 20-17 24-9.5-4-17-13-17-24V16z" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linejoin="round"/><path d="M24 32.5l6 6 11-12" fill="none" stroke="#4ade80" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const OPENAPI_PATHS = ['/v1/address', '/v1/batch', '/v1/preview'];
const usd = (price) => String(price).replace(/^\$/, '');
const MATCH = { type: 'object', properties: { entity: { type: 'string' }, entity_type: { type: 'string' }, sdn_uid: { type: 'integer' }, programs: { type: 'array', items: { type: 'string' } }, list_date: { type: ['string', 'null'], format: 'date' }, listed_currency: { type: 'string' }, listed_as: { type: 'string' } } };
export const ADDRESS_SCHEMA = {
  type: 'object',
  properties: {
    input: { type: 'string' }, address: { type: 'string', description: 'Lookup key (EVM hex and bech32 lower-cased)' },
    sanctioned: { type: 'boolean' }, match_count: { type: 'integer' }, matches: { type: 'array', items: MATCH },
    chain: { type: 'object', description: 'format, guess, candidates, checksum (eip55 | base58check | bech32 | cashaddr | null), checksum_valid (true | false | null), checksum_address' },
    source: { type: 'string' }, source_url: { type: 'string' }, list_updated_at: { type: 'string', format: 'date' }, list_age_days: { type: 'integer' },
    sdn_address_count: { type: 'integer' }, disclaimer: { type: 'string' },
  },
};
const BATCH_SCHEMA = { type: 'object', properties: { count: { type: 'integer' }, sanctioned_count: { type: 'integer' }, any_sanctioned: { type: 'boolean' }, results: { type: 'array', items: ADDRESS_SCHEMA }, list_updated_at: { type: 'string' }, disclaimer: { type: 'string' } } };
const free = (operationId, summary, extra = {}) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' }, 429: { description: 'Free tier rate limit' } }, ...extra });

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, priceAddress, priceBatch, network, payTo, asset }) {
  const pay = (price) => ({ 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(usd(price)) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] } });
  const responses = (schema, what) => ({ 200: { description: `${what} (payment settled)`, content: { 'application/json': { schema } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' } });
  const qp = [{ name: 'address', in: 'query', required: true, schema: { type: 'string', maxLength: 140 }, description: 'Blockchain address (EVM 0x, bc1 / 1 / 3, T..., Solana, Litecoin, XMR ...)' }];
  const body = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } } } };
  const batchBody = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { addresses: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } }, required: ['addresses'] } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'PayGuard', version: VERSION,
      contact: { name: 'PayGuard', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-payguard/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Sanctions screening of crypto addresses for AI agents and payment flows. Exact match against every digital currency address in the official US Treasury OFAC SDN list (EVM case-insensitive), with SDN entity name, programs and list date, plus a chain guess and checksum validity. Informational screening, not legal advice.',
      'x-guidance': `GET /v1/address?address=<addr> ($${usd(priceAddress)}) returns sanctioned true/false with any SDN matches; POST /v1/batch {"addresses": [...]} screens up to 50 ($${usd(priceBatch)}). USDC on Base via x402, charged only on HTTP 200. Free preview: /v1/preview?address=<addr>.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-payguard/' },
    paths: {
      '/v1/address': {
        get: { operationId: 'screen_address', summary: 'OFAC SDN screen of one crypto address (matches, programs, list date, chain, checksum)', tags: ['paid'], ...pay(priceAddress), parameters: qp, responses: responses(ADDRESS_SCHEMA, 'Screening result') },
        post: { operationId: 'screen_address_post', summary: 'OFAC SDN screen of one address (POST {"address"})', tags: ['paid'], ...pay(priceAddress), requestBody: body, responses: responses(ADDRESS_SCHEMA, 'Screening result') },
      },
      '/v1/batch': { post: { operationId: 'screen_batch', summary: 'OFAC SDN screen of up to 50 addresses', tags: ['paid'], ...pay(priceBatch), requestBody: batchBody, responses: responses(BATCH_SCHEMA, 'Batch result') } },
      '/v1/preview': { get: free('screen_preview', 'Free sanctioned true/false + chain guess (10/min/IP)', { parameters: qp }), post: free('screen_preview_post', 'Free preview (POST {"address"})') },
    },
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, priceAddress, priceBatch }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/address`, `${origin}/v1/batch`],
    instructions: `GET /v1/address?address=0x... ($${usd(priceAddress)}) returns an OFAC SDN screening result for one crypto address; POST /v1/batch {"addresses": [...]} covers up to 50 ($${usd(priceBatch)}). Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free preview: /v1/preview. Full docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
