import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { agentGate, MockProvider, encodeHeader, decodeHeader, payerOf } from '../src/index.js';
import { mockPaywall } from '../examples/mock-paywall.js';

let server, base;
before(() => {
  const app = express();
  const provider = new MockProvider();
  app.get('/paid', agentGate({ provider, network: 'testnet', bindPayer: true }), mockPaywall(), (req, res) => res.json({ ok: true, agent: req.agentGate.tokenAddress }));
  app.get('/outage', agentGate({ provider: { name: 'down', check: async () => { throw new Error('boom'); } } }), (_q, r) => r.json({ ok: true }));
  app.get('/failopen', agentGate({ failOpen: true, provider: { name: 'down', check: async () => { throw new Error('boom'); } } }), (_q, r) => r.json({ ok: true }));
  app.get('/policy', agentGate({ provider, policy: (_req, r) => r.tokenId === 999 }), (_q, r) => r.json({ ok: true }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, headers) => fetch(base + path, { headers });

test('401 without badge header', async () => {
  const r = await get('/paid');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'agent_badge_required');
});

test('403 for unregistered, revoked and tampered agents (before any payment is requested)', async () => {
  for (const [id, err] of [['Mf22soLh1NuZYFgBK8iSs', 'agent_not_registered'], ['MockRevokedAgent22222', 'agent_not_active'], ['MockTamperedCard33333', 'agent_card_mismatch']]) {
    const r = await get('/paid', { 'X-Agent-Badge': id });
    assert.equal(r.status, 403, id);
    assert.equal((await r.json()).error, err);
    assert.equal(r.headers.get('PAYMENT-REQUIRED'), null);
  }
});

test('verified agent gets x402 402 with PAYMENT-REQUIRED, then 200 after paying', async () => {
  const r1 = await get('/paid', { 'X-Agent-Badge': 'MockVerifiedAgent1111' });
  assert.equal(r1.status, 402);
  const reqs = decodeHeader(r1.headers.get('PAYMENT-REQUIRED'));
  assert.equal(reqs.x402Version, 2);
  const sig = encodeHeader({ x402Version: 2, accepted: reqs.accepts[0], payload: { payer: 'MOCK-WALLET-1' } });
  const r2 = await get('/paid', { 'X-Agent-Badge': 'MockVerifiedAgent1111', 'PAYMENT-SIGNATURE': sig });
  assert.equal(r2.status, 200);
  assert.match(r2.headers.get('X-AgentGate'), /verified; network=testnet; source=mock; MOCK/);
  assert.ok(r2.headers.get('PAYMENT-RESPONSE'));
  assert.deepEqual(await r2.json(), { ok: true, agent: 'MockVerifiedAgent1111' });
});

test('bindPayer: payment from a wallet that is not the agent wallet/owner is rejected', async () => {
  const sig = encodeHeader({ x402Version: 2, accepted: {}, payload: { authorization: { from: '0xSomeoneElse' } } });
  const r = await get('/paid', { 'X-Agent-Badge': 'MockVerifiedAgent1111', 'PAYMENT-SIGNATURE': sig });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'payer_not_bound');
});

test('registry outage fails closed (503) by default, open when configured', async () => {
  assert.equal((await get('/outage', { 'X-Agent-Badge': 'MockVerifiedAgent1111' })).status, 503);
  assert.equal((await get('/failopen', { 'X-Agent-Badge': 'MockVerifiedAgent1111' })).status, 200);
});

test('custom policy can deny', async () => {
  const r = await get('/policy', { 'X-Agent-Badge': 'MockVerifiedAgent1111' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'policy_denied');
});

test('payerOf handles EVM exact and generic payloads', () => {
  assert.equal(payerOf({ payload: { authorization: { from: '0xabc' } } }), '0xabc');
  assert.equal(payerOf({ payload: { payer: 'ccdAcct' } }), 'ccdAcct');
  assert.equal(payerOf(null), null);
});
