import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, fakeNet, BASE, PAY_TO, USDC, EOA, ME, REVERTER, approveData } from './helpers.js';
import { OPENAPI_PATHS } from '../src/discovery.js';
import { CHECK_DESCRIPTION, LITE_DESCRIPTION } from '../src/app.js';
import { headAsGet } from '../src/head.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }], spendControls: { maxAmountPerPayment: '$0.02' } });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const DRAIN = { tx: { to: USDC, data: approveData(EOA), from: ME } };
const q = (o) => new URLSearchParams(o).toString();

test('unpaid: 402 on GET and POST (v2 header: 15000 atomic USDC, Base, payTo, valid Bazaar; v1 body); bare probes too; no network', async () => {
  const net = fakeNet();
  const { fetchApp } = await makeApp({ net });
  for (const [u, init] of [[`${BASE}/v1/check?${q({ to: USDC, data: approveData(EOA) })}`], [`${BASE}/v1/check`], [`${BASE}/v1/check`, json(DRAIN)], [`${BASE}/v1/check`, json({})], [`${BASE}/v1/check`, { method: 'POST' }]]) {
    const r = await fetchApp(u, init);
    assert.equal(r.status, 402, `${init?.method || 'GET'} ${u} ${init?.body || ''}`);
    const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
    assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', '15000', PAY_TO, USDC]);
    assert.equal(req.resource.url, `${BASE}/v1/check`);
    assert.equal(req.resource.serviceName, 'SignCheck by AgentGate'); assert.equal(req.resource.tags[0], 'security');
    assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
    const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, '15000'); assert.equal(b.accepts[0].network, 'base');
  }
  assert.equal(net.calls.length, 0, 'a 402 never touches the network');
});

test('HEAD on the paid route = 402 + PAYMENT-REQUIRED, no body, payment headers stripped (never settles)', async () => {
  const { app, facilitator } = await makeApp();
  const h = headAsGet((req) => app.fetch(req));
  const r = await h(new Request(`${BASE}/v1/check?${q({ to: USDC, data: '0x' })}`, { method: 'HEAD', headers: { 'x-payment': 'junk', 'payment-signature': 'junk' } }));
  assert.equal(r.status, 402); assert.ok(r.headers.get('payment-required')); assert.equal(await r.text(), '');
  const r2 = await h(new Request(`${BASE}/v1/check`, { method: 'HEAD' }));
  assert.equal(r2.status, 402); assert.equal(decode(r2.headers.get('payment-required')).accepts[0].amount, '15000');
  assert.equal(facilitator.verified.length, 0);
});

