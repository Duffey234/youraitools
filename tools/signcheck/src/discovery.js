// Discovery documents: GET /openapi.json (x402scan / agents), GET /.well-known/x402 manifest, logo/favicon.
// Built from the live config so prices and terms can't drift from the 402 challenge. Lists only the paid and preview routes.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="SignCheck"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M32 10l18 7v13c0 11-7.5 19.5-18 24-10.5-4.5-18-13-18-24V17z" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linejoin="round"/><path d="M23 33l6 6 12-13" fill="none" stroke="#4ade80" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const OPENAPI_PATHS = ['/v1/check', '/v1/lite', '/v1/preview'];
const usd = (price) => String(price).replace(/^\$/, '');
const FLAG = { type: 'object', properties: { code: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, message: { type: 'string' } } };
export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string' }, verdict: { type: 'string', enum: ['SAFE', 'CAUTION', 'DANGER'] }, risk_score: { type: 'integer', minimum: 0, maximum: 100 },
    kind: { type: 'string', enum: ['transaction', 'typed_data', 'eip7702_authorization', 'x402_payment'] }, action: { type: 'string' }, summary: { type: 'string' },
    chain: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
    flags: { type: 'array', items: FLAG },
    counterparties: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, label: { type: ['string', 'null'] }, type: { type: 'string', enum: ['eoa', 'contract', 'eip7702_delegated_eoa'] }, sanctioned: { type: 'object' } } } },
    decoded: { type: 'array' }, x402: { type: 'object' },
    onchain: { type: 'object', properties: { available: { type: 'boolean' }, block: { type: ['integer', 'null'] }, tokens: { type: 'array' }, simulation: { type: ['object', 'null'] }, selector_names: { type: ['object', 'null'] } } },
    sanctions: { type: 'object' }, engine: { type: 'string' }, checked_at: { type: 'string', format: 'date-time' }, disclaimer: { type: 'string' },
  },
};
const any = { oneOf: [{ type: 'object' }, { type: 'string' }] };
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
  chain: { type: 'string', description: 'base (default), ethereum, base-sepolia or a numeric chain id' },
  tx: { type: 'object', properties: { to: { type: 'string' }, data: { type: 'string' }, value: { type: 'string' }, from: { type: 'string' } }, required: ['to'] },
  typed_data: { type: 'object', description: 'EIP-712 {domain, types, primaryType, message}' },
  authorization: { type: 'object', description: 'EIP-7702 {address, chainId, nonce}' },
  payment_required: { ...any, description: 'x402 PAYMENT-REQUIRED header (base64) or {accepts:[…]}' },
  payment_payload: { ...any, description: 'x402 PAYMENT-SIGNATURE / X-PAYMENT (base64) or JSON' },
} } } } };
const qp = (name, description, required = false) => ({ name, in: 'query', required, schema: { type: 'string' }, description });
const QUERY = [qp('to', 'tx.to (or use POST for typed data / x402)'), qp('data', 'tx.data, 0x hex'), qp('value', 'tx.value in wei'), qp('from', 'tx.from (enables simulation)'), qp('chain', 'base | ethereum | base-sepolia | chain id'), qp('typed_data', 'EIP-712 JSON (URL-encoded)'), qp('payment_required', 'x402 PAYMENT-REQUIRED header value'), qp('payment_payload', 'x402 PAYMENT-SIGNATURE header value')];

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, price, litePrice = '$0.005', network, payTo, asset }) {
  const payFor = (price) => ({ 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(usd(price)) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] } });
  const pay = payFor(price); const payLite = payFor(litePrice);
  const responses = { 200: { description: 'Check result (payment settled)', content: { 'application/json': { schema: CHECK_SCHEMA } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 413: { description: 'Body too large (never charged)' }, 503: { description: 'Chain RPC unavailable (never charged)' }, 504: { description: 'Timed out (never charged)' } };
  const free = (operationId, summary, extra) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' }, 400: { description: 'Invalid input' }, 429: { description: 'Free tier rate limit' } }, ...extra });
  return {
    openapi: '3.1.0',
    info: {
      title: 'SignCheck', version: VERSION,
      contact: { name: 'SignCheck', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-signcheck/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Pre-sign safety check for AI agent wallets. Decodes a transaction, an EIP-712 signature request (EIP-2612 Permit, Permit2 allowance and transfer, EIP-3009 TransferWithAuthorization as used by x402, Seaport orders), an EIP-7702 delegation, or an x402 payment (402 terms + the payload about to be sent) into plain English, and returns SAFE / CAUTION / DANGER with risk flags: unlimited or EOA approvals, setApprovalForAll, fake USDC / Permit2 domains, x402 overpay / wrong payTo / wrong asset, ownership and proxy changes, OFAC SDN counterparties. The paid tier adds on-chain facts (EOA vs contract, token metadata) and an eth_call simulation on Base, Ethereum or Base Sepolia. Read-only, informational.',
      'x-guidance': `POST /v1/check with {"tx": {"to","data","value","from"}} or {"typed_data": {...}} or {"payment_required": "<PAYMENT-REQUIRED header>", "payment_payload": "<PAYMENT-SIGNATURE>"} ($${usd(price)} USDC on Base via x402, charged only on HTTP 200). GET /v1/check?to=&data=&from= for plain transactions. Offline lite tier (reasons + x402 match, no RPC): /v1/lite ($${usd(litePrice)}). Free offline preview: /v1/preview (same inputs).`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-signcheck/' },
    paths: {
      '/v1/check': {
        post: { operationId: 'check_signature', summary: 'Is it safe to sign or send this? Verdict, reasons, on-chain facts and simulation', tags: ['paid'], ...pay, requestBody: BODY, responses },
        get: { operationId: 'check_signature_get', summary: 'Same as POST, inputs as query parameters', tags: ['paid'], ...pay, parameters: QUERY, responses },
      },
      '/v1/lite': {
        post: { operationId: 'check_signature_lite', summary: `Offline check ($${usd(litePrice)}): verdict, every flag with its reason, decoded args, counterparties, x402 payment-vs-402 match, OFAC SDN; no RPC`, tags: ['paid'], ...payLite, requestBody: BODY, responses },
        get: { operationId: 'check_signature_lite_get', summary: 'Same as POST /v1/lite, inputs as query parameters', tags: ['paid'], ...payLite, parameters: QUERY, responses },
      },
      '/v1/preview': { post: free('preview_signature', 'Free: offline verdict, summary and flag codes (10/min/IP)', { requestBody: BODY }), get: free('preview_signature_get', 'Free: same as POST, query parameters', { parameters: QUERY }) },
    },
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, price, litePrice = '$0.005' }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/check`, `${origin}/v1/lite`],
    instructions: `POST /v1/check ($${usd(price)}) with {"tx": {...}}, {"typed_data": {...}}, {"authorization": {...}} (EIP-7702) or {"payment_required": "<402 header>", "payment_payload": "<payment header>"} returns SAFE / CAUTION / DANGER, a plain-English summary, risk flags with reasons, counterparties (EOA vs contract, OFAC SDN), token metadata and an eth_call simulation. Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Offline lite tier without RPC (reasons, decoded args, x402 match, SDN): /v1/lite ($${usd(litePrice)}). Free offline preview: /v1/preview. Full docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
