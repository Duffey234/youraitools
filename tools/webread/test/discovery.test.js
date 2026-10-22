import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { watchdog } from '../src/deadline.js';
import { makeApp, PAGE, BASE, PAY_TO, NETWORK } from './helpers.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const never = () => new Promise(() => {});
const SITE = { 'https://site.example.org/robots.txt': { body: '', headers: { 'content-type': 'text/plain' } }, 'https://site.example.org/page': { body: PAGE } };

test('GET /openapi.json: x402scan-conformant, live price/terms, every documented GET route exists', async () => {
  const { fetchApp } = makeApp({ pages: SITE });
  const r = await fetchApp(`${BASE}/openapi.json`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.openapi, '3.1.0');
  assert.ok(d.info.title && d.info.version && d.info['x-guidance']);
  assert.equal(d.servers[0].url, BASE);
  assert.deepEqual(Object.keys(d.paths), ['/v1/read', '/v1/read/preview'], 'only paid + preview routes are published');
  const op = d.paths['/v1/read'].get;
  assert.deepEqual(op['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.002' });
  assert.ok(op.responses['402']);
  assert.deepEqual([op['x-x402'].network, op['x-x402'].payTo, op['x-x402'].amount, op['x-x402'].asset], [NETWORK, PAY_TO, '2000', USDC_BASE]);
  for (const [path, ops] of Object.entries(d.paths)) {
    if (!ops.get) continue;
    const res = await fetchApp(`${BASE}${path}${path.startsWith('/v1/read') ? '?url=https://site.example.org/page' : ''}`);
    assert.notEqual(res.status, 404, path);
  }
});

test('GET /.well-known/x402 lists the paid resource, which answers 402', async () => {
  const { fetchApp } = makeApp();
  const d = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.equal(d.version, 1);
  assert.deepEqual(d.resources, [`${BASE}/v1/read`]);
  assert.equal((await fetchApp(d.resources[0])).status, 402);
});

test('favicon.ico is a real ICO and favicon.svg is SVG', async () => {
  const { fetchApp } = makeApp();
  const ico = await fetchApp(`${BASE}/favicon.ico`);
  assert.equal(ico.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual([...new Uint8Array(await ico.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0]);
  assert.match(await (await fetchApp(`${BASE}/favicon.svg`)).text(), /^<svg/);
});

test('the unpaid 402 never waits on the network (facilitator and web hanging)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => never();
  try {
    const app = createApp({ payTo: PAY_TO, network: NETWORK, price: '$0.002', publicUrl: BASE, fetchImpl: never, dns: false });
    const t = Date.now();
    for (let i = 0; i < 3; i++) assert.equal((await app.fetch(new Request(`${BASE}/v1/read?url=https://example.com/`))).status, 402);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  } finally { globalThis.fetch = orig; }
});

test('a hanging page on a paid read fails fast with 504 and is never settled', async () => {
  const { fetchApp, facilitator } = makeApp({ pages: { ...SITE, 'https://site.example.org/slow': () => never() }, workMs: 50 });
  const pay = wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
  const r = await pay(`${BASE}/v1/read?url=https://site.example.org/slow`);
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error, 'timeout');
  assert.equal(facilitator.settled.length, 0);
});

test('worker watchdog answers 503 instead of hanging', async () => {
  const r = await watchdog(() => never(), 30)(new Request(`${BASE}/v1/read`), {}, {});
  assert.equal(r.status, 503);
});
