import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://webread.example.com';

/** Fake web: { 'https://site/path': { status, headers, body } | Response factory } */
export function fakeWeb(pages) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, ua: init.headers?.['user-agent'] });
    const p = pages[url];
    if (typeof p === 'function') return p(url, init);
    if (!p) return new Response('not found', { status: 404 });
    return new Response(p.body ?? '', { status: p.status ?? 200, headers: p.headers ?? { 'content-type': 'text/html; charset=utf-8' } });
  };
  return { fetchImpl, seen };
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
export function makeApp({ pages = {}, limiter, v1FetchImpl, workMs, appOpts = {} } = {}) {
  const web = fakeWeb(pages); const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const app = createApp({ facilitatorClient: facilitator, fetchImpl: web.fetchImpl, dns: false, payTo: PAY_TO, network: NETWORK, price: '$0.002', publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, workMs, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, web, facilitator, stats };
}
export const PAGE = `<!doctype html><html lang="en"><head><title>Hello Page</title><meta name="description" content="Desc"></head><body><nav><a href="/">Home</a></nav><main><h1>Hello</h1><p>World <a href="/a">link</a></p></main><footer>f</footer><script>x()</script></body></html>`;
