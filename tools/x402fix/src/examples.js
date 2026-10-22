// Example input/outputs for the Bazaar discovery declaration, OpenAPI and landing page (real x402fix runs, 2026-10-22).
export const EXAMPLE_URL = 'https://api.youraitools.co/counterpartycheck/v1/lite';
export const LITE_EXAMPLE = {
  url: 'https://api.example.com/v1/data', tier: 'lite', method: 'GET', grade: 'C', score: 70, status: 'fix_needed',
  summary: 'C (70/100): x402 v2, Base. 1 error(s), 3 warning(s); first fix: v2 accepts[0] (Base): EIP-712 domain "USDC" v2 does not match USDC on Base ("USD Coin" v2).',
  x402: { v2: true, v1: false, networks: ['Base'], price_usd: 0.01, bazaar: true },
  fixes: [
    { n: 1, severity: 'error', id: 'v2_accept_0', problem: 'v2 accepts[0] (Base): EIP-712 domain "USDC" v2 does not match USDC on Base ("USD Coin" v2)', fix: 'Set extra: { name: "USD Coin", version: "2" }. Signatures over the wrong domain fail verification, so every payment is rejected.' },
    { n: 2, severity: 'warn', id: 'head_402', problem: 'HEAD answers 405, not 402', fix: 'Answer HEAD like GET without a body (402 + PAYMENT-REQUIRED header). 402index and other directory health checks probe with HEAD and mark the endpoint down otherwise.' },
    { n: 3, severity: 'warn', id: 'cors_expose', problem: 'Browsers cannot read the PAYMENT-REQUIRED header (not in Access-Control-Expose-Headers)', fix: 'Send Access-Control-Allow-Origin: * and Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE on 402 and 200 responses.' },
  ],
};
export const CHECK_EXAMPLE = {
  url: 'https://api.youraitools.co/counterpartycheck/v1/lite', tier: 'check', method: 'GET', grade: 'A', score: 100, status: 'pass',
  summary: 'A (100/100): x402 v2+v1, Base, Polygon, Arbitrum One, Solana. No problems found.',
  x402: { v2: true, v1: true, networks: ['Base', 'Polygon', 'Arbitrum One', 'Solana'], price_usd: 0.005, bazaar: true },
  fixes: [],
  cdp: { valid: true, indexed: true, last_crawled_at: '2026-10-22T16:29:39.916Z', failed: [] },
  generated: { bazaar_self_valid: true, note: 'Paste-ready: the bazaar block validates against its own schema.' },
};
export const SITE_EXAMPLE = {
  url: 'https://api.youraitools.co/counterpartycheck', tier: 'site', grade: 'A', score: 100, status: 'pass',
  summary: 'A (100/100) across 3 of 3 paid route(s); 3 pass, 0 need fixes.',
  discovery: { openapi: 'https://api.youraitools.co/counterpartycheck/openapi.json', well_known: 'https://api.youraitools.co/counterpartycheck/.well-known/x402', routes_found: 3, routes_checked: 3 },
  routes: [{ url: 'https://api.youraitools.co/counterpartycheck/v1/lite', grade: 'A', score: 100, status: 'pass' }],
};
