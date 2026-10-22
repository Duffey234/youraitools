import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
import { MockProvider } from '../../src/registry.js';
import { fakeFacilitator, PAY_TO, NETWORK } from './helpers.js';

const BASE = 'https://agentgate.example.com';
function memKv() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } };
}
function build({ limiter, kv = memKv() } = {}) {
  const stats = new Stats(kv, { flushMs: 0 });
  const facilitator = fakeFacilitator();
  const app = createApp({ facilitatorClient: facilitator, provider: new MockProvider(), payTo: PAY_TO, network: NETWORK, price: '$0.005', publicUrl: BASE, stats, freeLimiter: limiter });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, kv, stats, facilitator };
}
const rpc = (fetchApp, body) => fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

test('free preview returns the verdict only, no payment, and never touches the facilitator', async () => {
  const { fetchApp, facilitator } = build();
  const r = await fetchApp(`${BASE}/v1/check-agent/preview?id=MockVerifiedAgent1111&network=testnet`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verified, true); assert.equal(j.tier, 'free');
  assert.equal(j.owner, undefined); assert.equal(j.agentUri, undefined); assert.equal(j.agentWallet, undefined);
  assert.equal(j.full_record.url, `${BASE}/v1/check-agent`);
  assert.equal(facilitator.verified.length, 0);
  const bad = await fetchApp(`${BASE}/v1/check-agent/preview?id=not*valid`);
  assert.equal(bad.status, 400);
});

test('paid route is unchanged: still 402 with 5000 atomic USDC', async () => {
  const { fetchApp } = build();
  const r = await fetchApp(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111&network=testnet`);
  assert.equal(r.status, 402);
  const req = JSON.parse(Buffer.from(r.headers.get('PAYMENT-REQUIRED'), 'base64').toString());
  assert.equal(req.accepts[0].amount, '5000');
});

test('free preview is rate limited when the limiter says so', async () => {
  const { fetchApp } = build({ limiter: { limit: async () => ({ success: false }) } });
  const r = await fetchApp(`${BASE}/v1/check-agent/preview?id=MockVerifiedAgent1111&network=testnet`);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
});

test('remote MCP: initialize, tools/list, tools/call check_agent', async () => {
  const { fetchApp } = build();
  const init = await (await rpc(fetchApp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'agentgate');
  assert.equal((await rpc(fetchApp, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await (await rpc(fetchApp, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['check_agent']);
  const call = await (await rpc(fetchApp, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_agent', arguments: { id: 'MockRevokedAgent22222', network: 'testnet' } } })).json();
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /^NOT VERIFIED/);
  assert.equal(call.result.structuredContent.verified, false);
  const unknown = await (await rpc(fetchApp, { jsonrpc: '2.0', id: 4, method: 'nope' })).json();
  assert.equal(unknown.error.code, -32601);
});

test('stats count 402 challenges, paid calls and free calls, and skip CI smoke requests', async () => {
  const { fetchApp } = build();
  await fetchApp(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111&network=testnet`);
  await fetchApp(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111&network=testnet`, { headers: { 'x-agentgate-smoke': '1' } });
  await fetchApp(`${BASE}/v1/check-agent/preview?id=MockVerifiedAgent1111&network=testnet`);
  const account = privateKeyToAccount(generatePrivateKey());
  const pay = wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }] });
  const paid = await pay(`${BASE}/v1/check-agent?id=MockVerifiedAgent1111&network=testnet`);
  assert.equal(paid.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  const s = await (await fetchApp(`${BASE}/v1/stats`)).json();
  assert.equal(s.enabled, true);
  assert.equal(s.totals.paid, 1);
  assert.equal(s.totals.free_preview, 1);
  assert.equal(s.totals.challenge_402, 2); // one plain unpaid call + the paying client's first (unpaid) attempt
});
