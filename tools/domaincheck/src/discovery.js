// Discovery documents: GET /openapi.json (x402scan / agents), GET /.well-known/x402 manifest, logo/favicon.
// Built from the live config so prices and terms can't drift from the 402 challenge.
import { SERVICE_META } from './service-meta.js';
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="DomainCheck"><rect width="64" height="64" rx="14" fill="#0f172a"/><circle cx="29" cy="29" r="15" fill="none" stroke="#38bdf8" stroke-width="3"/><path d="M14 29h30M29 14c-5 4-7 9.5-7 15s2 11 7 15M29 14c5 4 7 9.5 7 15s-2 11-7 15" fill="none" stroke="#38bdf8" stroke-width="2.2"/><circle cx="45" cy="45" r="9" fill="#0f172a" stroke="#4ade80" stroke-width="3"/><path d="M41 45.5l3 3 5.5-6" fill="none" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const OPENAPI_PATHS = ['/v1/domain', '/v1/email', '/v1/domain/preview', '/v1/email/preview'];
const usd = (price) => String(price).replace(/^\$/, '');
const FLAG = { type: 'object', properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, penalty: { type: 'integer' }, description: { type: 'string' }, detail: { type: 'string' } } };
const DOMAIN_SCHEMA = {
  type: 'object',
  properties: {
    domain: { type: 'string' }, registrable_domain: { type: 'string' }, public_suffix: { type: 'string' }, exists: { type: 'boolean' },
    verdict: { type: 'string', enum: ['low_risk', 'medium_risk', 'high_risk', 'nonexistent'] }, score: { type: 'integer', minimum: 0, maximum: 100 },
    flags: { type: 'array', items: FLAG },
    dns: { type: 'object', description: 'a, aaaa, ns, mx[{priority,host}], null_mx, cname, dnssec_validated, caa' },
    email: { type: 'object', description: 'accepts_mail, mx_provider, spf, dmarc, dkim, mta_sts, tls_rpt, bimi, grade (A-F)' },
    registration: { type: 'object', description: 'RDAP: registrar, created, expires, age_days, expires_in_days, status, nameservers, dnssec_signed' },
  },
};
const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    input: { type: 'string' }, normalized: { type: 'string' }, canonical: { type: 'string' }, domain: { type: 'string' },
    verdict: { type: 'string', enum: ['valid', 'risky', 'undeliverable', 'invalid'] }, score: { type: 'integer', minimum: 0, maximum: 100 },
    syntax: { type: 'object' }, disposable: { type: 'boolean' }, role: { type: 'boolean' }, free_provider: { type: 'boolean' }, plus_tag: { type: ['string', 'null'] },
    deliverability: { type: 'object', description: 'domain_exists, accepts_mail, mx, null_mx, mx_provider' },
    domain_auth: { type: 'object', description: 'spf, dmarc policy and grade' }, registration: { type: ['object', 'null'] },
    flags: { type: 'array', items: FLAG }, mailbox_checked: { type: 'boolean', const: false },
  },
};
const free = (operationId, summary, extra = {}) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' } }, ...extra });

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, priceDomain, priceEmail, network, payTo, asset }) {
  const pay = (price) => ({ 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(usd(price)) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] } });
  const responses = (schema, what) => ({ 200: { description: `${what} (payment settled)`, content: { 'application/json': { schema } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 422: { description: 'Invalid email syntax (never charged)' }, 504: { description: 'Lookup timed out (never charged)' } });
  const qp = (name, desc) => [{ name, in: 'query', required: true, schema: { type: 'string' }, description: desc }];
  const body = (name) => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'DomainCheck', version: '0.1.3',
      contact: { name: 'DomainCheck', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-domain-check/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Domain and email trust checks for AI agents. Domain: DNS, MX, SPF / DMARC / DKIM / MTA-STS / BIMI, DNSSEC, RDAP registration age + registrar + status, parking and disposable detection, risk flags, 0-100 score. Email: syntax, disposable / role / free provider, MX, domain auth, domain age, verdict. Public DNS + RDAP only; no SMTP probing; nothing stored.',
      'x-guidance': `GET /v1/domain?domain=<name> ($${usd(priceDomain)}) or GET /v1/email?email=<address> ($${usd(priceEmail)}); POST JSON {"domain"} / {"email"} also works. USDC on Base via x402, charged only on HTTP 200. Free previews: /v1/domain/preview, /v1/email/preview.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-domain-check/' },
    paths: {
      '/v1/domain': {
        get: { operationId: 'check_domain', summary: 'Domain trust report (DNS, email auth, RDAP age, flags, score)', tags: ['paid'], ...pay(priceDomain), parameters: qp('domain', 'Domain, URL or email address'), responses: responses(DOMAIN_SCHEMA, 'Domain report') },
        post: { operationId: 'check_domain_post', summary: 'Domain trust report (POST {"domain"})', tags: ['paid'], ...pay(priceDomain), requestBody: body('domain'), responses: responses(DOMAIN_SCHEMA, 'Domain report') },
      },
      '/v1/email': {
        get: { operationId: 'check_email', summary: 'Email address check (syntax, disposable, MX, domain age, verdict)', tags: ['paid'], ...pay(priceEmail), parameters: qp('email', 'Email address'), responses: responses(EMAIL_SCHEMA, 'Email check') },
        post: { operationId: 'check_email_post', summary: 'Email address check (POST {"email"})', tags: ['paid'], ...pay(priceEmail), requestBody: body('email'), responses: responses(EMAIL_SCHEMA, 'Email check') },
      },
      '/v1/domain/preview': { get: free('domain_preview', 'Free DNS / MX / SPF / DMARC summary (10/min/IP)', { parameters: qp('domain', 'Domain') }), post: free('domain_preview_post', 'Free domain preview (POST {"domain"})') },
      '/v1/email/preview': { get: free('email_preview', 'Free syntax + disposable / role / free-provider check (10/min/IP)', { parameters: qp('email', 'Email address') }), post: free('email_preview_post', 'Free email preview (POST {"email"})') },
    },
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, priceDomain, priceEmail }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/domain`, `${origin}/v1/email`],
    instructions: `GET /v1/domain?domain=example.com ($${usd(priceDomain)}) or GET /v1/email?email=jane@example.com ($${usd(priceEmail)}); POST JSON works too. Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free previews: /v1/domain/preview, /v1/email/preview. Full docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