test('malformed input: 400 before payment, never charged; oversize body 413', async () => {
  const { fetchApp, facilitator, net } = await makeApp();
  for (const [u, init] of [[`${BASE}/v1/check?to=nothex`], [`${BASE}/v1/check?${q({ to: USDC, data: '0xabc' })}`], [`${BASE}/v1/check?${q({ to: USDC, value: '-1' })}`], [`${BASE}/v1/check?${q({ to: USDC, chain: 'dogechain' })}`],
    [`${BASE}/v1/check`, json({ hello: 1 })], [`${BASE}/v1/check`, json({ typed_data: { domain: {} } })], [`${BASE}/v1/check`, json({ tx: DRAIN.tx, typed_data: { primaryType: 'X', message: {} } })],
    [`${BASE}/v1/check`, json({ payment_payload: { payload: {} } })], [`${BASE}/v1/check`, json({ payment_required: 'not-base64!!' })], [`${BASE}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }]]) {
    const r = await fetchApp(u, init); assert.equal(r.status, 400, `${u} ${init?.body || ''}: ${await r.clone().text()}`);
  }
  assert.equal((await fetchApp(`${BASE}/v1/check`, json({ tx: { to: USDC, data: '0x' + 'ab'.repeat(70000) } }))).status, 413);
  assert.equal(facilitator.settled.length, 0); assert.equal(net.calls.length, 0);
});

test('paid v2: unlimited approval to an EOA -> DANGER with SPENDER_IS_EOA, token metadata, simulation; settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/check`, json(DRAIN));
  assert.equal(r.status, 200, await r.clone().text()); const j = await r.json();
  assert.equal(j.verdict, 'DANGER'); assert.equal(j.action, 'erc20_approve'); assert.equal(j.tier, 'full');
  assert.match(j.summary, /UNLIMITED USDC/);
  const codes = j.flags.map((f) => f.code); assert.ok(codes.includes('SPENDER_IS_EOA') && codes.includes('UNLIMITED_APPROVAL'), codes.join());
  assert.ok(j.flags.every((f) => f.message));
  assert.equal(j.counterparties.find((p) => p.roles.includes('spender')).type, 'eoa');
  assert.equal(j.onchain.tokens[0].symbol, 'USDC'); assert.equal(j.onchain.simulation.success, true);
  assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '15000');
  // GET with query params
  const g = await v2pay(fetchApp)(`${BASE}/v1/check?${q({ to: REVERTER, data: '0xf2fde38b' + '0'.repeat(24) + EOA.slice(2), from: ME })}`);
  assert.equal(g.status, 200); const gj = await g.json();
  assert.equal(gj.action, 'transfer_ownership'); assert.equal(gj.onchain.simulation.success, false); assert.match(gj.onchain.simulation.revert_reason, /not the owner/);
});

test('RPC down on the paid route: 503, verified but never settled', async () => {
  const { fetchApp, facilitator } = await makeApp({ net: fakeNet({ down: true }) });
  const r = await v2pay(fetchApp)(`${BASE}/v1/check`, json(DRAIN));
  assert.equal(r.status, 503, await r.clone().text()); assert.match((await r.json()).message, /Not charged/);
  assert.equal(facilitator.settled.length, 0);
});

test('paid v1 with the x402-fetch 1.2 client (X-PAYMENT)', async () => {
  const settled = [];
  const v1FetchImpl = async (url, init) => { const b = JSON.parse(init.body); if (url.endsWith('/verify')) return Response.json({ isValid: true, payer: b.paymentPayload.payload.authorization.from }); settled.push(b); return Response.json({ success: true, transaction: '0x' + '12'.repeat(32), network: 'base', payer: b.paymentPayload.payload.authorization.from }); };
  const { fetchApp } = await makeApp({ v1FetchImpl });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const pay = wrapFetchWithPayment(fetchApp, wallet, BigInt(20000));
  const r = await pay(`${BASE}/v1/check`, json(DRAIN));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).verdict, 'DANGER');
  assert.equal(decodeXPaymentResponse(r.headers.get('x-payment-response')).success, true);
  assert.equal(settled.length, 1); assert.equal(settled[0].paymentRequirements.maxAmountRequired, '15000');
});

