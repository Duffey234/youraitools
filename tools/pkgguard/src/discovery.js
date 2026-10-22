// Discovery documents: GET /openapi.json (x402scan / agents), GET /.well-known/x402 manifest, logo/favicon.
// Built from the live config so prices and terms can't drift from the 402 challenge.
import { SERVICE_META } from './service-meta.js';
import { VERSION_STR as VERSION } from './version.js';
import { ECOSYSTEMS, MANIFEST_TYPES } from './manifest.js';
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="PkgGuard"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M32 9l19 10v22L32 51 13 41V19z" fill="none" stroke="#a78bfa" stroke-width="3" stroke-linejoin="round"/><path d="M13 19l19 10 19-10M32 29v22" fill="none" stroke="#a78bfa" stroke-width="2.2" stroke-linejoin="round" opacity=".55"/><path d="M24 33l6 6 11-12" fill="none" stroke="#4ade80" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const OPENAPI_PATHS = ['/v1/scan', '/v1/package', '/v1/preview'];
const usd = (price) => String(price).replace(/^\$/, '');
const SEV = { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN', 'NONE'] };
const VULN = { type: 'object', properties: { id: { type: 'string' }, malicious: { type: 'boolean' }, severity: SEV, cvss_score: { type: ['number', 'null'] }, cvss_vector: { type: ['string', 'null'] }, summary: { type: ['string', 'null'] }, aliases: { type: 'array', items: { type: 'string' } }, fixed_in: { type: 'array', items: { type: 'string' } }, published: { type: ['string', 'null'] }, url: { type: 'string' } } };
const PKG = { type: 'object', properties: { ecosystem: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, version_source: { type: 'string', enum: ['exact', 'range_floor'] }, malicious: { type: 'boolean' }, highest_severity: SEV, vuln_count: { type: 'integer' }, vulns: { type: 'array', items: VULN } } };
export const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string' }, manifest_type: { type: 'string' }, package_count: { type: 'integer' }, scanned_count: { type: 'integer' }, unpinned_count: { type: 'integer' },
    vulnerable_count: { type: 'integer' }, malicious_count: { type: 'integer' }, advisory_count: { type: 'integer' },
    verdict: { type: 'string', enum: ['clean', 'vulnerable', 'malicious'] }, highest_severity: SEV, by_severity: { type: 'object' },
    packages: { type: 'array', items: PKG, description: 'Only packages with at least one advisory' },
    unpinned: { type: 'array', items: { type: 'object' } }, source: { type: 'object' }, scanned_at: { type: 'string', format: 'date-time' }, disclaimer: { type: 'string' },
  },
};
const free = (operationId, summary, extra = {}) => ({ operationId, summary, security: [], responses: { 200: { description: 'OK' }, 429: { description: 'Free tier rate limit' }, 503: { description: 'OSV.dev unavailable' } }, ...extra });
const SCAN_BODY = { type: 'object', properties: { manifest: { type: 'string', maxLength: 512000, description: `File contents: ${MANIFEST_TYPES.join(', ')}` }, filename: { type: 'string' }, type: { type: 'string', enum: MANIFEST_TYPES }, include_dev: { type: 'boolean', default: true }, packages: { type: 'array', maxItems: 500, items: { type: 'object', properties: { ecosystem: { type: 'string', enum: ECOSYSTEMS }, name: { type: 'string' }, version: { type: 'string' } }, required: ['name', 'version'] } } } };
const PKG_BODY = { type: 'object', properties: { ecosystem: { type: 'string', enum: ECOSYSTEMS, default: 'npm' }, name: { type: 'string' }, version: { type: 'string' } }, required: ['name', 'version'] };

