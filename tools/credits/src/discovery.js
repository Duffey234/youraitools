// Discovery documents for the credits service: /openapi.json and /.well-known/x402, built from the live pack config.
import { SERVICE_META } from './service-meta.js';
import { PACKS, usd } from './packs.js';

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="YourAITools Credits"><rect width="64" height="64" rx="14" fill="#0f172a"/><rect x="12" y="18" width="40" height="28" rx="5" fill="none" stroke="#38bdf8" stroke-width="3"/><path d="M12 26h40" stroke="#38bdf8" stroke-width="3"/><circle cx="42" cy="37" r="4" fill="#4ade80"/><path d="M18 38h12" stroke="#4ade80" stroke-width="3" stroke-linecap="round"/></svg>`;

export const TERMS = 'Credits are prepaid usage of the YourAITools APIs only, priced in USD at each route\'s normal per-call price. They are not money, not a token or investment, have no cash value, cannot be withdrawn and are not refundable; a failed call (HTTP 400 or higher) is not charged. Prices of individual routes can change; the balance does not expire while the service runs. Keep the key secret: whoever holds it can spend the credits.';

const PACK_SCHEMA = { type: 'object', properties: { api_key: { type: 'string', pattern: '^yatc_[A-Za-z0-9_-]{43}$' }, shown_once: { type: 'boolean' }, pack: { type: 'string' }, paid_usd: { type: 'string' }, credited_usd: { type: 'string' }, bonus_usd: { type: 'string' }, balance_usd: { type: 'string' }, use: { type: 'object' }, balance: { type: 'string' }, topup: { type: 'object' } } };
const TOPUP_SCHEMA = { type: 'object', properties: { topped_up: { type: 'boolean' }, pack: { type: 'string' }, credited_usd: { type: 'string' }, balance_usd: { type: 'string' } } };
const BEARER = { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' }, description: 'Bearer yatc_... (your credits key); X-Credits-Key also works' };

export function openapiDoc({ origin, network, payTo, asset }) {
  const pay = (p) => ({ 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(p.paid) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(p.paid), assetSymbol: 'USDC', x402Versions: [2, 1] } });
  const resp = (schema) => ({ 200: { description: 'Paid and settled', content: { 'application/json': { schema } } }, 400: { description: 'Invalid or missing key (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 503: { description: 'Storage unavailable (never charged)' } });
  const paths = {};
  for (const id of ['sample', '1', '5']) {
    const p = PACKS[id];
    const op = (m) => ({ operationId: `buy_pack_${id}${m === 'post' ? '_post' : ''}`, summary: `${p.label}: mints a new API key (shown once)`, tags: ['paid'], ...pay(p), responses: resp(PACK_SCHEMA) });
    paths[`/v1/pack/${id}`] = { get: op('get'), post: op('post') };
  }
  for (const id of ['1', '5']) {
    const p = PACKS[id];
    const op = (m) => ({ operationId: `topup_${id}${m === 'post' ? '_post' : ''}`, summary: `Top up an existing key by $${usd(p.credit)} of credits`, tags: ['paid'], parameters: [BEARER], ...pay(p), responses: resp(TOPUP_SCHEMA) });
    paths[`/v1/topup/${id}`] = { get: op('get'), post: op('post') };
  }
  const free = (operationId, summary, extra = {}) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' }, 401: { description: 'Missing or malformed key' }, 404: { description: 'Unknown key' }, 429: { description: 'Rate limited' } }, ...extra });
  paths['/v1/balance'] = { get: free('credits_balance', 'Balance, spend per tool and recent calls of a key (free)', { parameters: [BEARER] }) };
  paths['/v1/key/rotate'] = { post: free('rotate_key', 'Move the balance to a new key; the old key stops working (free)', { parameters: [BEARER] }) };
  paths['/v1/preview'] = { get: free('credits_quote', 'Free: what a pack buys at today\'s prices', { parameters: [{ name: 'pack', in: 'query', required: false, schema: { type: 'string', enum: ['1', '5', 'sample'] } }] }) };
  paths['/v1/claim'] = { post: free('claim_direct_transfer', 'Free: get the key for a pack paid with a plain USDC transfer made from the credits page (Base, Polygon or Arbitrum One; the transfer carries a sha256 claim-code commitment). 202 = not confirmed yet, 409 = already claimed', { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['chain', 'txHash', 'secret'], properties: { chain: { type: 'string', enum: ['base', 'polygon', 'arbitrum'] }, txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }, secret: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } } } } } } }) };
  paths['/v1/prices'] = { get: free('credits_prices', 'Free: per-route prices of every tool that accepts credits') };
  return {
    openapi: '3.1.0',
    info: {
      title: 'YourAITools Credits', version: '0.1.0',
      contact: { name: 'YourAITools', email: 'hello@youraitools.co', url: 'https://youraitools.co/built-by-us' }, license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: `Prepaid credits for the YourAITools x402 agent APIs (PayGuard, TokenVerdict, SignCheck, WebRead, InjectScan, DomainCheck, PkgGuard, StackDetect, AgentGate). One x402 payment ($1, or $5 with a 10% bonus) mints an API key; send it as Authorization: Bearer <key> to any of those paid routes and each call debits its normal price, with no per-call on-chain payment. ${TERMS}`,
      'x-guidance': 'POST /v1/pack/1 with any x402 client (USDC on Base, Polygon, Arbitrum One or Solana) -> JSON with api_key (shown once). Then call e.g. https://api.youraitools.co/payguard/v1/address?address=0x... with header Authorization: Bearer <api_key>. Responses carry X-Credits-Charged and X-Credits-Remaining. GET /v1/balance with the key; top up at /v1/topup/1 or /v1/topup/5 with the key.',
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-credits/' },
    components: { securitySchemes: { creditsKey: { type: 'http', scheme: 'bearer', description: 'yatc_... credits key' } } },
    paths,
  };
}

export function wellKnownX402({ origin }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: ['/v1/pack/1', '/v1/pack/5', '/v1/pack/sample', '/v1/topup/1', '/v1/topup/5'].map((p) => `${origin}${p}`),
    instructions: `Prepaid credits for the YourAITools APIs. GET or POST /v1/pack/1 ($1 -> $1.00 credits) or /v1/pack/5 ($5 -> $5.50 credits) returns a new api_key (shown once); /v1/pack/sample ($0.005) tries the flow. Send the key as Authorization: Bearer <key> to any YourAITools paid route (https://api.youraitools.co/<tool>/...) to pay from the balance instead of per-call x402. Top up with /v1/topup/1 or /v1/topup/5 plus the key. Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free: /v1/balance, /v1/preview?pack=5. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
