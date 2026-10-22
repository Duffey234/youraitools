import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://stackdetect.example.com';

export const WP_HTML = `<!doctype html><html><head><meta name="generator" content="WordPress 6.6.2">
<link rel="stylesheet" href="https://shop.test-site.com/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=9.1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<script src="https://shop.test-site.com/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script src="https://js.stripe.com/v3/"></script>
<meta property="og:title" content="Shop"><title>Test Shop</title></head>
<body class="woocommerce-page"><script>fbq('init', '123');</script></body></html>`;
export const NEXT_HTML = '<html><head><script src="/_next/static/chunks/main-abc.js"></script><title>Next</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>';

/** Fake network for the target site + DoH: { fetchImpl, calls }. Sites: shop.test-site.com (WordPress), next.test-site.com,
 *  redirect.test-site.com -> shop, down.test-site.com (throws), gone.test-site.com (404, nothing), private.test-site.com (resolves to 10.0.0.1). */
export function fakeNet() {
  const calls = [];
  const dns = {
    'shop.test-site.com': { A: ['93.184.216.34'] }, 'next.test-site.com': { A: ['93.184.216.35'] }, 'redirect.test-site.com': { A: ['93.184.216.36'] },
    'down.test-site.com': { A: ['93.184.216.37'] }, 'gone.test-site.com': { A: ['93.184.216.38'] }, 'private.test-site.com': { A: ['10.0.0.1'] }, 'gone-site.org': { A: ['93.184.216.39'] },
    'test-site.com': { MX: ['1 aspmx.l.google.com.'], NS: ['ana.ns.cloudflare.com.', 'bob.ns.cloudflare.com.'], TXT: ['"v=spf1 include:_spf.google.com include:sendgrid.net ~all"', '"atlassian-domain-verification=abc"', '"google-site-verification=xyz"'] },
  };
  const T = { A: 1, NS: 2, MX: 15, TXT: 16, AAAA: 28 };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input)); calls.push(url.href);
    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      const name = url.searchParams.get('name').replace(/^www\./, ''); const type = url.searchParams.get('type');
      const recs = dns[name]?.[type] || [];
      return Response.json({ Status: dns[name] || dns[name.split('.').slice(-2).join('.')] ? 0 : 3, AD: false, Answer: recs.map((data) => ({ name: name + '.', type: T[type], TTL: 300, data })) });
    }
    const h = url.hostname;
    if (h === 'shop.test-site.com') return new Response(WP_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', server: 'nginx/1.25.3', 'x-powered-by': 'PHP/8.2.1', 'set-cookie': 'PHPSESSID=secret123; path=/', 'cf-ray': 'abc-EWR' } });
    if (h === 'next.test-site.com') return new Response(NEXT_HTML, { status: 200, headers: { 'content-type': 'text/html', 'x-powered-by': 'Next.js', 'x-vercel-id': 'iad1::abc', server: 'Vercel' } });
    if (h === 'redirect.test-site.com') return new Response(null, { status: 301, headers: { location: 'https://shop.test-site.com/' } });
    if (h === 'down.test-site.com') throw new Error('connect ECONNREFUSED');
    if (h === 'gone.test-site.com' || h === 'gone-site.org') return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response('?', { status: 599 });
  };
  return { fetchImpl, calls };
}

export function fakeFacilitator() {
  const f = { verified: [], settled: [],
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); const a = payload?.payload?.authorization; return a && a.to.toLowerCase() === req.payTo.toLowerCase() && String(a.value) === String(req.amount) ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'fake_invalid' }; },
    async settle(payload, req) { f.settled.push(req); return { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from }; },
  };
  return f;
}
export function memKv() { const m = new Map(); return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; }

export async function makeApp({ limiter, v1FetchImpl, net = fakeNet(), appOpts = {} } = {}) {
  const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, targetFetch: net.fetchImpl, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, net };
}
