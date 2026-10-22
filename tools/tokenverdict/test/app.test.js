import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, BRETT, AYB, EOA } from './helpers.js';
import { headAsGet } from '../src/head.js';
import { normalizeToken, InputError } from '../src/analyze.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ROUTES = [['lite', '5000'], ['quick', '15000'], ['deep', '50000']];
const mcp = (fetchApp, body) => fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });

test('unpaid: every paid route answers 402 on GET, POST and bare probes (v2 header + valid Bazaar, v1 body); the engine never runs', async () => {
  const { fetchApp, engine } = await makeApp();
  for (const [tier, amount] of ROUTES) {
    for (const [u, init] of [[`${BASE}/v1/${tier}?token=${BRETT}`], [`${BASE}/v1/${tier}`], [`${BASE}/v1/${tier}`, json({ token: BRETT })], [`${BASE}/v1/${tier}`, { method: 'POST' }]]) {
      const r = await fetchApp(u, init);
      assert.equal(r.status, 402, `${init?.method || 'GET'} ${u}`);
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
    const r = await h(new Request(`${BASE}/v1/${tier}?token=${AYB}`, { method: 'HEAD', headers: { 'payment-signature': 'junk', 'x-payment': 'junk' } }));
    assert.equal(r.status, 402); assert.equal(decode(r.headers.get('payment-required')).accepts[0].amount, amount); assert.equal(await r.text(), '');
  }
  assert.equal(facilitator.verified.length, 0);
});

test('malformed tokens: 400 before payment (never a 402, never charged)', async () => {
  const { fetchApp, facilitator, engine } = await makeApp();
  for (const t of ['0x123', 'brett', '0x' + 'g'.repeat(40), '0x' + '1'.repeat(41), '532f27101965dd16442E59d40670FaF5eBB142E4x']) {
    assert.equal((await fetchApp(`${BASE}/v1/quick?token=${encodeURIComponent(t)}`)).status, 400, t);
    assert.equal((await fetchApp(`${BASE}/v1/preview?token=${encodeURIComponent(t)}`)).status, 400, t);
  }
  assert.equal((await fetchApp(`${BASE}/v1/quick`, json({ token: 5 }))).status, 400);
  assert.equal(facilitator.settled.length, 0); assert.equal(engine.calls.length, 0);
  assert.equal(normalizeToken(' 0x532F27101965dd16442E59d40670FaF5eBB142E4 '), BRETT);
  assert.throws(() => normalizeToken('0x0000000000000000000000000000000000000000'), InputError);
});

test('paid v2 quick on a honeypot: DANGER with the honeypot reason and simulation evidence; settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/quick?token=${AYB}`);
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  assert.equal(j.verdict, 'DANGER'); assert.equal(j.tier, 'quick');
  assert.ok(j.reasons.some((x) => x.code === 'honeypot'));
  assert.equal(j.checks.sellability.buy_ok, true); assert.equal(j.checks.sellability.sell_ok, false);
  assert.match(j.disclaimer, /not financial advice/i); assert.ok(j.limits.length >= 3);
  assert.equal(j.card, `${BASE}/t/${AYB}`);
  assert.ok(r.headers.get('PAYMENT-RESPONSE')); assert.equal(facilitator.settled.length, 1);
});

test('paid v2 deep on BRETT: SAFE with the deep section; lite returns the compact view', async () => {
  const { fetchApp } = await makeApp();
  const d = await (await v2pay(fetchApp)(`${BASE}/v1/deep?token=${BRETT}`)).json();
  assert.equal(d.verdict, 'SAFE'); assert.equal(d.tier, 'deep'); assert.ok(Array.isArray(d.deep.pools) && d.deep.pools.length > 1); assert.ok(d.deep.simulations.length >= 1);
  const l = await (await v2pay(fetchApp)(`${BASE}/v1/lite?token=${BRETT}`)).json();
  assert.equal(l.tier, 'lite'); assert.equal(l.verdict, 'SAFE'); assert.ok(Array.isArray(l.reasons)); assert.equal(l.key.sellable, true); assert.equal(l.checks, undefined);
});

