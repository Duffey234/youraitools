import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, fakeNet, BASE, PAY_TO } from './helpers.js';
import { OPENAPI_PATHS } from '../src/discovery.js';
import { DETECT_DESCRIPTION } from '../src/app.js';
import { headAsGet } from '../src/head.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const SHOP = 'https://shop.test-site.com';

test('unpaid: 402 on GET and POST (v2 header: 3000 atomic USDC, Base, payTo, valid Bazaar; v1 body); bare probes too; no network', async () => {
  const net = fakeNet();
  const { fetchApp } = await makeApp({ net });
  for (const [u, init] of [[`${BASE}/v1/detect?url=${encodeURIComponent(SHOP)}`], [`${BASE}/v1/detect`], [`${BASE}/v1/detect`, json({ url: SHOP })], [`${BASE}/v1/detect`, json({})], [`${BASE}/v1/detect`, { method: 'POST' }]]) {
    const r = await fetchApp(u, init);
    assert.equal(r.status, 402, `${init?.method || 'GET'} ${u} ${init?.body || ''}`);
    const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
    assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', '3000', PAY_TO, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
    assert.equal(req.resource.url, `${BASE}/v1/detect`);
    assert.equal(req.resource.serviceName, 'StackDetect by AgentGate'); assert.equal(req.resource.tags[0], 'data');
    assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
    const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, '3000'); assert.equal(b.accepts[0].network, 'base');
  }
  assert.equal(net.calls.length, 0, 'a 402 never touches the network');
});

test('HEAD on the paid route = 402 + PAYMENT-REQUIRED, no body, payment headers stripped (never settles)', async () => {
  const { app, facilitator } = await makeApp();
  const h = headAsGet((req) => app.fetch(req));
  const r = await h(new Request(`${BASE}/v1/detect?url=shop.test-site.com`, { method: 'HEAD', headers: { 'x-payment': 'junk', 'payment-signature': 'junk' } }));
  assert.equal(r.status, 402); assert.ok(r.headers.get('payment-required')); assert.equal(await r.text(), '');
  const r2 = await h(new Request(`${BASE}/v1/detect`, { method: 'HEAD' }));
  assert.equal(r2.status, 402); assert.equal(decode(r2.headers.get('payment-required')).accepts[0].amount, '3000');
  assert.equal(facilitator.verified.length, 0);
});

test('malformed or blocked URLs: 400 before payment, never charged; oversize body 413', async () => {
  const { fetchApp, facilitator, net } = await makeApp();
  for (const [u, init] of [[`${BASE}/v1/detect?url=ftp://x.com`], [`${BASE}/v1/detect?url=http://localhost/`], [`${BASE}/v1/detect?url=http://10.0.0.1/`], [`${BASE}/v1/detect?url=http://[::1]/`],
    [`${BASE}/v1/detect?url=https://a.b.local`], [`${BASE}/v1/detect?url=https://x.com:8080/`], [`${BASE}/v1/detect?url=https://u:p@x.com/`], [`${BASE}/v1/detect?url=https://stackdetect.agentgate.workers.dev/`],
    [`${BASE}/v1/detect`, json({ url: 5 })], [`${BASE}/v1/detect`, json({ hello: 1 })], [`${BASE}/v1/detect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }], [`${BASE}/v1/detect?url=nodot`]]) {
    const r = await fetchApp(u, init); assert.equal(r.status, 400, `${u} ${init?.body || ''}`);
  }
  assert.equal((await fetchApp(`${BASE}/v1/detect`, json({ url: 'x'.repeat(9000) }))).status, 413);
  assert.equal(facilitator.settled.length, 0); assert.equal(net.calls.length, 0);
});

test('paid v2: WordPress shop -> technologies with versions, evidence, DNS providers; cookie values never returned; settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/detect?url=${encodeURIComponent(SHOP)}`);
  assert.equal(r.status, 200, await r.clone().text()); const j = await r.json();
  const by = Object.fromEntries(j.technologies.map((t) => [t.name, t]));
  assert.equal(by.WordPress.version, '6.6.2'); assert.equal(by.WordPress.confidence, 100);
  assert.equal(by.Nginx.version, '1.25.3'); assert.equal(by.PHP.version, '8.2.1');
  assert.equal(by.jQuery.version, '3.7.1');
  for (const n of ['WooCommerce', 'Google Analytics', 'Stripe', 'Meta Pixel', 'Google Fonts', 'Cloudflare', 'Open Graph', 'MySQL']) assert.ok(by[n], n);
  assert.deepEqual(j.providers.email, ['Google Workspace']); assert.ok(j.providers.email_delivery.includes('SendGrid')); assert.deepEqual(j.providers.dns, ['Cloudflare DNS']);
  assert.ok(j.providers.verified_saas.includes('Atlassian'));
  assert.ok(!JSON.stringify(j).includes('secret123'), 'cookie value never returned');
  assert.equal(j.title, 'Test Shop'); assert.equal(j.tier, 'full');
  assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '3000');
  // POST + bare domain + redirect
  const p = await v2pay(fetchApp)(`${BASE}/v1/detect`, json({ url: 'redirect.test-site.com' }));
  assert.equal(p.status, 200); const pj = await p.json(); assert.equal(pj.final_url, 'https://shop.test-site.com/'); assert.equal(pj.fetched.redirects, 1);
  const n = await (await v2pay(fetchApp)(`${BASE}/v1/detect?url=next.test-site.com`)).json();
  assert.ok(['Next.js', 'React', 'Vercel'].every((x) => n.technologies.some((t) => t.name === x)));
});

test('site unreachable / private / error page with nothing detectable: 4xx/5xx, verified but never settled', async () => {
  const { fetchApp, facilitator } = await makeApp();
  for (const [u, status] of [['https://down.test-site.com', 502], ['https://private.test-site.com', 400], ['https://gone-site.org', 422]]) {
    const r = await v2pay(fetchApp)(`${BASE}/v1/detect?url=${encodeURIComponent(u)}`);
    assert.equal(r.status, status, `${u}: ${await r.clone().text()}`); assert.match((await r.json()).message, /Not charged/);
  }
  assert.equal(facilitator.settled.length, 0);
});

test('paid v1 with the x402-fetch 1.2 client (X-PAYMENT)', async () => {
  const settled = [];
  const v1FetchImpl = async (url, init) => { const b = JSON.parse(init.body); if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: b.paymentPayload.payload.authorization.from }); settled.push(b); return Response.json({ success: true, transaction: '0x' + '12'.repeat(32), network: 'base', payer: b.paymentPayload.payload.authorization.from }); };
  const { fetchApp } = await makeApp({ v1FetchImpl });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const pay = wrapFetchWithPayment(fetchApp, wallet);
  const r = await pay(`${BASE}/v1/detect?url=${encodeURIComponent(SHOP)}`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok((await r.json()).technologies.length > 5);
  assert.equal(decodeXPaymentResponse(r.headers.get('x-payment-response')).success, true);
  assert.equal(settled.length, 1); assert.equal(settled[0].paymentRequirements.maxAmountRequired, '3000');
});

