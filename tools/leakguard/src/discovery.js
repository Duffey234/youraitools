// Discovery documents: GET /openapi.json (x402scan / agents) and GET /.well-known/x402, built from the live config so
// prices and terms can't drift from the 402 challenges. Lists the paid routes and the free preview only.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
export { LOGO_SVG } from './brand.js';

export const PAID_ROUTES = [
  { path: '/v1/lite', key: 'priceLite', op: 'leak_scan_lite', summary: 'Find and redact secrets, wallet keys and PII in text (<= 32 KB): verdict, findings with masked previews and remediation, redacted text' },
  { path: '/v1/scan', key: 'priceScan', op: 'leak_scan_deep', summary: 'Deep scan of text or JSON (<= 256 KB): findings by JSON path, redacted JSON, leaked-wallet exposure (derived addresses + native/USDC balances on Base, Ethereum, Polygon, Arbitrum One, Solana), ordered actions' },
];
const usd = (price) => String(price).replace(/^\$/, '');
const atomic = (price) => String(Math.round(Number(usd(price)) * 1e6));
const textParam = { name: 'text', in: 'query', required: true, schema: { type: 'string', maxLength: 8192 }, description: 'Text to check (prefer POST for anything sensitive or long)' };
const optParams = [
  { name: 'style', in: 'query', required: false, schema: { type: 'string', enum: ['label', 'mask'] }, description: 'label: [REDACTED:type] (default); mask: keep last 4 digits / email domain for PII' },
  { name: 'types', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated finding types or categories (wallet_key, secret, pii, email, ...)' },
  { name: 'min_severity', in: 'query', required: false, schema: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } },
];
const BODY = (json) => ({ required: true, content: {
  'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, ...(json ? { json: { description: 'Any JSON payload (object, array or value); scanned string by string, keys included' } } : {}), style: { type: 'string', enum: ['label', 'mask'] }, types: { type: 'array', items: { type: 'string' } }, min_severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } }, ...(json ? { oneOf: [{ required: ['text'] }, { required: ['json'] }] } : { required: ['text'] }) } },
  'text/plain': { schema: { type: 'string' } },
} });
const FINDING = { type: 'object', properties: { type: { type: 'string' }, category: { type: 'string', enum: ['wallet_key', 'secret', 'pii'] }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, confidence: { type: 'number' }, validator: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' }, preview: { type: 'string', description: 'masked; never the secret' }, path: { type: 'string', description: 'JSON path (scan, json input)' }, remediation: { type: 'string' } } };
export const RESULT_SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['WALLET_KEY_EXPOSED', 'SECRETS_FOUND', 'PII_FOUND', 'CLEAN'] }, safe_to_send: { type: 'boolean' }, max_severity: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, counts: { type: 'object' }, findings: { type: 'array', items: FINDING }, redacted: { type: 'string' }, redacted_json: { description: 'scan with json input: same shape, secrets replaced' }, exposure: { type: 'object', description: 'scan: status funds_at_risk | unknown | used_empty | no_funds_found | not_checked | not_applicable; addresses[] with balances per chain' }, actions: { type: 'array', items: { type: 'string' } }, sources_failed: { type: 'array', items: { type: 'string' } }, engine: { type: 'string' }, checked_at: { type: 'string', format: 'date-time' } } };

/** OpenAPI 3.1 document with live prices, origin and x402 terms (paid and preview routes only). */
export function openapiDoc({ origin, cfg, asset }) {
  const responses = { 200: { description: 'Scan result (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 413: { description: 'Input larger than the tier limit (never charged)' }, 503: { description: 'checks_incomplete (never charged)' } };
  const paths = {};
  for (const r of PAID_ROUTES) {
    const price = cfg[r.key];
    const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network: cfg.network, asset, payTo: cfg.payTo, amount: atomic(price), assetSymbol: 'USDC', x402Versions: [2, 1] } };
    paths[r.path] = {
      get: { operationId: r.op, summary: `${r.summary} ($${usd(price)})`, tags: ['paid'], ...pay, parameters: [textParam, ...optParams], responses },
      post: { operationId: `${r.op}_post`, summary: `Same as GET; POST {"text": "..."}${r.path === '/v1/scan' ? ' or {"json": {...}}' : ''} or a text/plain body`, tags: ['paid'], ...pay, requestBody: BODY(r.path === '/v1/scan'), responses },
    };
  }
  const prevResp = { 200: { description: 'verdict, safe_to_send, max_severity, counts' }, 400: { description: 'Invalid input' }, 413: { description: 'Text over 8 KB' }, 429: { description: 'Free tier rate limit' } };
  paths['/v1/preview'] = {
    get: { operationId: 'leak_scan_preview', summary: 'Free: verdict, safe_to_send, max severity and counts by type (no positions or redacted text), text <= 8 KB, 10/min per IP', security: [], parameters: [textParam], responses: prevResp },
    post: { operationId: 'leak_scan_preview_post', summary: 'Free preview, POST {"text": "..."} or text/plain', security: [], requestBody: BODY(false), responses: prevResp },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'LeakGuard', version: VERSION,
      contact: { name: 'LeakGuard', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-leakguard/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Stop AI agents leaking secrets. Finds and redacts crypto wallet keys (BIP39 seed phrases with checksum, EVM and Solana private keys, WIF, xprv), API secrets (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack, Telegram, npm, SendGrid, Hugging Face, JWT, PEM, credentialed URLs, password= assignments) and PII (Luhn-checked cards, mod-97 IBAN, SSN, email, phone, IP) in text or JSON before it reaches an LLM, tool, log or webhook. The deep scan derives the public addresses a leaked seed phrase or private key controls and reports native + USDC balances on Base, Ethereum, Polygon, Arbitrum One and Solana. Fail-closed: a balance lookup that fails is "unknown" (listed in sources_failed, confidence low), never "empty". Inputs are never logged or stored. Pay with x402 (USDC on Base, Solana, Polygon or Arbitrum One) or a prepaid credits key (Authorization: Bearer).',
      'x-guidance': `POST /v1/lite {"text": "..."} ($${usd(cfg.priceLite)}) or POST /v1/scan {"text": "..."} / {"json": {...}} ($${usd(cfg.priceScan)}), USDC via x402, charged only on HTTP 200. GET ?text= also works (prefer POST for sensitive text). Free: /v1/preview.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-leakguard/' },
    paths,
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, cfg }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: PAID_ROUTES.map((r) => `${origin}${r.path}`),
    instructions: `Leaked-secret detection and redaction for AI agents. POST ${PAID_ROUTES.map((r) => `${r.path} ($${usd(cfg[r.key])})`).join(', ')} with {"text": "..."} (scan also takes {"json": ...}). Returns a verdict, findings, redacted text; scan adds JSON paths and live balances of wallets whose keys leaked. Paid in USDC via x402 v2 (PAYMENT-SIGNATURE; Base, Solana, Polygon, Arbitrum One) or v1 (X-PAYMENT, Base), or with a prepaid credits key; only HTTP 200 results are settled. Free: /v1/preview. Docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
