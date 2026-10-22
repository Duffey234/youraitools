import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, PAGE, BASE, PAY_TO, NETWORK } from './helpers.js';

const SITE = { 'https://site.example.org/robots.txt': { body: 'User-agent: *\nDisallow: /secret', headers: { 'content-type': 'text/plain' } }, 'https://site.example.org/page': { body: PAGE } };
const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });

test('unpaid: 402 with v2 header (2000 atomic USDC, Base, payTo, USD Coin v2, Bazaar) and v1 body terms', async () => {
  const { fetchApp } = makeApp({ pages: SITE });
  for (const u of [`${BASE}/v1/read?url=https://site.example.org/page`, `${BASE}/v1/read`]) {
    const r = await fetchApp(u);
    assert.equal(r.status, 402);
    const req = decode(r.headers.get('PAYMENT-REQUIRED'));
    const a = req.accepts[0];
    assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo], [2, 'exact', 'eip155:8453', '2000', PAY_TO]);
    assert.deepEqual(a.extra, { name: 'USD Coin', version: '2' });
    assert.equal(req.resource.url, `${BASE}/v1/read`);
    assert.equal(req.resource.mimeType, 'application/json');
    assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
    const b = await r.json();
    assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, '2000'); assert.equal(b.accepts[0].network, 'base');
  }
});

test('paid v2 read: Markdown served, settled once, robots-respecting UA used', async () => {
  const { fetchApp, facilitator, web } = makeApp({ pages: SITE });
  const r = await v2pay(fetchApp)(`${BASE}/v1/read?url=${encodeURIComponent('https://site.example.org/page')}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.title, 'Hello Page'); assert.match(j.markdown, /^# Hello\n\nWorld \[link\]\(https:\/\/site\.example\.org\/a\)$/); assert.equal(j.robots, 'allowed');
  assert.equal(facilitator.settled.length, 1);
  assert.ok(web.seen.every((s) => /WebReadBot/.test(s.ua)));
  assert.ok(r.headers.get('PAYMENT-RESPONSE'));
});

test('paid v1 read with the x402-fetch 1.2 client (X-PAYMENT)', async () => {
  const calls = [];
  const v1FetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(url.split('/').pop()); return Response.json(url.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0x' + '1'.repeat(64), network: 'base', payer: b.paymentPayload.payload.authorization.from }); };
  const { fetchApp } = makeApp({ pages: SITE, v1FetchImpl });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(fetchApp, wallet)(`${BASE}/v1/read?url=https://site.example.org/page`);
  assert.equal(r.status, 200); assert.equal((await r.json()).title, 'Hello Page');
  assert.equal(decodeXPaymentResponse(r.headers.get('X-PAYMENT-RESPONSE')).success, true);
  assert.deepEqual(calls, ['verify', 'settle']);
});

test('failed reads are never charged: robots disallow 403, private IP 400, 404 upstream 502, binary 415', async () => {
  const pages = { ...SITE, 'https://site.example.org/img': { body: 'PNG', headers: { 'content-type': 'image/png' } } };
  const { fetchApp, facilitator } = makeApp({ pages });
  const pay = v2pay(fetchApp);
  const cases = [['https://site.example.org/secret', 403, 'robots_disallowed'], ['http://10.0.0.1/', 400, 'blocked_ip'], ['https://site.example.org/missing', 502, 'upstream_status'], ['https://site.example.org/img', 415, 'unsupported_content_type'], ['file:///etc/passwd', 400, 'blocked_scheme']];
  for (const [u, status, code] of cases) {
    const r = await pay(`${BASE}/v1/read?url=${encodeURIComponent(u)}`);
    assert.equal(r.status, status, u); assert.equal((await r.json()).error, code, u);
  }
  assert.equal(facilitator.settled.length, 0);
});

test('robots.txt 5xx means disallow; 404 means allow', async () => {
  const { fetchApp } = makeApp({ pages: { 'https://down.example.org/robots.txt': { status: 503, body: '' }, 'https://down.example.org/p': { body: PAGE }, 'https://open.example.org/p': { body: PAGE } } });
  assert.equal((await fetchApp(`${BASE}/v1/read/preview?url=https://down.example.org/p`)).status, 403);
  assert.equal((await fetchApp(`${BASE}/v1/read/preview?url=https://open.example.org/p`)).status, 200);
});

test('free preview: truncated output, rate limited, counted in stats', async () => {
  const long = `<html><body><main><p>${'lorem ipsum '.repeat(1000)}</p></main></body></html>`;
  const { fetchApp } = makeApp({ pages: { ...SITE, 'https://site.example.org/long': { body: long } } });
  const j = await (await fetchApp(`${BASE}/v1/read/preview?url=https://site.example.org/long`)).json();
  assert.equal(j.tier, 'free'); assert.equal(j.markdown.length, 2000); assert.equal(j.truncated, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await (await fetchApp(`${BASE}/v1/stats`)).json()).totals.free_preview, 1);
  const lim = makeApp({ pages: SITE, limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await lim.fetchApp(`${BASE}/v1/read/preview?url=https://site.example.org/page`)).status, 429);
});

test('remote MCP: initialize, tools/list, read_url', async () => {
  const { fetchApp } = makeApp({ pages: SITE });
  const rpc = async (body) => (await fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.serverInfo.name, 'webread');
  assert.deepEqual((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name), ['read_url']);
  const c = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_url', arguments: { url: 'https://site.example.org/page' } } });
  assert.equal(c.result.isError, false); assert.match(c.result.content[0].text, /# Hello/);
});

test('root: JSON for agents, HTML landing page for browsers', async () => {
  const { fetchApp } = makeApp();
  const j = await (await fetchApp(`${BASE}/`)).json();
  assert.equal(j.paid.price, '$0.002'); assert.ok(j.free.includes('/mcp'));
  const h = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(h, /^<!doctype html>/i); assert.ok(h.includes('$0.002 USDC') && h.includes(PAY_TO) && h.includes('/v1/read/preview'));
  assert.ok(h.includes('Agent trust kit') && h.includes('https://agentgate.agentgate.workers.dev') && h.includes('https://injectscan.agentgate.workers.dev') && h.includes('https://domaincheck.agentgate.workers.dev'));
});

test('facilitator client answers /supported without network I/O by default (no cross-request hang on Workers)', async () => {
  const { ResilientFacilitatorClient } = await import('../src/facilitator.js');
  const c = new ResilientFacilitatorClient({ url: 'https://facilitator.invalid', network: 'eip155:8453', staticSupported: true });
  const s = await c.getSupported();
  assert.deepEqual(s.kinds, [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }]);
});
