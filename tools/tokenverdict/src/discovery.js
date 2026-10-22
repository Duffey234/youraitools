// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges. Lists the paid routes and the free preview.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = [
  { path: '/v1/lite', key: 'priceLite', op: 'token_verdict_lite', summary: 'Verdict (SAFE/CAUTION/DANGER), score 0-100 and the reasons' },
  { path: '/v1/quick', key: 'priceQuick', op: 'token_verdict_quick', summary: 'Full check with evidence: sell simulation and taxes, owner powers, proxy, liquidity and LP burn, holders, verification, age' },
  { path: '/v1/deep', key: 'priceDeep', op: 'token_verdict_deep', summary: 'Quick + simulations on up to 2 pools, pool table, creation block, GeckoTerminal cross-check' },
];
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const tokenParam = { name: 'token', in: 'query', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, description: 'Base (chain 8453) ERC-20 contract address, e.g. 0x532f27101965dd16442E59d40670FaF5eBB142E4' };
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } }, required: ['token'] } } } };
const REASON = { type: 'object', properties: { severity: { type: 'string', enum: ['danger', 'warn', 'info', 'good'] }, code: { type: 'string' }, text: { type: 'string' } } };
export const RESULT_SCHEMA = { type: 'object', properties: { token: { type: 'string' }, chain: { type: 'string' }, name: { type: ['string', 'null'] }, symbol: { type: ['string', 'null'] }, verdict: { type: 'string', enum: ['SAFE', 'CAUTION', 'DANGER'] }, score: { type: 'integer', minimum: 0, maximum: 100 }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reasons: { type: 'array', items: REASON }, checks: { type: 'object' }, limits: { type: 'array', items: { type: 'string' } }, disclaimer: { type: 'string' }, checked_at: { type: 'string', format: 'date-time' } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, cfg, asset }) {
  const responses = { 200: { description: 'Verdict (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA } } }, 400: { description: 'Invalid address (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 422: { description: 'Not a contract / not an ERC-20 on Base (never charged)' }, 503: { description: 'Data sources unavailable (never charged)' } };
  const paths = {};
  for (const r of PAID_ROUTES) {
    const price = cfg[r.key];
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, tags: ['paid'], ...pay, parameters: [tokenParam], responses },
      post: { operationId: `${r.op}_post`, summary: 'Same as GET, POST {"token": "0x..."}', tags: ['paid'], ...pay, requestBody: BODY, responses },
    };
  }
  paths['/v1/preview'] = { get: { operationId: 'token_verdict_preview', summary: 'Free: verdict, score and flag counts (no reasons), 10/min per IP', security: [], parameters: [tokenParam], responses: { 200: { description: 'OK' }, 400: { description: 'Invalid address' }, 429: { description: 'Free tier rate limit' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'TokenVerdict', version: VERSION,
      contact: { name: 'TokenVerdict', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-tokenverdict/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Safety check for a Base ERC-20 token before an agent or app interacts with it: honeypot / sell simulation with buy, sell and transfer tax (Uniswap v2/v3/v4, Aerodrome, Pancake), owner powers (mint, blacklist, pause, tax changes, upgradeable proxy, renounced), liquidity and LP burn, holder concentration, verified source and age, rolled into SAFE / CAUTION / DANGER with a 0-100 score and reasons. Free public data only. SAFE is not a guarantee and not financial advice.',
      'x-guidance': `GET /v1/lite|quick|deep?token=0x... or POST {"token": "0x..."} ($${usd(cfg.priceLite)} / $${usd(cfg.priceQuick)} / $${usd(cfg.priceDeep)} USDC on Base via x402, charged only on HTTP 200). Free: /v1/preview?token= and the shareable card /t/<token>.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-tokenverdict/' },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: PAID_ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `Base token safety verdicts. GET ${PAID_ROUTES.map((r) => `${r.path} ($${usd(cfg[r.key])})`).join(', ')} with ?token=0x<Base ERC-20>. Returns SAFE/CAUTION/DANGER, score 0-100, reasons; quick and deep add sell-simulation taxes, owner powers, proxy, liquidity/LP, holders, verification and age. Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free: /v1/preview?token= and /t/<token>. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
