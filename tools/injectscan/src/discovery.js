// Discovery documents: GET /openapi.json (x402scan / agents), GET /.well-known/x402 manifest, logo/favicon.
// Built from the live config so price and terms can't drift from the 402 challenge.
import { SERVICE_META } from './service-meta.js';
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="InjectScan"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M32 10l18 7v12c0 12-8 20-18 25-10-5-18-13-18-25V17z" fill="none" stroke="#f59e0b" stroke-width="3.5" stroke-linejoin="round"/><circle cx="30" cy="31" r="7.5" fill="none" stroke="#e6e9f0" stroke-width="3"/><path d="M35.5 36.5l6 6" stroke="#e6e9f0" stroke-width="3.5" stroke-linecap="round"/><path d="M27 31h6" stroke="#f87171" stroke-width="2.5" stroke-linecap="round"/></svg>`;

export const OPENAPI_PATHS = ['/v1/scan', '/v1/scan/preview'];
const usd = (price) => String(price).replace(/^\$/, '');
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    input: { type: 'string', enum: ['text', 'url', 'tools'] },
    risk_score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: ['safe', 'suspicious', 'malicious'] },
    flagged: { type: 'boolean' },
    categories: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, score: { type: 'integer' }, rules: { type: 'integer' }, description: { type: 'string' } } } },
    findings: { type: 'array', items: { type: 'object', properties: { rule: { type: 'string' }, category: { type: 'string' }, weight: { type: 'number' }, start: { type: 'integer' }, end: { type: 'integer' }, location: { type: 'string' }, text: { type: 'string' } } } },
    hidden: { type: 'object' }, decoded: { type: 'array' }, chars_scanned: { type: 'integer' }, truncated: { type: 'boolean' }, ruleset: { type: 'string' },
    tools: { type: 'array', description: 'tools= mode: one result per tool' }, hidden_html: { type: 'object', description: 'url= mode: hidden HTML segments checked and flagged' },
  },
};
const free = (operationId, summary, extra = {}) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' } }, ...extra });

/** OpenAPI 3.1 document with live price, origin and x402 terms. */
export function openapiDoc({ origin, price, network, payTo, asset, exampleText, exampleOutput }) {
  const amount = usd(price);
  const pay = { 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(amount) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] } };
  const responses = { 200: { description: 'Scan result (payment settled)', content: { 'application/json': { schema: RESULT_SCHEMA, ...(exampleOutput ? { example: exampleOutput } : {}) } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 403: { description: 'url= blocked by robots.txt (never charged)' }, 502: { description: 'url= fetch failed (never charged)' } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'InjectScan', version: '0.1.4',
      contact: { name: 'InjectScan', email: 'hello@youraitools.co', url: 'https://youraitools.co/guides/prompt-injection-scanner-api' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Prompt-injection scanner for AI agents: score text, web pages and MCP tool definitions before your agent reads them. Deterministic rules (instruction override, jailbreak personas, system-prompt extraction, fake delimiters, exfiltration URLs, tool hijack, hidden Unicode, encoded payloads); risk score, categories and spans.',
      'x-guidance': `GET /v1/scan?text=<text> or ?url=<page>, or POST /v1/scan with {"text"}, {"url"} or {"tools":[...]} (MCP tool definitions). $${amount} USDC on Base via x402, charged only on HTTP 200. Free preview for text up to 2,000 characters: /v1/scan/preview.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Integration guide', url: 'https://youraitools.co/guides/prompt-injection-scanner-api' },
    paths: {
      '/v1/scan': {
        get: { operationId: 'scan', summary: 'Scan text or a URL for prompt injection', tags: ['paid'], ...pay, parameters: [{ name: 'text', in: 'query', schema: { type: 'string' }, description: 'Text to scan', ...(exampleText ? { example: exampleText } : {}) }, { name: 'url', in: 'query', schema: { type: 'string', format: 'uri' }, description: 'Public http(s) page to fetch and scan (visible + hidden HTML)' }], responses },
        post: { operationId: 'scan_post', summary: 'Scan text, a URL, or MCP tool definitions', tags: ['paid'], ...pay, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { text: { type: 'string', maxLength: 100000 }, url: { type: 'string', format: 'uri' }, tools: { type: 'array', maxItems: 100, items: { type: 'object' } } }, oneOf: [{ required: ['text'] }, { required: ['url'] }, { required: ['tools'] }] }, ...(exampleText ? { example: { text: exampleText } } : {}) } } }, responses },
      },
      '/v1/scan/preview': { get: free('scan_preview', 'Free scan for text up to 2,000 characters (10/min/IP)', { parameters: [{ name: 'text', in: 'query', required: true, schema: { type: 'string', maxLength: 2000 } }] }), post: free('scan_preview_post', 'Free scan (POST {"text"})') },
    },
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, price }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/scan`],
    instructions: `GET /v1/scan?text=... or ?url=..., or POST /v1/scan {"text"|"url"|"tools"}. Price: $${usd(price)} USDC on Base (eip155:8453), paid via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free preview: /v1/scan/preview?text= (2,000 chars). Full docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
