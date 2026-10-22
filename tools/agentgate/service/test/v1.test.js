import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { MockProvider } from '../../src/registry.js';
import { fakeFacilitator, PAY_TO, NETWORK } from './helpers.js';

const BASE = 'https://agentgate.example.com';
function v1Facilitator({ verifyOk = true, settleOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    assert.equal(body.x402Version, 1);
    if (url.endsWith('/verify')) return Response.json(verifyOk ? { isValid: true, payer: body.paymentPayload.payload.authorization.from } : { isValid: false, invalidReason: 'insufficient_funds' });
    return Response.json(settleOk ? { success: true, transaction: '0x' + 'cd'.repeat(32), network: 'base', payer: body.paymentPayload.payload.authorization.from } : { success: false, errorReason: 'nope' });
  };
  return { calls, fetchImpl };
}
function build(v1) {
  const app = createApp({ facilitatorClient: fakeFacilitator(), provider: new MockProvider(), payTo: PAY_TO, network: NETWORK, price: '$0.005', publicUrl: BASE, v1FetchImpl: v1.fetchImpl });
  return (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
}

test('402 body carries v1 PaymentRequirements (base, maxAmountRequired, USD Coin v2) next to the v2 header', async () => {
  const fetchApp = build(v1Facilitator());
  const r = await fetchApp(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111`);
  assert.equal(r.status, 402);
  assert.ok(r.headers.get('PAYMENT-REQUIRED'));
  const j = await r.json();
  assert.equal(j.x402Version, 1);
  const a = j.accepts[0];
  assert.deepEqual([a.scheme, a.network, a.maxAmountRequired, a.payTo, a.asset.toLowerCase()], ['exact', 'base', '5000', PAY_TO, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
  assert.deepEqual(a.extra, { name: 'USD Coin', version: '2' });
  assert.equal(a.resource, `${BASE}/v1/check-agent`);
  assert.equal(a.mimeType, 'application/json');
  assert.ok(a.description && a.outputSchema.input.queryParams.id);
});

test('a real v1 client (x402-fetch 1.2) pays with X-PAYMENT: verified, served, settled once', async () => {
  const v1 = v1Facilitator();
  const fetchApp = build(v1);
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const pay = wrapFetchWithPayment(fetchApp, wallet);
  const r = await pay(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111&network=testnet`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).verified, true);
  const pr = decodeXPaymentResponse(r.headers.get('X-PAYMENT-RESPONSE'));
  assert.equal(pr.success, true);
  assert.deepEqual(v1.calls.map((c) => c.url.split('/').pop()), ['verify', 'settle']);
});

test('v1: invalid payment is refused with 402 and the handler error path is never settled', async () => {
  const v1 = v1Facilitator({ verifyOk: false });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(build(v1), wallet)(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111&network=testnet`);
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error, 'insufficient_funds');
  const v1b = v1Facilitator();
  const r2 = await wrapFetchWithPayment(build(v1b), wallet)(`${BASE}/v1/check-agent?id=not*valid`);
  assert.equal(r2.status, 400);
  assert.deepEqual(v1b.calls.map((c) => c.url.split('/').pop()), ['verify']);
});
