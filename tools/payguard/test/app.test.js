import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, LAZARUS_ETH, CLEAN_EVM } from './helpers.js';
import { OPENAPI_PATHS } from '../src/discovery.js';
import { ADDRESS_DESCRIPTION, BATCH_DESCRIPTION } from '../src/app.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('unpaid: 402 on both paid routes (v2 header: 1000 / 10000 atomic USDC, Base, payTo, USD Coin v2, valid Bazaar; v1 body), no network', async () => {
  const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('no network in a 402'); };
  try {
    const { fetchApp } = await makeApp();
    for (const [u, init, path, amount] of [[`${BASE}/v1/address?address=${LAZARUS_ETH}`, undefined, '/v1/address', '1000'], [`${BASE}/v1/address`, undefined, '/v1/address', '1000'], [`${BASE}/v1/address`, json({ address: CLEAN_EVM }), '/v1/address', '1000'],
      [`${BASE}/v1/address`, json({}), '/v1/address', '1000'], [`${BASE}/v1/batch`, json({}), '/v1/batch', '10000'],
      [`${BASE}/v1/batch`, { method: 'POST' }, '/v1/batch', '10000'], [`${BASE}/v1/batch`, json({ addresses: [LAZARUS_ETH, CLEAN_EVM] }), '/v1/batch', '10000']]) {
      const r = await fetchApp(u, init);
      assert.equal(r.status, 402, `${init?.method || 'GET'} ${u}`);
      const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
      assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', amount, PAY_TO, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
      assert.deepEqual(a.extra, { name: 'USD Coin', version: '2' });
      assert.equal(req.resource.url, `${BASE}${path}`);
      assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
      assert.ok(r.headers.get('PAYMENT-REQUIRED').length < 12000, 'header fits proxies');
      const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount); assert.equal(b.accepts[0].network, 'base');
    }
    assert.equal(calls, 0, 'a 402 never touches the network');
  } finally { globalThis.fetch = realFetch; }
});

test('malformed input: 400 before payment, never charged; GET /v1/batch is 405', async () => {
  const { fetchApp, facilitator } = await makeApp();
  for (const [u, init] of [[`${BASE}/v1/address?address=`], [`${BASE}/v1/address?address=hello%20world`], [`${BASE}/v1/address?address=${'a'.repeat(200)}`], [`${BASE}/v1/address`, json({ address: 5 })],
    [`${BASE}/v1/address`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }], [`${BASE}/v1/batch`, json({ addresses: [] })], [`${BASE}/v1/batch`, json({ addresses: Array(51).fill(CLEAN_EVM) })], [`${BASE}/v1/batch`, json({ addresses: [CLEAN_EVM, 'no way'] })]]) {
    const r = await fetchApp(u, init); assert.equal(r.status, 400, `${u} ${init?.body || ''}`);
  }
  assert.equal((await fetchApp(`${BASE}/v1/batch`)).status, 405);
  assert.equal(facilitator.settled.length, 0);
});

test('paid v2: sanctioned Lazarus address -> full match; clean address -> false; each settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const pay = v2pay(fetchApp);
  const r = await pay(`${BASE}/v1/address?address=${LAZARUS_ETH}`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.sanctioned, true); assert.equal(j.matches[0].entity, 'LAZARUS GROUP'); assert.equal(j.matches[0].list_date, '2019-09-13');
  assert.equal(j.chain.checksum_valid, true); assert.match(j.disclaimer, /not legal advice/i); assert.ok(j.list_updated_at && j.source);
  assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  const c = await (await pay(`${BASE}/v1/address`, json({ address: CLEAN_EVM }))).json();
  assert.equal(c.sanctioned, false); assert.equal(c.match_count, 0);
  assert.equal(facilitator.settled.length, 2); assert.equal(facilitator.settled[0].amount, '1000');
});

