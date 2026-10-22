import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, fakeOsv, BASE, PAY_TO } from './helpers.js';
import { OPENAPI_PATHS } from '../src/discovery.js';
import { SCAN_DESCRIPTION, PACKAGE_DESCRIPTION } from '../src/app.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const PKG_Q = 'ecosystem=npm&name=lodash&version=4.17.15';
const MANIFEST = JSON.stringify({ dependencies: { lodash: '4.17.15', 'flatmap-stream': '0.1.1', 'left-pad': '1.3.0' } });

test('unpaid: 402 on both paid routes (v2 header: 3000 / 1000 atomic USDC, Base, payTo, valid Bazaar; v1 body), no network', async () => {
  const osv = fakeOsv();
  const { fetchApp } = await makeApp({ osv });
  for (const [u, init, path, amount] of [[`${BASE}/v1/scan`, { method: 'POST' }, '/v1/scan', '3000'], [`${BASE}/v1/scan`, json({ manifest: MANIFEST }), '/v1/scan', '3000'], [`${BASE}/v1/scan`, json({}), '/v1/scan', '3000'],
    [`${BASE}/v1/package?${PKG_Q}`, undefined, '/v1/package', '1000'], [`${BASE}/v1/package`, undefined, '/v1/package', '1000'], [`${BASE}/v1/package`, json({ name: 'lodash', version: '4.17.15' }), '/v1/package', '1000']]) {
    const r = await fetchApp(u, init);
    assert.equal(r.status, 402, `${init?.method || 'GET'} ${u}`);
    const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
    assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', amount, PAY_TO, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
    assert.equal(req.resource.url, `${BASE}${path}`);
    assert.equal(req.resource.serviceName, 'PkgGuard by AgentGate'); assert.equal(req.resource.tags[0], 'security');
    assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
    assert.ok(r.headers.get('PAYMENT-REQUIRED').length < 12000, 'header fits proxies');
    const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount); assert.equal(b.accepts[0].network, 'base');
  }
  assert.equal(osv.calls.length, 0, 'a 402 never touches OSV');
});

test('malformed input: 400 before payment, never charged; GET /v1/scan is a 402 with a usage note (paid GET 400, never settled); oversize is 413', async () => {
  const { fetchApp, facilitator, osv } = await makeApp();
  for (const [u, init] of [[`${BASE}/v1/package?name=lodash`], [`${BASE}/v1/package?name=lodash&version=^1.0`], [`${BASE}/v1/package?ecosystem=cobol&name=x&version=1.0.0`], [`${BASE}/v1/package`, json({ name: 5, version: '1.0.0' })],
    [`${BASE}/v1/scan`, json({ manifest: '{"foo":1}' })], [`${BASE}/v1/scan`, json({ packages: [] })], [`${BASE}/v1/scan`, json({ packages: Array(501).fill({ name: 'a', version: '1.0.0' }) })], [`${BASE}/v1/scan`, json({ hello: 1 })],
    [`${BASE}/v1/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }], [`${BASE}/v1/scan`, json({ manifest: '{"dependencies":{}}' })]]) {
    const r = await fetchApp(u, init); assert.equal(r.status, 400, `${u} ${init?.body?.slice?.(0, 80) || ''}`);
  }
  const g = await fetchApp(`${BASE}/v1/scan`); assert.equal(g.status, 402);
  const gb = await g.json(); assert.equal(gb.usage.method, 'POST'); assert.match(gb.usage.message, /POST a JSON body/); assert.ok(gb.accepts?.length || g.headers.get('payment-required'));
  const pr = JSON.parse(atob(g.headers.get('payment-required'))); assert.equal(pr.accepts[0].amount, '3000'); assert.match(pr.resource.url, /\/v1\/scan$/);
  assert.equal((await fetchApp(`${BASE}/v1/scan`, { headers: { 'payment-signature': 'x' } })).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/scan`, { headers: { 'x-payment': 'x' } })).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/scan`, json({ manifest: 'x'.repeat(520000) }))).status, 413);
  assert.equal(facilitator.settled.length, 0); assert.equal(osv.calls.length, 0);
});

test('paid v2 scan: manifest -> malicious + vulnerable packages with ids, severity, fixed-in; raw file body works; settled once each', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const pay = v2pay(fetchApp);
  const r = await pay(`${BASE}/v1/scan`, json({ manifest: MANIFEST, filename: 'package.json' }));
  assert.equal(r.status, 200, await r.clone().text()); const j = await r.json();
  assert.equal(j.verdict, 'malicious'); assert.equal(j.manifest_type, 'package.json'); assert.equal(j.package_count, 3);
  assert.deepEqual(j.packages.map((p) => p.name), ['flatmap-stream', 'lodash']);
  assert.equal(j.packages[1].vulns[0].id, 'GHSA-35jh-r3h4-6jhm'); assert.deepEqual(j.packages[1].vulns[0].fixed_in, ['4.17.21']); assert.deepEqual(j.packages[1].vulns[0].aliases, ['CVE-2021-23337']);
  assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  const raw = await pay(`${BASE}/v1/scan`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'requests==2.19.0\n' });
  assert.equal(raw.status, 200); const rj = await raw.json(); assert.equal(rj.manifest_type, 'requirements.txt'); assert.equal(rj.packages[0].vulns[0].id, 'PYSEC-2018-28');
  const lock = JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.15' } } });
  const lr = await pay(`${BASE}/v1/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: lock });
  assert.equal(lr.status, 200); const lj = await lr.json(); assert.equal(lj.manifest_type, 'package-lock.json'); assert.equal(lj.packages[0].name, 'lodash');
  assert.equal(facilitator.settled.length, 3); assert.equal(facilitator.settled[0].amount, '3000');
});

