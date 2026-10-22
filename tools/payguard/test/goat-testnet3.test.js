import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, LAZARUS_ETH, BASE } from './helpers.js';
import { GOAT_TESTNET3_TUSDC, GOAT_TESTNET3_USDC } from '../src/goat-testnet3.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString());

test('GOAT Testnet3 route: 402 terms (eip155:48816, tUSDC + GOAT USDC, own receiver)', async () => {
  const fac = { calls: [], async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:48816' }], extensions: [], signers: {} }; }, async verify() { fac.calls.push('verify'); return { isValid: false, invalidReason: 'x' }; }, async settle() { fac.calls.push('settle'); return { success: false }; } };
  const { fetchApp } = await makeApp({ appOpts: { goatTestnet3FacilitatorClient: fac } });
  const res = await fetchApp(`${BASE}/goat-testnet3/v1/address?address=${LAZARUS_ETH}`);
  assert.equal(res.status, 402);
  const pr = decode(res.headers.get('payment-required'));
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.resource.url.startsWith(`${BASE}/goat-testnet3/v1/address`), true);
  assert.deepEqual(pr.accepts.map((a) => [a.network, a.asset, a.amount, a.extra.name, a.extra.version]), [
    ['eip155:48816', GOAT_TESTNET3_TUSDC, '1000', 'PayGuard Test USD', '1'],
    ['eip155:48816', GOAT_TESTNET3_USDC, '1000', 'USD Coin', '1'],
  ]);
  for (const a of pr.accepts) assert.equal(a.payTo, '0x35A4577c2Bd3c6dC283285c879C3E5cfD252C6a1');
  assert.deepEqual(fac.calls, []);
});

test('GOAT Testnet3 route: invalid address is a free 400, base route terms unchanged', async () => {
  const { fetchApp } = await makeApp();
  assert.equal((await fetchApp(`${BASE}/goat-testnet3/v1/address?address=%20`)).status, 400);
  const base = decode((await fetchApp(`${BASE}/v1/address?address=${LAZARUS_ETH}`)).headers.get('payment-required'));
  assert.deepEqual(base.accepts.map((a) => a.network), ['eip155:8453']);
});