test('paid v2 batch: 2 addresses, one sanctioned; 10000 atomic', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/batch`, json({ addresses: [LAZARUS_ETH, CLEAN_EVM] }));
  assert.equal(r.status, 200); const j = await r.json();
  assert.deepEqual([j.count, j.sanctioned_count, j.any_sanctioned], [2, 1, true]);
  assert.equal(facilitator.settled[0].amount, '10000');
});

test('paid v1 with the x402-fetch 1.2 client (X-PAYMENT)', async () => {
  const calls = [];
  const v1FetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(url.split('/').pop()); return Response.json(url.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0x' + '1'.repeat(64), network: 'base', payer: b.paymentPayload.payload.authorization.from }); };
  const { fetchApp } = await makeApp({ v1FetchImpl });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(fetchApp, wallet)(`${BASE}/v1/address?address=${LAZARUS_ETH.toLowerCase()}`);
  assert.equal(r.status, 200); assert.equal((await r.json()).sanctioned, true);
  assert.equal(decodeXPaymentResponse(r.headers.get('X-PAYMENT-RESPONSE')).success, true); assert.deepEqual(calls, ['verify', 'settle']);
});

test('free preview: flags the SDN address, clears a clean one, no entity details; rate limit 429', async () => {
  const { fetchApp } = await makeApp();
  const s = await (await fetchApp(`${BASE}/v1/preview?address=${LAZARUS_ETH}`)).json();
  assert.equal(s.sanctioned, true); assert.equal(s.match_count, 1); assert.equal(s.matches, undefined); assert.ok(s.full.url.endsWith('/v1/address'));
  const c = await (await fetchApp(`${BASE}/v1/preview`, json({ address: CLEAN_EVM }))).json();
  assert.equal(c.sanctioned, false);
  assert.equal((await fetchApp(`${BASE}/v1/preview?address=bad%20input`)).status, 400);
  const { fetchApp: f2 } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await f2(`${BASE}/v1/preview?address=${CLEAN_EVM}`)).status, 429);
});

test('remote MCP: initialize, tools/list, screen_address (preview tier)', async () => {
  const { fetchApp } = await makeApp();
  const rpc = async (body) => (await fetchApp(`${BASE}/mcp`, json(body))).json();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'payguard');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['screen_address']);
  const d = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_address', arguments: { address: LAZARUS_ETH } } });
  assert.match(d.result.content[0].text, /SANCTIONED/); assert.equal(d.result.isError, false);
  const e = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screen_address', arguments: { address: CLEAN_EVM } } });
  assert.match(e.result.content[0].text, /no OFAC SDN match/);
  const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'screen_address', arguments: { address: '???' } } });
  assert.equal(bad.result.isError, true);
});

test('discovery: openapi with live prices, .well-known/x402, favicon, root JSON + HTML, /v1/list, /v1/stats', async () => {
  const { fetchApp } = await makeApp();
  const o = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.deepEqual(Object.keys(o.paths).sort(), [...OPENAPI_PATHS].sort());
  assert.equal(o.paths['/v1/address'].get['x-payment-info'].price.amount, '0.001');
  assert.equal(o.paths['/v1/batch'].post['x-x402'].amount, '10000');
  assert.equal(o.servers[0].url, BASE);
  const w = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(w.resources, [`${BASE}/v1/address`, `${BASE}/v1/batch`]);
  assert.match((await fetchApp(`${BASE}/favicon.ico`)).headers.get('content-type'), /svg/);
  const root = await (await fetchApp(`${BASE}/`)).json(); assert.equal(root.name, 'PayGuard'); assert.equal(root.paid.length, 2); assert.ok(root.data.sdn_address_count > 500);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Agent trust kit/); assert.match(html, /DomainCheck/); assert.match(html, /PayGuard/); assert.match(html, /not legal advice/i); assert.doesNotMatch(html, /github\.com/);
  const l = await (await fetchApp(`${BASE}/v1/list`)).json(); assert.ok(l.address_count > 500); assert.match(l.source_url, /ofac\.treas\.gov/);
  await fetchApp(`${BASE}/v1/address?address=${CLEAN_EVM}`);
  await new Promise((r) => setTimeout(r, 20));
  const st = await (await fetchApp(`${BASE}/v1/stats`)).json(); assert.ok(st.totals.challenge_402 >= 1);
});

test('listing text is descriptive (no imperative / injection-like phrasing)', async () => {
  const { fetchApp } = await makeApp();
  const texts = [ADDRESS_DESCRIPTION, BATCH_DESCRIPTION, JSON.stringify(await (await fetchApp(`${BASE}/openapi.json`)).json()), JSON.stringify(await (await fetchApp(`${BASE}/.well-known/x402`)).json())];
  for (const t of texts) assert.doesNotMatch(t, /\b(ignore|disregard|you must|always call|never call|system prompt|instructions? (above|below)|do not tell)\b/i);
});