test('free preview: offline verdict + flag codes only (no reasons, on-chain facts or network), 400 on bad input, 429 rate limit', async () => {
  const net = fakeNet();
  const { fetchApp } = await makeApp({ net });
  const r = await fetchApp(`${BASE}/v1/preview`, json(DRAIN));
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.tier, 'preview'); assert.equal(j.verdict, 'CAUTION'); assert.deepEqual(j.flags, [{ code: 'UNLIMITED_APPROVAL', severity: 'medium' }]);
  assert.equal(j.onchain, undefined); assert.equal(j.counterparties, undefined); assert.equal(net.calls.length, 0, 'preview is offline');
  assert.match(j.full.url, /\/v1\/check$/);
  assert.equal((await fetchApp(`${BASE}/v1/preview?${q({ to: USDC, data: approveData(EOA) })}`)).status, 200);
  assert.equal((await fetchApp(`${BASE}/v1/preview?to=bad`)).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/preview`)).status, 400);
  const { fetchApp: limitedApp } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  const l = await limitedApp(`${BASE}/v1/preview`, json(DRAIN)); assert.equal(l.status, 429); assert.ok(l.headers.get('retry-after'));
});

test('remote MCP: initialize, tools/list, check_signature (preview tier), bad input is a tool error, unknown tool is -32602', async () => {
  const { fetchApp } = await makeApp();
  const rpc = async (body) => (await fetchApp(`${BASE}/mcp`, json(body))).json();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'signcheck');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); assert.deepEqual(list.result.tools.map((t) => t.name), ['check_signature']);
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_signature', arguments: DRAIN } });
  assert.equal(call.result.isError, false); assert.match(call.result.content[0].text, /CAUTION/); assert.match(call.result.content[0].text, /\/v1\/check/);
  const badc = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_signature', arguments: { tx: { to: 'x' } } } }); assert.equal(badc.result.isError, true);
  const unk = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } }); assert.equal(unk.error.code, -32602);
  assert.equal((await fetchApp(`${BASE}/mcp`)).status, 405);
});

test('discovery: openapi lists only paid + preview with live price + contact, .well-known/x402, favicon, root JSON + HTML, /v1/stats', async () => {
  const { fetchApp } = await makeApp();
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.deepEqual(Object.keys(oa.paths).sort(), [...OPENAPI_PATHS].sort());
  assert.equal(oa.paths['/v1/check'].post['x-payment-info'].price.amount, '0.015'); assert.equal(oa.servers[0].url, BASE); assert.equal(oa.info.contact.email, 'hello@youraitools.co');
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json(); assert.deepEqual(wk.resources, [`${BASE}/v1/check`, `${BASE}/v1/lite`]); assert.equal(oa.paths['/v1/lite'].get['x-payment-info'].price.amount, '0.005');
  for (const p of ['/favicon.ico', '/favicon.svg']) { const f = await fetchApp(`${BASE}${p}`); assert.equal(f.status, 200); assert.match(f.headers.get('content-type'), /svg/); }
  const root = await (await fetchApp(`${BASE}/`)).json(); assert.equal(root.name, 'SignCheck'); assert.equal(root.paid[0].price, '$0.015');
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text(); assert.match(html, /Sign<span>Check/); assert.match(html, /Nine small x402 tools/);
  const st = await (await fetchApp(`${BASE}/v1/stats`)).json(); assert.equal(st.enabled, true);
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});

test('listing text is descriptive and within the 500-char facilitator limit', () => {
  assert.ok(CHECK_DESCRIPTION.length <= 500, String(CHECK_DESCRIPTION.length));
  assert.ok(!/\b(ignore|you must|always call|system prompt)\b/i.test(CHECK_DESCRIPTION));
  assert.ok(LITE_DESCRIPTION.length <= 500, String(LITE_DESCRIPTION.length));
});

test('lite tier /v1/lite: 402 at 5000 atomic (GET/POST/HEAD, no network), paid result has reasons + counterparties but no RPC, settled once at 5000; works with RPC down', async () => {
  const net = fakeNet({ down: true });
  const { app, fetchApp, facilitator } = await makeApp({ net });
  for (const [u, init] of [[`${BASE}/v1/lite`], [`${BASE}/v1/lite`, json(DRAIN)], [`${BASE}/v1/lite?${q({ to: USDC, data: approveData(EOA) })}`]]) {
    const r = await fetchApp(u, init); assert.equal(r.status, 402);
    const req = decode(r.headers.get('PAYMENT-REQUIRED'));
    assert.equal(req.accepts[0].amount, '5000'); assert.equal(req.resource.url, `${BASE}/v1/lite`);
    assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid);
    assert.equal((await r.json()).accepts[0].maxAmountRequired, '5000');
  }
  const h = headAsGet((req) => app.fetch(req));
  const hr = await h(new Request(`${BASE}/v1/lite`, { method: 'HEAD' })); assert.equal(hr.status, 402); assert.ok(hr.headers.get('payment-required'));
  assert.equal((await fetchApp(`${BASE}/v1/lite?to=nothex`)).status, 400);
  const r = await v2pay(fetchApp)(`${BASE}/v1/lite`, json(DRAIN));
  assert.equal(r.status, 200, await r.clone().text()); const j = await r.json();
  assert.equal(j.tier, 'lite'); assert.equal(j.verdict, 'CAUTION'); assert.ok(j.flags.some((f) => f.code === 'UNLIMITED_APPROVAL')); assert.ok(j.flags.every((f) => f.message)); assert.ok(j.counterparties.length);
  assert.equal(j.onchain.available, false);
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '5000');
  assert.equal(net.calls.length, 0, 'lite never touches the network');
});
