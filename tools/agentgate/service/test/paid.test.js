import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { makeApp, fakeFacilitator, PAY_TO, NETWORK } from './helpers.js';
import { USDC } from '../src/config.js';
import { FIVE_LAWS } from '../src/offer.js';

const URL_OK = 'https://agentgate.example.com/v1/check-agent?id=MockVerifiedAgent1111&network=testnet';
const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
// Throwaway key generated per run; it holds nothing and only signs EIP-3009 payloads for the fake facilitator.

function payingFetch(fetchApp) {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, fetch: wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }] }) };
}

test('unpaid call answers 402 with x402 v2 terms: 0.005 USDC (5000 atomic) on Base mainnet to the payout wallet', async () => {
  const { fetchApp } = makeApp();
  const r = await fetchApp(URL_OK);
  assert.equal(r.status, 402);
  const req = decode(r.headers.get('PAYMENT-REQUIRED'));
  assert.equal(req.x402Version, 2);
  const a = req.accepts[0];
  assert.equal(a.scheme, 'exact');
  assert.equal(a.network, 'eip155:8453');
  assert.equal(a.amount, '5000');
  assert.equal(a.asset.toLowerCase(), USDC['eip155:8453'].toLowerCase());
  assert.equal(a.payTo, PAY_TO);
  assert.ok(req.extensions?.bazaar?.info, 'bazaar discovery declaration present');
  assert.equal(req.extensions.bazaar.info.input.method, 'GET');
  assert.equal(req.resource.serviceName, 'AgentGate Agent ID Check');
  assert.deepEqual(req.resource.tags.slice(0, 2), ['identity', 'verification']);
  assert.match(req.resource.iconUrl, /^https:\/\/.+\.png$/);
  assert.equal(req.resource.url, 'https://agentgate.example.com/v1/check-agent');
});

test('bare GET (what the Bazaar probe sends) answers 402, not 400', async () => {
  const { fetchApp } = makeApp();
  assert.equal((await fetchApp('https://agentgate.example.com/v1/check-agent')).status, 402);
});

test('paid call via the official @x402/fetch client: verified, settled, 200 with the registry verdict and PAYMENT-RESPONSE', async () => {
  const { fetchApp, facilitator } = makeApp();
  const { fetch, account } = payingFetch(fetchApp);
  const r = await fetch(URL_OK);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.verified, true);
  assert.equal(body.mock, true);
  assert.equal(facilitator.verified.length, 1);
  assert.equal(facilitator.settled.length, 1);
  const auth = facilitator.settled[0].payload.payload.authorization;
  assert.equal(auth.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(auth.to, PAY_TO);
  assert.equal(String(auth.value), '5000');
  // The client echoed the bazaar declaration into the payment payload, which is what lets a facilitator catalog us.
  assert.ok(facilitator.verified[0].payload.extensions?.bazaar, 'bazaar extension echoed to facilitator');
  const settlement = decodePaymentResponseHeader(r.headers.get('PAYMENT-RESPONSE'));
  assert.equal(settlement.success, true);
});

test('payment that fails verification: 402 and no work done', async () => {
  const provider = { calls: 0, async check() { this.calls++; return {}; } };
  const { fetchApp, facilitator } = makeApp({ facilitator: fakeFacilitator({ verifyOk: false }), provider });
  const { fetch } = payingFetch(fetchApp);
  const r = await fetch(URL_OK);
  assert.equal(r.status, 402);
  assert.equal(provider.calls, 0);
  assert.equal(facilitator.settled.length, 0);
});

test('payment that fails settlement: 402, the result is withheld', async () => {
  const { fetchApp } = makeApp({ facilitator: fakeFacilitator({ settleOk: false }) });
  const { fetch } = payingFetch(fetchApp);
  const r = await fetch(URL_OK);
  assert.equal(r.status, 402);
  const text = await r.text();
  assert.doesNotMatch(text, /MockVerifiedAgent1111.*verified/);
});

test('invalid id is answered 400 and never settled (buyer not charged)', async () => {
  const { fetchApp, facilitator } = makeApp();
  const { fetch } = payingFetch(fetchApp);
  const r = await fetch('https://agentgate.example.com/v1/check-agent?id=0xnotabadge');
  assert.equal(r.status, 400);
  assert.equal(facilitator.settled.length, 0);
});

test('registry outage is answered 502 and never settled', async () => {
  const provider = { async check() { throw new Error('down'); } };
  const { fetchApp, facilitator } = makeApp({ provider });
  const { fetch } = payingFetch(fetchApp);
  const r = await fetch(URL_OK);
  assert.equal(r.status, 502);
  assert.equal(facilitator.settled.length, 0);
});

test('free routes: /, /health and a LAX offer with the Five Laws', async () => {
  const { fetchApp } = makeApp();
  assert.equal((await fetchApp('https://agentgate.example.com/health')).status, 200);
  const info = await (await fetchApp('https://agentgate.example.com/')).json();
  assert.equal(info.paid.payTo, PAY_TO);
  const offer = await (await fetchApp('https://agentgate.example.com/lax-offer.json')).json();
  assert.deepEqual(offer.constitutional_constraints, FIVE_LAWS);
  assert.equal(offer.endpoint, 'https://agentgate.example.com/v1/check-agent');
  assert.equal(offer.capabilities[0].pricing.amount, '0.005');
  assert.ok(offer.capabilities[0].input_schema && offer.capabilities[0].output_schema);
  assert.ok(offer.description.length >= 20 && offer.description.length <= 600);
});

test('bazaar declaration served in the 402 validates with the official @x402/extensions validator', async () => {
  const { validateDiscoveryExtension } = await import('@x402/extensions/bazaar');
  const { routesConfig } = await import('../src/app.js');
  const route = routesConfig({ price: '$0.005', network: NETWORK, payTo: PAY_TO, publicUrl: 'https://x.example.com' })['GET /v1/check-agent'];
  assert.equal(route.resource, 'https://x.example.com/v1/check-agent');
  const { fetchApp } = makeApp();
  const req = decode((await fetchApp(URL_OK)).headers.get('PAYMENT-REQUIRED'));
  const v = validateDiscoveryExtension(req.extensions.bazaar);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test('a facilitator that never answers /supported cannot hang the paid route (static fallback)', async () => {
  const { ResilientFacilitatorClient } = await import('../src/facilitator.js');
  const c = new ResilientFacilitatorClient({ url: 'https://unused.example', network: NETWORK, supportedTimeoutMs: 50 });
  const base = Object.getPrototypeOf(ResilientFacilitatorClient.prototype);
  const orig = base.getSupported;
  base.getSupported = () => new Promise(() => {});
  let s; try { s = await c.getSupported(); } finally { base.getSupported = orig; }
  assert.deepEqual(s.kinds, [{ x402Version: 2, scheme: 'exact', network: NETWORK }]);
});
