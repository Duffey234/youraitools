// Multichain 402 fixture (shared test, identical in every YourAITools tool).
// Builds the app with the production wrangler.toml [vars] and asserts, for every paid resource in /.well-known/x402:
// Base first and unchanged vs the pre-multichain live fixture, then Polygon + Arbitrum USDC (EIP-712 domain USD Coin/2);
// legacy (no enabledNetworks) stays Base-only; a Polygon payment is verified against the Polygon requirements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { DEFAULT_ENABLED, NETWORKS, supportedKinds, activeNetworks, multiNetworkRoutes, SOLANA_MAINNET } from '../src/networks.js';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const toml = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const vars = {}; let inVars = false;
for (const line of toml.split('\n')) {
  if (/^\s*\[/.test(line)) inVars = /^\s*\[vars\]\s*$/.test(line);
  const m = inVars && line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/); if (m) vars[m[1]] = m[2];
}
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/base-accepts.json', import.meta.url), 'utf8'));
const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString());
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

function fakeFacilitator(cfg) {
  const f = { verified: [], settled: [],
    async getSupported() { return { kinds: supportedKinds(cfg), extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); return { isValid: false, invalidReason: 'fake_unfunded' }; },
    async settle(payload, req) { f.settled.push(req); return { success: false, errorReason: 'never' }; },
  };
  return f;
}
const memStats = () => ({ hit() {}, async summary() { return { enabled: false }; }, enabled: false });
function build(extra = {}) {
  const base = { ...configFromEnv(vars), enabledNetworks: DEFAULT_ENABLED, solanaPayTo: vars.SOLANA_PAY_TO, ...extra };
  const fac = fakeFacilitator(base);
  const publicUrl = `https://api.youraitools.co${vars.PROXY_PREFIX}`;
  const app = createApp({ ...base, facilitatorClient: fac, publicUrl, stats: memStats(), freeLimiter: undefined });
  return { app, fac, publicUrl };
}
async function challenge(app, publicUrl, resource, headers = {}) {
  const path = resource.replace(/^https:\/\/api\.youraitools\.co\/[^/]+/, '');
  let r = await app.fetch(new Request(`https://worker.test${path}`, { headers }));
  if (r.status !== 402) r = await app.fetch(new Request(`https://worker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }));
  return { r, path };
}
async function resources(app, publicUrl) {
  const r = await app.fetch(new Request(`https://worker.test/.well-known/x402`));
  assert.equal(r.status, 200);
  const doc = await r.json();
  return doc;
}

test('shared network list: Base first, Polygon + Arbitrum + Solana on (Solana needs a payTo)', () => {
  assert.equal(NETWORKS[0].id, 'eip155:8453');
  assert.equal(DEFAULT_ENABLED, `eip155:8453,eip155:137,eip155:42161,${SOLANA_MAINNET}`);
  assert.ok(NETWORKS.find((n) => n.id === SOLANA_MAINNET && n.enabled === true));
  assert.deepEqual(activeNetworks({ network: 'eip155:8453', enabledNetworks: 'eip155:137' }).map((n) => n.id), ['eip155:8453', 'eip155:137']);
  assert.deepEqual(activeNetworks({ network: 'eip155:84532', enabledNetworks: DEFAULT_ENABLED }).map((n) => n.id), ['eip155:84532']);
  // Solana is dropped without a payTo even when enabled
  assert.deepEqual(activeNetworks({ network: 'eip155:8453', enabledNetworks: `${DEFAULT_ENABLED},${SOLANA_MAINNET}` }).map((n) => n.id), ['eip155:8453', 'eip155:137', 'eip155:42161']);
  const r = multiNetworkRoutes({ 'GET /x': { accepts: { scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: '0xabc', maxTimeoutSeconds: 120 } } }, { network: 'eip155:8453', enabledNetworks: DEFAULT_ENABLED });
  assert.equal(r['GET /x'].accepts.length, 3);
});

test('402 on every paid resource: Base unchanged and first, then Polygon and Arbitrum USDC', async () => {
  const { app, publicUrl } = build();
  const doc = await resources(app, publicUrl);
  assert.deepEqual(doc.networks.map((n) => n.network), ['eip155:8453', 'eip155:137', 'eip155:42161', SOLANA_MAINNET]);
  for (const res of doc.resources) {
    const { r, path } = await challenge(app, publicUrl, res);
    assert.equal(r.status, 402, path);
    const pr = decode(r.headers.get('payment-required'));
    assert.deepEqual(pr.accepts.map((a) => a.network), ['eip155:8453', 'eip155:137', 'eip155:42161', SOLANA_MAINNET], path);
    assert.equal(pr.accepts[3].payTo, 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte'); assert.equal(pr.accepts[3].amount, pr.accepts[0].amount);
    const key = res.replace('https://api.youraitools.co/', '').replace(/\//g, '_');
    assert.ok(fixtures[key] || /batch$/.test(key), `missing Base fixture for ${key}`);
    if (fixtures[key]) assert.equal(JSON.stringify(pr.accepts[0]), JSON.stringify(fixtures[key]), `${path}: Base entry must be byte-identical to the pre-multichain live entry`);
    const [b, p, a] = pr.accepts;
    for (const [e, asset] of [[p, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'], [a, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831']]) {
      assert.equal(e.asset, asset); assert.deepEqual(e.extra, { name: 'USD Coin', version: '2' });
      assert.equal(e.amount, b.amount); assert.equal(e.payTo, b.payTo); assert.equal(e.maxTimeoutSeconds, b.maxTimeoutSeconds); assert.equal(e.scheme, 'exact');
    }
    assert.equal(b.payTo, '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F');
    // v1 body terms stay Base-only
    const body = await r.json();
    if (body.accepts) assert.deepEqual(body.accepts.map((x) => x.network), ['base']);
  }
});

test('legacy config (no enabledNetworks): Base only, exactly as before', async () => {
  const { app, publicUrl } = build({ enabledNetworks: undefined });
  const doc = await resources(app, publicUrl);
  for (const res of doc.resources) {
    const { r, path } = await challenge(app, publicUrl, res);
    assert.equal(r.status, 402, path);
    assert.deepEqual(decode(r.headers.get('payment-required')).accepts.map((a) => a.network), ['eip155:8453']);
  }
});

test('settle routing: a Polygon payment is verified against the Polygon requirements; a disabled network gets a 402', async () => {
  const { app, fac, publicUrl } = build();
  const doc = await resources(app, publicUrl);
  const { r, path } = await challenge(app, publicUrl, doc.resources[0]);
  const pr = decode(r.headers.get('payment-required'));
  const poly = pr.accepts.find((a) => a.network === 'eip155:137');
  const partial = await new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())).createPaymentPayload(2, poly);
  const sig = enc({ x402Version: 2, resource: pr.resource, accepted: poly, ...partial });
  const { r: r2 } = await challenge(app, publicUrl, doc.resources[0], { 'PAYMENT-SIGNATURE': sig });
  assert.equal(r2.status, 402);
  assert.equal(fac.verified.length, 1, path);
  assert.equal(fac.verified[0].network, 'eip155:137');
  assert.equal(fac.verified[0].asset, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
  assert.equal(fac.settled.length, 0);
  // Avalanche (not enabled) is rejected before any facilitator call
  const avax = { ...poly, network: 'eip155:43114', asset: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' };
  const sig2 = enc({ x402Version: 2, resource: pr.resource, accepted: avax, ...partial });
  const { r: r3 } = await challenge(app, publicUrl, doc.resources[0], { 'PAYMENT-SIGNATURE': sig2 });
  assert.equal(r3.status, 402); assert.equal(fac.verified.length, 1);
});

test('Solana mainnet entry builds correctly with the payout payTo (CDP fee payer)', async () => {
  const sol = 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte';
  const { app, publicUrl } = build({ enabledNetworks: `${DEFAULT_ENABLED},${SOLANA_MAINNET}`, solanaPayTo: sol });
  const doc = await resources(app, publicUrl);
  const { r } = await challenge(app, publicUrl, doc.resources[0]);
  const pr = decode(r.headers.get('payment-required'));
  assert.deepEqual(pr.accepts.map((a) => a.network), ['eip155:8453', 'eip155:137', 'eip155:42161', SOLANA_MAINNET]);
  const s = pr.accepts[3];
  assert.equal(s.asset, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); assert.equal(s.payTo, sol); assert.equal(s.amount, pr.accepts[0].amount);
  assert.equal(s.extra.feePayer, 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb');
});
