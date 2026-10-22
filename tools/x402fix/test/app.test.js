import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, TARGET, BROKEN, DOWN } from './helpers.js';
import { headAsGet } from '../src/head.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ROUTES = [['lite', '5000'], ['check', '20000'], ['site', '50000']];
const U = encodeURIComponent(TARGET);
const mcp = (fetchApp, body) => fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });

test('unpaid: every paid route answers 402 on GET, POST, empty POST and bare probes (v2 header + valid Bazaar, v1 body); engine never runs', async () => {
  const { fetchApp, engine } = await makeApp();
  for (const [tier, amount] of ROUTES) {
    for (const [u, init] of [[`${BASE}/v1/${tier}?url=${U}`], [`${BASE}/v1/${tier}`], [`${BASE}/v1/${tier}`, json({ url: TARGET })], [`${BASE}/v1/${tier}`, { method: 'POST' }], [`${BASE}/v1/${tier}`, json({})]]) {
      const r = await fetchApp(u, init);
      assert.equal(r.status, 402, `${init?.method || 'GET'} ${u} ${init?.body || ''}`);
      const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
      assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', amount, PAY_TO, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
      assert.equal(req.resource.url, `${BASE}/v1/${tier}`);
      assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
      const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount); assert.equal(b.accepts[0].network, 'base');
    }
  }
  assert.equal(engine.calls.length, 0);
});

test('HEAD = 402 + PAYMENT-REQUIRED with no body and never settles', async () => {
  const { app, facilitator } = await makeApp();
  const h = headAsGet((req) => app.fetch(req));
  for (const [tier, amount] of ROUTES) {
    const r = await h(new Request(`${BASE}/v1/${tier}?url=${U}`, { method: 'HEAD', headers: { 'payment-signature': 'junk', 'x-payment': 'junk' } }));
    assert.equal(r.status, 402); assert.equal(decode(r.headers.get('payment-required')).accepts[0].amount, amount); assert.equal(await r.text(), '');
  }
  assert.equal(facilitator.verified.length, 0);
});

test('malformed or private URLs: 400 before payment (never a 402, never charged)', async () => {
  const { fetchApp, facilitator, engine } = await makeApp();
  const bad = ['url=nope', 'url=ftp%3A%2F%2Fx.com%2Fa', 'url=http%3A%2F%2Flocalhost%2Fx', 'url=https%3A%2F%2F127.0.0.1%2Fx', 'url=https%3A%2F%2F10.1.2.3%2Fx', 'url=https%3A%2F%2F169.254.169.254%2Flatest', 'url=https%3A%2F%2F192.168.0.1', 'url=https%3A%2F%2F%5B%3A%3A1%5D%2Fx', 'url=https%3A%2F%2Fmetadata.internal%2Fx', 'url=https%3A%2F%2Fuser%3Apass%40api.example.com%2Fx', 'url=https%3A%2F%2Fapi.example.com%3A22%2Fx', `url=${U}&method=DELETE`, `url=${U}&framework=rails`, 'method=GET'];
  for (const q of bad) {
    assert.equal((await fetchApp(`${BASE}/v1/check?${q}`)).status, 400, q);
    assert.equal((await fetchApp(`${BASE}/v1/preview?${q}`)).status, 400, q);
  }
  assert.equal((await fetchApp(`${BASE}/v1/site`, json({ url: 5 }))).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/site`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/lite`, json({ url: `https://a.com/${'x'.repeat(5000)}` }))).status, 413);
  assert.equal(facilitator.settled.length, 0); assert.equal(engine.calls.length, 0);
});

test('paid v2: all three tiers return the report, settled once each; method forwarded; site uses the site engine', async () => {
  const { fetchApp, facilitator, engine } = await makeApp();
  for (const [tier] of ROUTES) {
    const r = await v2pay(fetchApp)(`${BASE}/v1/${tier}?url=${encodeURIComponent(BROKEN)}&method=POST`);
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json(); assert.equal(j.grade, 'F'); assert.equal(j.tier, tier); assert.equal(j.fixes[0].id, 'get_200');
    assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  }
  assert.equal(facilitator.settled.length, 3);
  assert.deepEqual(engine.calls.map((c) => c[1]), ['lite', 'check', 'site']);
  const p = await v2pay(fetchApp)(`${BASE}/v1/lite`, json({ url: TARGET }));
  assert.equal(p.status, 200); assert.equal((await p.json()).grade, 'A');
});

