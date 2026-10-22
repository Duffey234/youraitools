import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headAsGet } from '../src/head.js';

test('HEAD = GET response (402 + PAYMENT-REQUIRED) without body; payment headers stripped', async () => {
  const seen = [];
  const h = headAsGet(async (req) => { seen.push(req); return new Response('{"x":1}', { status: 402, headers: { 'payment-required': 'abc' } }); });
  const r = await h(new Request('https://t.example/v1/x?q=1', { method: 'HEAD', headers: { 'x-payment': 'junk', 'payment-signature': 'junk', accept: '*/*' } }));
  assert.equal(r.status, 402); assert.equal(r.headers.get('payment-required'), 'abc'); assert.equal(await r.text(), '');
  assert.equal(seen[0].method, 'GET'); assert.equal(seen[0].headers.get('x-payment'), null); assert.equal(seen[0].headers.get('payment-signature'), null);
  const g = await h(new Request('https://t.example/v1/x'));
  assert.equal(g.status, 402); assert.equal(await g.text(), '{"x":1}');
});