/** OpenAPI 3.1 document with live prices, origin and x402 terms. */
export function openapiDoc({ origin, priceScan, pricePackage, network, payTo, asset }) {
  const pay = (price) => ({ 'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: usd(price) }, protocols: [{ x402: {} }] }, 'x-x402': { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(usd(price)) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] } });
  const responses = (what) => ({ 200: { description: `${what} (payment settled)`, content: { 'application/json': { schema: SCAN_SCHEMA } } }, 400: { description: 'Invalid input (never charged)' }, 402: { description: 'Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header, v1 terms in the body)' }, 503: { description: 'OSV.dev unavailable (never charged)' } });
  const qp = [
    { name: 'ecosystem', in: 'query', required: false, schema: { type: 'string', enum: ECOSYSTEMS, default: 'npm' } },
    { name: 'name', in: 'query', required: true, schema: { type: 'string', maxLength: 214 }, description: 'Package name, e.g. lodash, requests, github.com/gin-gonic/gin' },
    { name: 'version', in: 'query', required: true, schema: { type: 'string', maxLength: 64 }, description: 'Exact version, e.g. 4.17.15' },
  ];
  const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'PkgGuard', version: VERSION,
      contact: { name: 'PkgGuard', email: 'hello@youraitools.co', url: 'https://agentgate-source.pages.dev/x402-pkgguard/' },
      license: { name: 'MIT' },
      'x-service-name': SERVICE_META.serviceName, 'x-category': SERVICE_META.category, 'x-categories': SERVICE_META.categories, 'x-tags': SERVICE_META.tags, 'x-logo': { url: SERVICE_META.iconUrl },
      description: 'Dependency security scan for AI agents, coding agents and CI. Send a manifest or lockfile (package.json, package-lock.json, requirements.txt, Pipfile.lock, poetry.lock, go.mod, Cargo.lock, composer.lock) or a package list and get known vulnerabilities (CVE/GHSA ids, severity, CVSS, fixed-in versions) and confirmed-malicious packages per dependency. Data: OSV.dev (CC-BY 4.0). Informational, not a security audit.',
      'x-guidance': `POST /v1/scan {"manifest": "<file contents>"} ($${usd(priceScan)}, up to 500 packages) or GET /v1/package?ecosystem=npm&name=lodash&version=4.17.15 ($${usd(pricePackage)}). USDC on Base via x402, charged only on HTTP 200. Free preview (verdict + counts): /v1/preview.`,
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Source and docs', url: 'https://agentgate-source.pages.dev/x402-pkgguard/' },
    paths: {
      '/v1/scan': { post: { operationId: 'scan_dependencies', summary: 'Scan a manifest / lockfile / package list for vulnerable and malicious packages (up to 500)', tags: ['paid'], ...pay(priceScan), requestBody: json(SCAN_BODY), responses: responses('Scan result') } },
      '/v1/package': {
        get: { operationId: 'check_package', summary: 'Known vulnerabilities and malicious flag for one package version', tags: ['paid'], ...pay(pricePackage), parameters: qp, responses: responses('Package result') },
        post: { operationId: 'check_package_post', summary: 'Same as GET, POST {"ecosystem","name","version"}', tags: ['paid'], ...pay(pricePackage), requestBody: json(PKG_BODY), responses: responses('Package result') },
      },
      '/v1/preview': { get: free('preview_package', 'Free verdict + counts for one package (10/min/IP)', { parameters: qp }), post: free('preview_scan', 'Free verdict + counts for a manifest or up to 25 packages', { requestBody: json(SCAN_BODY) }) },
    },
  };
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin, priceScan, pricePackage }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/scan`, `${origin}/v1/package`],
    instructions: `POST /v1/scan {"manifest": "<package.json / lockfile / requirements.txt / go.mod / Cargo.lock contents>"} ($${usd(priceScan)}, up to 500 packages) returns known vulnerabilities and malicious packages per dependency; GET /v1/package?ecosystem=npm&name=<pkg>&version=<v> ($${usd(pricePackage)}) checks one package. Paid in USDC on Base (eip155:8453) via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 results are settled. Free preview: /v1/preview. Full docs: /openapi.json`,
    openapi: `${origin}/openapi.json`,
  };
}