test('paid v2 package: GET and POST, clean package -> clean; 1000 atomic', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const pay = v2pay(fetchApp);
  const g = await (await pay(`${BASE}/v1/package?${PKG_Q}`)).json(); assert.equal(g.verdict, 'vulnerable'); assert.equal(g.packages[0].highest_severity, 'HIGH');
  const p = await (await pay(`${BASE}/v1/package`, json({ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }))).json(); assert.equal(p.verdict, 'clean'); assert.deepEqual(p.packages, []);
  assert.deepEqual(facilitator.settled.map((s) => s.amount), ['1000', '1000']);
});

test('OSV outage on a paid call: 503, verified but never settled', async () => {
  const { fetchApp, facilitator } = await makeApp({ osv: fakeOsv('down') });
  const r = await v2pay(fetchApp)(`${BASE}/v1/package?${PKG_Q}`);
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'upstream_unavailable');
  assert.equal(facilitator.settled.length, 0);
});

test('paid v1 with the x402-fetch 1.2 client (X-PAYMENT)', async () => {
  const calls = [];
  const v1FetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(url.split('/').pop()); return Response.json(url.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0x' + '1'.repeat(64), network: 'base', payer: b.paymentPayload.payload.authorization.from }); };
  const { fetchApp } = await makeApp({ v1FetchImpl });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(fetchApp, wallet)(`${BASE}/v1/package?${PKG_Q}`);
  assert.equal(r.status, 200); assert.equal((await r.json()).verdict, 'vulnerable');
  assert.equal(decodeXPaymentResponse(r.headers.get('X-PAYMENT-RESPONSE')).success, true); assert.deepEqual(calls, ['verify', 'settle']);
});

test('free preview: counts + verdict only (no ids, no package names), 25-package cap, 400 on bad input, 429 rate limit, 503 on outage', async () => {
  const { fetchApp } = await makeApp();
  const g = await (await fetchApp(`${BASE}/v1/preview?${PKG_Q}`)).json();
  assert.equal(g.verdict, 'vulnerable'); assert.equal(g.advisory_count, 2); assert.equal(g.packages, undefined); assert.ok(g.full.url.endsWith('/v1/package'));
  const s = await (await fetchApp(`${BASE}/v1/preview`, json({ manifest: MANIFEST }))).json();
  assert.equal(s.verdict, 'malicious'); assert.equal(s.malicious_count, 1); assert.ok(s.full.url.endsWith('/v1/scan'));
  assert.ok(!/GHSA-|MAL-\d|flatmap/.test(JSON.stringify({ ...s, full: undefined })));
  const raw = await (await fetchApp(`${BASE}/v1/preview`, { method: 'POST', body: 'requests==2.19.0' })).json(); assert.equal(raw.verdict, 'vulnerable');
  const pj = await (await fetchApp(`${BASE}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { 'flatmap-stream': '0.1.1' } }) })).json();
  assert.equal(pj.manifest_type, 'package.json'); assert.equal(pj.verdict, 'malicious');
  const big = await fetchApp(`${BASE}/v1/preview`, json({ packages: Array.from({ length: 26 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' })) }));
  assert.equal(big.status, 400); assert.match((await big.json()).message, /free preview takes at most 25/);
  assert.equal((await fetchApp(`${BASE}/v1/preview?name=x`)).status, 400);
  const { fetchApp: f2 } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await f2(`${BASE}/v1/preview?${PKG_Q}`)).status, 429);
  const { fetchApp: f3 } = await makeApp({ osv: fakeOsv('http500') });
  assert.equal((await f3(`${BASE}/v1/preview?${PKG_Q}`)).status, 503);
});

test('remote MCP: initialize, tools/list, scan_dependencies + check_package (preview tier), bad input is a tool error', async () => {
  const { fetchApp } = await makeApp();
  const rpc = async (body) => (await fetchApp(`${BASE}/mcp`, json(body))).json();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'pkgguard');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['scan_dependencies', 'check_package']);
  const d = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scan_dependencies', arguments: { manifest: MANIFEST } } });
  assert.match(d.result.content[0].text, /MALICIOUS/); assert.equal(d.result.isError, false); assert.doesNotMatch(d.result.content[0].text, /GHSA|flatmap/);
  const e = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_package', arguments: { ecosystem: 'npm', name: 'left-pad', version: '1.3.0' } } });
  assert.match(e.result.content[0].text, /CLEAN/);
  const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_package', arguments: { name: 'x' } } });
  assert.equal(bad.result.isError, true);
});

test('discovery: openapi with live prices + contact, .well-known/x402, favicon, root JSON + HTML, /v1/ecosystems, /v1/stats', async () => {
  const { fetchApp } = await makeApp();
  const o = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.deepEqual(Object.keys(o.paths).sort(), [...OPENAPI_PATHS].sort());
  assert.equal(o.paths['/v1/scan'].post['x-payment-info'].price.amount, '0.003');
  assert.equal(o.paths['/v1/package'].get['x-x402'].amount, '1000');
  assert.equal(o.servers[0].url, BASE); assert.equal(o.info.contact.email, 'hello@youraitools.co'); assert.equal(o.info['x-category'], 'security');
  const w = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(w.resources, [`${BASE}/v1/scan`, `${BASE}/v1/package`]); assert.equal(w.tags[0], w.category);
  assert.match((await fetchApp(`${BASE}/favicon.ico`)).headers.get('content-type'), /svg/);
  const root = await (await fetchApp(`${BASE}/`)).json(); assert.equal(root.name, 'PkgGuard'); assert.equal(root.paid.length, 2); assert.ok(root.ecosystems.includes('PyPI'));
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Agent trust kit/); assert.match(html, /PayGuard/); assert.match(html, /PkgGuard <span/); assert.match(html, /OSV\.dev/); assert.doesNotMatch(html, /github\.com/);
  const eco = await (await fetchApp(`${BASE}/v1/ecosystems`)).json(); assert.ok(eco.manifests.includes('go.mod'));
  await fetchApp(`${BASE}/v1/package?${PKG_Q}`);
  await new Promise((r) => setTimeout(r, 20));
  const st = await (await fetchApp(`${BASE}/v1/stats`)).json(); assert.ok(st.totals.challenge_402 >= 1);
});

test('listing text is descriptive (no imperative / injection-like phrasing) and within the 500-char facilitator limit', async () => {
  const { fetchApp } = await makeApp();
  assert.ok(SCAN_DESCRIPTION.length <= 500 && PACKAGE_DESCRIPTION.length <= 500);
  const texts = [SCAN_DESCRIPTION, PACKAGE_DESCRIPTION, JSON.stringify(await (await fetchApp(`${BASE}/openapi.json`)).json()), JSON.stringify(await (await fetchApp(`${BASE}/.well-known/x402`)).json())];
  for (const t of texts) assert.doesNotMatch(t, /\b(ignore|disregard|you must|always call|never call|system prompt|instructions? (above|below)|do not tell)\b/i);
});