test('paid v1 (x402-fetch) lite works and returns X-PAYMENT-RESPONSE', async () => {
  const { fetchApp } = await makeApp({ v1FetchImpl: async () => new Response(JSON.stringify({ isValid: true, success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base', payer: '0x' + '1'.repeat(40) }), { headers: { 'content-type': 'application/json' } }) });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(fetchApp, wallet)(`${BASE}/v1/lite?url=${U}`);
  assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).grade, 'A');
  assert.equal(decodeXPaymentResponse(r.headers.get('x-payment-response')).success, true);
});

test('internal failure after payment: 503, never settled', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/check?url=${encodeURIComponent(DOWN)}`); assert.equal(r.status, 503); assert.ok(r.headers.get('retry-after'));
  assert.equal(facilitator.settled.length, 0);
});

test('free preview: grade + counts only (no fixes, no checks), links to paid tiers; rate limit 429', async () => {
  const { fetchApp } = await makeApp();
  const j = await (await fetchApp(`${BASE}/v1/preview?url=${encodeURIComponent(BROKEN)}`)).json();
  assert.equal(j.grade, 'F'); assert.equal(j.status, 'broken'); assert.equal(j.fixes, undefined); assert.equal(j.checks, undefined); assert.equal(j.counts.errors, 1);
  assert.equal(j.full.check, `${BASE}/v1/check?url=${encodeURIComponent(BROKEN)}`);
  const { fetchApp: lim } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await lim(`${BASE}/v1/preview?url=${U}`)).status, 429);
});

test('MCP: tools/list exposes check_x402_endpoint; tools/call returns the free grade text + structured content', async () => {
  const { fetchApp } = await makeApp();
  const parse = async (r) => JSON.parse(await r.text());
  const i = await parse(await mcp(fetchApp, { method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  assert.equal(i.result.serverInfo.name, 'x402fix');
  const l = await parse(await mcp(fetchApp, { method: 'tools/list', params: {} }));
  assert.deepEqual(l.result.tools.map((t) => t.name), ['check_x402_endpoint']);
  const c = await parse(await mcp(fetchApp, { method: 'tools/call', params: { name: 'check_x402_endpoint', arguments: { url: BROKEN } } }));
  assert.match(c.result.content[0].text, /grade F/); assert.equal(c.result.structuredContent.grade, 'F'); assert.equal(c.result.structuredContent.fixes, undefined);
  const bad = await parse(await mcp(fetchApp, { method: 'tools/call', params: { name: 'check_x402_endpoint', arguments: { url: 'http://localhost/x' } } }));
  assert.equal(bad.result.isError, true);
});

test('discovery: openapi, .well-known/x402 (3 paid resources), info JSON, landing, favicon; no tax/financial-advice wording', async () => {
  const { fetchApp } = await makeApp();
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  for (const p of ['/v1/lite', '/v1/check', '/v1/site', '/v1/preview']) assert.ok(oa.paths[p], p);
  assert.equal(oa.paths['/v1/site'].get['x-x402'].amount, '50000'); assert.equal(oa.paths['/v1/check'].get['x-payment-info'].price.amount, '0.02');
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(wk.resources.map((u) => u.replace(BASE, '')).sort(), ['/v1/check', '/v1/lite', '/v1/site']);
  const info = await (await fetchApp(`${BASE}/`)).json(); assert.equal(info.name, 'x402fix'); assert.equal(info.paid.length, 3);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /x402<span>fix/); assert.match(html, /never pays/i); assert.match(html, /Eleven small x402 tools/);
  for (const s of [html, JSON.stringify(info), JSON.stringify(oa)]) assert.doesNotMatch(s, /\b(tax advice|financial advice|investment|buy signal|price target)\b/i);
  const fav = await fetchApp(`${BASE}/favicon.ico`); assert.equal(fav.status, 200); assert.match(fav.headers.get('content-type'), /svg/);
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});

test('own target unreachable (loopback): paid lite answers 503 and is never settled; result is not an F', async () => {
  const net = { fetchImpl: async () => { throw new Error('self_probe_unavailable: test'); } };
  const { fetchApp, facilitator } = await makeApp({ net, engine: { check: undefined, site: undefined } });
  const r = await v2pay(fetchApp)(`${BASE}/v1/lite?url=${encodeURIComponent('https://api.youraitools.co/agentready/v1/lite')}`);
  assert.equal(r.status, 503); assert.equal(facilitator.settled.length, 0);
});
