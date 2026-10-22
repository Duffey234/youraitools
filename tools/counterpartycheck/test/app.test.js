import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, LAZARUS, CLEAN, DOWN } from './helpers.js';
import { headAsGet } from '../src/head.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ROUTES = [['lite', '5000'], ['quick', '15000'], ['full', '50000']];
const mcp = (fetchApp, body) => fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });

test('unpaid: every paid route answers 402 on GET, POST, empty POST and bare probes (v2 header + valid Bazaar, v1 body); engine never runs', async () => {
  const { fetchApp, engine } = await makeApp();
  for (const [tier, amount] of ROUTES) {
    for (const [u, init] of [[`${BASE}/v1/${tier}?address=${CLEAN}`], [`${BASE}/v1/${tier}`], [`${BASE}/v1/${tier}`, json({ address: CLEAN, chain: 'base' })], [`${BASE}/v1/${tier}`, { method: 'POST' }], [`${BASE}/v1/${tier}`, json({})]]) {
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
    const r = await h(new Request(`${BASE}/v1/${tier}?address=${LAZARUS}`, { method: 'HEAD', headers: { 'payment-signature': 'junk', 'x-payment': 'junk' } }));
    assert.equal(r.status, 402); assert.equal(decode(r.headers.get('payment-required')).accepts[0].amount, amount); assert.equal(await r.text(), '');
  }
  assert.equal(facilitator.verified.length, 0);
});

test('malformed input: 400 before payment (never a 402, never charged)', async () => {
  const { fetchApp, facilitator, engine } = await makeApp();
  for (const q of ['address=0x123', 'address=hello', `address=0x${'g'.repeat(40)}`, `address=${CLEAN}&chain=bitcoin`, `address=${CLEAN}&intent=steal`, `address=${CLEAN}&chain=solana`, 'address=FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte&chain=base', 'chain=base']) {
    assert.equal((await fetchApp(`${BASE}/v1/quick?${q}`)).status, 400, q);
    assert.equal((await fetchApp(`${BASE}/v1/preview?${q}`)).status, 400, q);
  }
  assert.equal((await fetchApp(`${BASE}/v1/full`, json({ address: 5 }))).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/full`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal(facilitator.settled.length, 0); assert.equal(engine.calls.length, 0);
});

test('paid v2: block verdict for a sanctioned address, all three tiers, settled once each; chain/intent forwarded', async () => {
  const { fetchApp, facilitator, engine } = await makeApp();
  for (const [tier] of ROUTES) {
    const r = await v2pay(fetchApp)(`${BASE}/v1/${tier}?address=${LAZARUS.toUpperCase().replace('0X', '0x')}&chain=ethereum&intent=interact`);
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json(); assert.equal(j.verdict, 'block'); assert.equal(j.tier, tier); assert.equal(j.reasons[0].code, 'ofac_sdn');
    assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  }
  assert.equal(facilitator.settled.length, 3);
  assert.deepEqual(engine.calls.map((c) => c.slice(1)), [['lite', 'ethereum', 'interact'], ['quick', 'ethereum', 'interact'], ['full', 'ethereum', 'interact']]);
  const p = await v2pay(fetchApp)(`${BASE}/v1/lite`, json({ address: 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte' }));
  assert.equal(p.status, 200); assert.equal((await p.json()).chain, 'solana');
});

test('paid v1 (x402-fetch) lite works and returns X-PAYMENT-RESPONSE', async () => {
  const { fetchApp } = await makeApp({ v1FetchImpl: async () => new Response(JSON.stringify({ isValid: true, success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base', payer: '0x' + '1'.repeat(40) }), { headers: { 'content-type': 'application/json' } }) });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(fetchApp, wallet)(`${BASE}/v1/lite?address=${LAZARUS}`);
  assert.equal(r.status, 200, await r.clone().text()); assert.equal((await r.json()).verdict, 'block');
  assert.equal(decodeXPaymentResponse(r.headers.get('x-payment-response')).success, true);
});

test('chain RPC outage after payment: 503, never settled', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/quick?address=${DOWN}`); assert.equal(r.status, 503); assert.ok(r.headers.get('retry-after'));
  assert.equal(facilitator.settled.length, 0);
});

test('free preview: verdict + counts only (no reasons), links to paid tiers; rate limit 429', async () => {
  const { fetchApp } = await makeApp();
  const j = await (await fetchApp(`${BASE}/v1/preview?address=${LAZARUS}&chain=ethereum`)).json();
  assert.equal(j.verdict, 'block'); assert.equal(j.tier, 'preview'); assert.equal(j.reasons, undefined); assert.equal(j.checks, undefined);
  assert.equal(j.flags.danger, 1); assert.equal(j.full.lite, `${BASE}/v1/lite?address=${LAZARUS}&chain=ethereum&intent=pay`);
  const { fetchApp: lim } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await lim(`${BASE}/v1/preview?address=${LAZARUS}`)).status, 429);
});