test('paid v1 (x402-fetch) lite works and returns X-PAYMENT-RESPONSE', async () => {
  const { fetchApp } = await makeApp({ v1FetchImpl: async () => new Response(JSON.stringify({ isValid: true, success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base', payer: '0x' + '1'.repeat(40) }), { headers: { 'content-type': 'application/json' } }) });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const pay = (input, init) => fetchApp(input, { ...init, headers: { ...(init?.headers || {}) } });
  const r = await wrapFetchWithPayment(pay, wallet)(`${BASE}/v1/lite?token=${AYB}`);
  assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).verdict, 'DANGER');
  assert.equal(decodeXPaymentResponse(r.headers.get('x-payment-response')).success, true);
});

test('engine errors after payment are never settled (EOA 422, source outage 503)', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r1 = await v2pay(fetchApp)(`${BASE}/v1/quick?token=${EOA}`); assert.equal(r1.status, 422);
  const r2 = await v2pay(fetchApp)(`${BASE}/v1/quick?token=0x2222222222222222222222222222222222222222`); assert.equal(r2.status, 503);
  assert.equal(facilitator.settled.length, 0);
});

test('free preview: verdict + counts only (no reasons/evidence), links to paid tiers; rate limit 429', async () => {
  const { fetchApp } = await makeApp();
  const j = await (await fetchApp(`${BASE}/v1/preview?token=${AYB}`)).json();
  assert.equal(j.verdict, 'DANGER'); assert.equal(j.tier, 'preview'); assert.equal(j.reasons, undefined); assert.equal(j.checks, undefined);
  assert.ok(j.flags.danger >= 1); assert.equal(j.sellable, false); assert.equal(j.full.lite, `${BASE}/v1/lite?token=${AYB}`);
  const { fetchApp: lim } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await lim(`${BASE}/v1/preview?token=${AYB}`)).status, 429);
});

test('shareable card: HTML with OG/Twitter tags and unlock links; SVG card; errors are clean pages', async () => {
  const { fetchApp } = await makeApp();
  const r = await fetchApp(`${BASE}/t/${AYB}`); assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta property="og:image" content="[^"]+\/og\/danger\.png"/); assert.match(html, /twitter:card/); assert.match(html, /DANGER/);
  assert.ok(html.includes(`/v1/quick?token=${AYB}`)); assert.match(html, /not financial advice/i);
  const svg = await fetchApp(`${BASE}/t/${BRETT}/card.svg`); assert.equal(svg.status, 200); assert.match(svg.headers.get('content-type'), /svg/); assert.match(await svg.text(), /SAFE/);
  assert.equal((await fetchApp(`${BASE}/t/0x123`)).status, 400);
  assert.equal((await fetchApp(`${BASE}/t/${EOA}`)).status, 422);
  const png = await fetchApp(`${BASE}/og/safe.png`); assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png');
});

test('MCP: tools/list exposes check_token; tools/call returns the free verdict text + structured content', async () => {
  const { fetchApp } = await makeApp();
  const parse = async (r) => { const t = await r.text(); return JSON.parse(t.startsWith('{') ? t : t.split('\n').find((l) => l.startsWith('data:')).slice(5)); };
  const l = await parse(await mcp(fetchApp, { method: 'tools/list', params: {} }));
  assert.deepEqual(l.result.tools.map((t) => t.name), ['check_token']);
  const c = await parse(await mcp(fetchApp, { method: 'tools/call', params: { name: 'check_token', arguments: { token: AYB } } }));
  assert.match(c.result.content[0].text, /DANGER/); assert.equal(c.result.structuredContent.verdict, 'DANGER');
  const bad = await parse(await mcp(fetchApp, { method: 'tools/call', params: { name: 'check_token', arguments: { token: 'nope' } } }));
  assert.equal(bad.result.isError, true);
});

test('discovery: openapi lists the paid + free routes, .well-known/x402 lists the 3 paid resources, info JSON and landing', async () => {
  const { fetchApp } = await makeApp();
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  for (const p of ['/v1/lite', '/v1/quick', '/v1/deep', '/v1/preview']) assert.ok(oa.paths[p], p);
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(wk.resources.map((u) => u.replace(BASE, '')).sort(), ['/v1/deep', '/v1/lite', '/v1/quick']);
  const info = await (await fetchApp(`${BASE}/`)).json(); assert.match(JSON.stringify(info), /TokenVerdict/);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text(); assert.match(html, /TokenVerdict/); assert.match(html, /not financial advice|no guarantee/i);
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});
