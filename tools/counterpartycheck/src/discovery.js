// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges. Lists the paid routes and the free preview.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = [
  { path: '/v1/lite', key: 'priceLite', op: 'counterparty_lite', summary: 'Verdict (ok/caution/block) and reasons: OFAC SDN, ScamSniffer, x402 directory, labels, address type and activity' },
  { path: '/v1/quick', key: 'priceQuick', op: 'counterparty_quick', summary: 'Lite + contract verification and deployer, ENS / Basename, cross-chain presence, Safe / owner screening, explorer labels' },
  { path: '/v1/full', key: 'priceFull', op: 'counterparty_full', summary: 'Quick + age, recent activity and exposure to listed addresses, recent approvals, TokenVerdict for Base tokens' },
];
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const params = [
  { name: 'address', in: 'query', required: true, schema: { type: 'string' }, description: 'Counterparty address: EVM 0x + 40 hex, or a Solana base58 address' },
  { name: 'chain', in: 'query', required: false, schema: { type: 'string', enum: ['base', 'ethereum', 'polygon', 'arbitrum', 'solana'], default: 'base' }, description: 'Chain of the payment (a base58 address implies solana)' },
  { name: 'intent', in: 'query', required: false, schema: { type: 'string', enum: ['pay', 'approve', 'interact'], default: 'pay' }, description: 'What you are about to do' },
];
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(params.map((p) => [p.name, p.schema])), required: ['address'] } } } };
const REASON = { type: 'object', properties: { severity: { type: 'string', enum: ['danger', 'warn', 'info', 'good'] }, code: { type: 'string' }, text: { type: 'string' } } };
export const RESULT_SCHEMA = { type: 'object', properties: { address: { type: 'string' }, chain: { type: 'string' }, intent: { type: 'string' }, tier: { type: 'string' }, verdict: { type: 'string', enum: ['ok', 'caution', 'block'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, summary: { type: 'string' }, reasons: { type: 'array', items: REASON }, facts: { type: 'object' }, checks: { type: 'object' }, sources: { type: 'object' }, missing_data: { type: 'array', items: { type: 'string' } }, limits: { type: 'array', items: { type: 'string' } }, disclaimer: { type: 'string' }, checked_at: { type: 'string', format: 'date-time' } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, cfg, asset }) {
  const responses = { 200: { description: 'Verdict (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA } } }, 400: { description: 'Invalid address, chain or intent (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 503: { description: 'Chain RPC unavailable (never charged)' } };
  const paths = {};
  for (const r of PAID_ROUTES) {
    const price = cfg[r.key];
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, tags: ['paid'], ...pay, parameters: params, responses },
      post: { operationId: `${r.op}_post`, summary: 'Same as GET, POST {"address": "0x...", "chain": "base", "intent": "pay"}', tags: ['paid'], ...pay, requestBody: BODY, responses },
    };
  }
  paths['/v1/preview'] = { get: { operationId: 'counterparty_preview', summary: 'Free: verdict, confidence, address kind and flag counts (no reasons), 10/min per IP', security: [], parameters: params, responses: { 200: { description: 'OK' }, 400: { description: 'Invalid input' }, 429: { description: 'Free tier rate limit' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'CounterpartyCheck', version: VERSION,
      contact: { name: 'CounterpartyCheck', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-counterpartycheck/' },
      license: { name: 'MIT (code); bundled ScamSniffer data GPL-3.0' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Pre-payment due diligence for AI agents: before paying, approving or interacting with an address on Base, Ethereum, Polygon, Arbitrum One or Solana, get one decision (ok / caution / block) with reasons, a confidence and missing_data. Composes OFAC SDN and ScamSniffer screening, the x402 Bazaar payee directory, wallet vs contract vs token vs Safe vs EIP-7702, verification and deployer, ENS / Basename, cross-chain presence, age, recent activity and exposure, approvals and TokenVerdict. Free public data only; informational safety check, no guarantees.',
      'x-guidance': `GET /v1/lite|quick|full?address=0x...&chain=base&intent=pay or POST {"address": "0x..."} ($${usd(cfg.priceLite)} / $${usd(cfg.priceQuick)} / $${usd(cfg.priceFull)} USDC via x402, charged only on HTTP 200). Free: /v1/preview?address=.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-counterpartycheck/' },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: PAID_ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `Pre-payment counterparty check. GET ${PAID_ROUTES.map((r) => `${r.path} ($${usd(cfg[r.key])})`).join(', ')} with ?address=<EVM or Solana>&chain=base|ethereum|polygon|arbitrum|solana&intent=pay|approve|interact. Returns ok/caution/block, confidence, reasons and evidence. Paid in USDC via x402 v2 (PAYMENT-SIGNATURE) or v1 on Base (X-PAYMENT); only HTTP 200 results are settled. Free: /v1/preview?address=. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