test('MCP: tools/list exposes check_counterparty; tools/call returns the free verdict text + structured content', async () => {
  const { fetchApp } = await makeApp();
  const parse = async (r) => JSON.parse(await r.text());
  const i = await parse(await mcp(fetchApp, { method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  assert.equal(i.result.serverInfo.name, 'counterpartycheck');
  const l = await parse(await mcp(fetchApp, { method: 'tools/list', params: {} }));
  assert.deepEqual(l.result.tools.map((t) => t.name), ['check_counterparty']);
  const c = await parse(await mcp(fetchApp, { method: 'tools/call', params: { name: 'check_counterparty', arguments: { address: LAZARUS, chain: 'ethereum' } } }));
  assert.match(c.result.content[0].text, /BLOCK/); assert.equal(c.result.structuredContent.verdict, 'block'); assert.equal(c.result.structuredContent.reasons, undefined);
  const bad = await parse(await mcp(fetchApp, { method: 'tools/call', params: { name: 'check_counterparty', arguments: { address: 'nope' } } }));
  assert.equal(bad.result.isError, true);
});

test('discovery: openapi, .well-known/x402 (3 paid resources), info JSON, landing, favicon; safety-check copy only', async () => {
  const { fetchApp } = await makeApp();
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  for (const p of ['/v1/lite', '/v1/quick', '/v1/full', '/v1/preview']) assert.ok(oa.paths[p], p);
  assert.equal(oa.paths['/v1/full'].get['x-x402'].amount, '50000');
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(wk.resources.map((u) => u.replace(BASE, '')).sort(), ['/v1/full', '/v1/lite', '/v1/quick']);
  const info = await (await fetchApp(`${BASE}/`)).json(); assert.equal(info.name, 'CounterpartyCheck'); assert.equal(info.paid.length, 3);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /CounterpartyCheck/); assert.match(html, /not legal, compliance or financial advice/i);
  for (const s of [html, JSON.stringify(info), JSON.stringify(oa)]) assert.doesNotMatch(s, /\b(buy signal|sell signal|price target|moon|pump|profit|investment advice)\b/i, 'safety-check copy only');
  const fav = await fetchApp(`${BASE}/favicon.ico`); assert.equal(fav.status, 200); assert.match(fav.headers.get('content-type'), /svg/);
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});

// ---- fail closed, end to end with the real engine and every data source failing ----
import { checkCounterparty } from '../src/counterparty.js';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
test('fail closed end to end: RPCs failing -> preview/MCP caution + low + sources_failed (never ok); paid tiers 503, never settled', async () => {
  const { fetchApp, facilitator } = await makeApp({ engine: { check: checkCounterparty } }); // fakeNet: every fetch answers 599
  for (const q of [`address=${USDC_BASE}&intent=pay`, `address=${USDC_BASE}&chain=polygon`, 'address=FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte', 'address=vitalik.eth']) {
    const r = await fetchApp(`${BASE}/v1/preview?${q}`); assert.equal(r.status, 200, q);
    const j = await r.json();
    assert.equal(j.verdict, 'caution', q); assert.equal(j.confidence, 'low'); assert.ok(j.sources_failed.length, q); assert.ok(j.signals.includes('checks_incomplete'));
  }
  const m = await (await fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_counterparty', arguments: { address: USDC_BASE } } }) })).json();
  assert.equal(m.result.structuredContent.verdict, 'caution'); assert.match(m.result.content[0].text, /did not complete: onchain/);
  for (const tier of ['lite', 'quick', 'full']) {
    const r = await v2pay(fetchApp)(`${BASE}/v1/${tier}?address=${USDC_BASE}`);
    assert.equal(r.status, 503, tier); const j = await r.json();
    assert.equal(j.error, 'checks_incomplete'); assert.deepEqual(j.sources_failed, ['onchain']); assert.equal(j.provisional.verdict, 'caution'); assert.equal(j.provisional.confidence, 'low');
    const l = await v2pay(fetchApp)(`${BASE}/v1/${tier}?address=${LAZARUS}&chain=ethereum`);
    assert.equal(l.status, 503); assert.equal((await l.json()).provisional.verdict, 'block');
  }
  assert.equal(facilitator.settled.length, 0);
});

test('names are accepted before payment (paid routes 402, not 400); non-.eth names are a 400', async () => {
  const { fetchApp } = await makeApp();
  assert.equal((await fetchApp(`${BASE}/v1/lite?address=vitalik.eth`)).status, 402);
  const b = await fetchApp(`${BASE}/v1/lite?address=example.com`); assert.equal(b.status, 400); assert.match((await b.json()).message, /ENS name/);
});
