// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges. Lists the paid routes and the free preview.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = [
  { path: '/v1/lite', key: 'priceLite', op: 'solana_token_verdict_lite', summary: 'Verdict (SAFE/CAUTION/DANGER), score 0-100, reasons and key facts' },
  { path: '/v1/check', key: 'priceCheck', op: 'solana_token_verdict_check', summary: 'Full report: mint/freeze authority, Token-2022 extensions, metadata authority, pools, liquidity and 24 h sells, holders (wallets vs programs), age' },
];
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const tokenParam = { name: 'mint', in: 'query', required: true, schema: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' }, description: 'Solana token mint address (base58), e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' };
const BODY = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { mint: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' } }, required: ['mint'] } } } };
const REASON = { type: 'object', properties: { severity: { type: 'string', enum: ['danger', 'warn', 'info', 'good'] }, code: { type: 'string' }, text: { type: 'string' } } };
export const RESULT_SCHEMA = { type: 'object', properties: { mint: { type: 'string' }, chain: { type: 'string' }, name: { type: ['string', 'null'] }, symbol: { type: ['string', 'null'] }, verdict: { type: 'string', enum: ['SAFE', 'CAUTION', 'DANGER'] }, score: { type: 'integer', minimum: 0, maximum: 100 }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reasons: { type: 'array', items: REASON }, checks: { type: 'object' }, limits: { type: 'array', items: { type: 'string' } }, disclaimer: { type: 'string' }, checked_at: { type: 'string', format: 'date-time' } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, cfg, asset }) {
  const responses = { 200: { description: 'Verdict (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA } } }, 400: { description: 'Invalid address (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 422: { description: 'Not an SPL / Token-2022 mint on Solana mainnet (never charged)' }, 503: { description: 'Data sources unavailable (never charged)' } };
  const paths = {};
  for (const r of PAID_ROUTES) {
    const price = cfg[r.key];
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, tags: ['paid'], ...pay, parameters: [tokenParam], responses },
      post: { operationId: `${r.op}_post`, summary: 'Same as GET, POST {"mint": "<base58>"}', tags: ['paid'], ...pay, requestBody: BODY, responses },
    };
  }
  paths['/v1/preview'] = { get: { operationId: 'solana_token_verdict_preview', summary: 'Free: verdict, score and flag counts (no reasons), 10/min per IP', security: [], parameters: [tokenParam], responses: { 200: { description: 'OK' }, 400: { description: 'Invalid address' }, 429: { description: 'Free tier rate limit' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'SolVerdict', version: VERSION,
      contact: { name: 'SolVerdict', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-solverdict/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. Checks mint and freeze authority, Token-2022 extensions that can block or tax sells (permanent delegate, transfer hook, transfer fee, default-frozen accounts, pausable, non-transferable), metadata update authority, DEX pools, liquidity and 24 h buys vs sells (pump.fun bonding curve aware), the 20 largest holders split into wallets vs program accounts, and age, rolled into SAFE / CAUTION / DANGER with a 0-100 score and reasons. Free public data only; informational. SAFE is not a guarantee and not financial advice. Pay with x402 (USDC on Base, Solana, Polygon or Arbitrum One) or a prepaid credits key (Authorization: Bearer).',
      'x-guidance': `GET /v1/lite|check?mint=<base58> or POST {"mint": "<base58>"} ($${usd(cfg.priceLite)} / $${usd(cfg.priceCheck)} USDC via x402, charged only on HTTP 200). Free: /v1/preview?mint= and the shareable card /t/<mint>.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-solverdict/' },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: PAID_ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `Solana token safety verdicts. GET ${PAID_ROUTES.map((r) => `${r.path} ($${usd(cfg[r.key])})`).join(', ')} with ?mint=<Solana token mint>. Returns SAFE/CAUTION/DANGER, score 0-100, reasons; check adds authorities, Token-2022 extensions, metadata, pools/liquidity/sells, holders and age. Paid in USDC via x402 v2 (PAYMENT-SIGNATURE; Base, Solana, Polygon, Arbitrum One) or v1 (X-PAYMENT, Base), or with a prepaid credits key; only HTTP 200 results are settled. Free: /v1/preview?mint= and /t/<mint>. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