test('free preview: names + categories only (no versions, evidence or DNS), 400 on bad input, 429 rate limit, errors are clean', async () => {
  const net = fakeNet();
  const { fetchApp } = await makeApp({ net });
  const r = await fetchApp(`${BASE}/v1/preview?url=${encodeURIComponent(SHOP)}`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.ok(j.technologies.includes('WordPress') && typeof j.technologies[0] === 'string');
  assert.ok(!JSON.stringify(j).includes('6.6.2'), 'no versions in preview'); assert.equal(j.providers, undefined); assert.equal(j.dns, undefined);
  assert.ok(!j.technologies.includes('Google Workspace'), 'DNS-only hits are paid-tier');
  assert.ok(!net.calls.some((u) => /type=(MX|NS|TXT)/.test(u)), 'preview makes no MX/NS/TXT queries');
  assert.match(j.full.url, /\/v1\/detect\?url=/);
  assert.equal((await fetchApp(`${BASE}/v1/preview`, json({ url: SHOP }))).status, 200);
  assert.equal((await fetchApp(`${BASE}/v1/preview?url=http://127.0.0.1/`)).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/preview`)).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/preview?url=down.test-site.com`)).status, 502);
  const { fetchApp: limitedApp } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  const l = await limitedApp(`${BASE}/v1/preview?url=${SHOP}`); assert.equal(l.status, 429); assert.ok(l.headers.get('retry-after'));
});

test('remote MCP: initialize, tools/list, detect_stack (preview tier), bad input is a tool error, unknown tool is -32602', async () => {
  const { fetchApp } = await makeApp();
  const rpc = async (body) => (await fetchApp(`${BASE}/mcp`, json(body))).json();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'stackdetect');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); assert.deepEqual(list.result.tools.map((t) => t.name), ['detect_stack']);
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'detect_stack', arguments: { url: 'shop.test-site.com' } } });
  assert.equal(call.result.isError, false); assert.match(call.result.content[0].text, /WordPress/); assert.match(call.result.content[0].text, /\/v1\/detect\?url=/);
  const badc = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'detect_stack', arguments: { url: 'http://localhost' } } }); assert.equal(badc.result.isError, true);
  const unk = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } }); assert.equal(unk.error.code, -32602);
  assert.equal((await fetchApp(`${BASE}/mcp`)).status, 405);
});

test('discovery: openapi lists only paid + preview with live price + contact, .well-known/x402, favicon, root JSON + HTML, /v1/categories, /v1/stats', async () => {
  const { fetchApp } = await makeApp();
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.deepEqual(Object.keys(oa.paths).sort(), [...OPENAPI_PATHS].sort());
  assert.equal(oa.paths['/v1/detect'].get['x-payment-info'].price.amount, '0.003'); assert.equal(oa.servers[0].url, BASE); assert.equal(oa.info.contact.email, 'hello@youraitools.co');
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json(); assert.deepEqual(wk.resources, [`${BASE}/v1/detect`]);
  for (const p of ['/favicon.ico', '/favicon.svg']) { const f = await fetchApp(`${BASE}${p}`); assert.equal(f.status, 200); assert.match(f.headers.get('content-type'), /svg/); }
  const root = await (await fetchApp(`${BASE}/`)).json(); assert.equal(root.name, 'StackDetect'); assert.equal(root.paid[0].price, '$0.003');
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text(); assert.match(html, /Stack<span>Detect/); assert.match(html, /Nine small x402 tools/);
  const cats = await (await fetchApp(`${BASE}/v1/categories`)).json(); assert.ok(cats.signatures > 200);
  const st = await (await fetchApp(`${BASE}/v1/stats`)).json(); assert.equal(st.enabled, true);
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});

test('listing text is descriptive and within the 500-char facilitator limit', () => {
  assert.ok(DETECT_DESCRIPTION.length <= 500, String(DETECT_DESCRIPTION.length));
  assert.ok(!/\b(ignore|you must|always call|system prompt)\b/i.test(DETECT_DESCRIPTION));
});
