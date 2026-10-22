import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, checkSign, decodeCall, verdictOf, InputError } from '../src/sign.js';
import { makeRpc } from '../src/rpc.js';
import { fakeNet, USDC, EOA, ME, ROUTER, UNLABELLED, NFT, PAY_TO, NOW, pad, approveData, transferData } from './helpers.js';
const SDN = '0x0330070fd38ec3bb94f58fa55d40368271e9e54a';
const net = fakeNet();
const opts = (tier = 'full') => ({ tier, now: NOW, rpcFor: (id) => (id === 8453 ? makeRpc({ fetchImpl: net.fetchImpl, urls: ['https://rpc.test'] }) : null), lookupSelectors: async (s) => Object.fromEntries(s.map((x) => [x, x === '0xdeadbeef' ? ['claimAirdrop()'] : []])) });
const check = (body, tier) => checkSign(normalizeInput(body), opts(tier));
const codes = (r) => r.flags.map((f) => f.code);
const T = Math.floor(NOW / 1000);
const domUSDC = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };

test('decodeCall: approve, transfer, setApprovalForAll, multicall3, unknown', () => {
  assert.equal(decodeCall(approveData(EOA)).action, 'erc20_approve');
  assert.equal(decodeCall(transferData(EOA, 5)).action, 'erc20_transfer');
  assert.equal(decodeCall('0xa22cb465' + pad(EOA) + pad('1')).action, 'set_approval_for_all');
  assert.equal(decodeCall('0x').action, 'native_transfer');
  assert.equal(decodeCall('0xdeadbeef'), null);
});

test('plain USDC transfer to a wallet: SAFE, human amount', async () => {
  const r = await check({ tx: { to: USDC, data: transferData(PAY_TO, 2500000), from: ME } });
  assert.equal(r.verdict, 'SAFE', JSON.stringify(r.flags)); assert.match(r.summary, /2\.5 USDC/);
});

test('approve exact amount to a known router: SAFE; unlimited to an unlabelled contract: CAUTION', async () => {
  const a = await check({ tx: { to: USDC, data: approveData(ROUTER, '1000000'), from: ME } });
  assert.equal(a.verdict, 'SAFE', JSON.stringify(a.flags)); assert.match(a.summary, /Uniswap/);
  const b = await check({ tx: { to: USDC, data: approveData(UNLABELLED), from: ME } });
  assert.equal(b.verdict, 'CAUTION'); assert.ok(codes(b).includes('UNLIMITED_APPROVAL') && codes(b).includes('SPENDER_UNLABELLED'));
});

test('setApprovalForAll to an EOA: DANGER', async () => {
  const r = await check({ tx: { to: NFT, data: '0xa22cb465' + pad(EOA) + pad('1'), from: ME } });
  assert.equal(r.verdict, 'DANGER'); assert.ok(codes(r).includes('SET_APPROVAL_FOR_ALL') && codes(r).includes('SPENDER_IS_EOA'));
});

test('transfer to the token contract itself and to zero: flagged', async () => {
  const r = await check({ tx: { to: USDC, data: transferData(USDC, 1) } });
  assert.ok(codes(r).includes('SENT_TO_TOKEN_CONTRACT'));
  const z = await check({ tx: { to: USDC, data: transferData('0x0000000000000000000000000000000000000000', 1) } }, 'preview');
  assert.ok(codes(z).includes('BURN_TO_ZERO')); assert.equal(z.verdict, 'DANGER');
});

test('multicall3: inner approve to an EOA is decoded and flagged', async () => {
  const inner = approveData(EOA).slice(2);
  // aggregate3((address,bool,bytes)[]) with one call
  const data = '0x82ad56cb' + pad('20') + pad('1') + pad('20') + pad(USDC) + pad('1') + pad('60') + pad((inner.length / 2).toString(16)) + inner.padEnd(Math.ceil(inner.length / 64) * 64, '0');
  const r = await check({ tx: { to: '0xcA11bde05977b3631167028862bE2a173976CA11', data, from: ME } });
  assert.match(r.summary, /Batch of 1 call/); assert.ok(codes(r).includes('SPENDER_IS_EOA'), codes(r).join()); assert.equal(r.verdict, 'DANGER');
});

test('unknown function: CAUTION + public 4-byte name', async () => {
  const r = await check({ tx: { to: UNLABELLED, data: '0xdeadbeef', value: '1000000000000000000', from: ME } });
  assert.equal(r.verdict, 'CAUTION'); assert.ok(codes(r).includes('UNKNOWN_FUNCTION') && codes(r).includes('VALUE_TO_UNKNOWN_CALL'));
  assert.ok(r.flags.some((f) => f.code === 'FUNCTION_NAME_GUESS' && /claimAirdrop/.test(f.message)));
});

test('OFAC SDN counterparty: DANGER in preview and full', async () => {
  for (const tier of ['preview', 'full']) {
    const r = await check({ tx: { to: USDC, data: transferData(SDN, 1) } }, tier);
    assert.equal(r.verdict, 'DANGER'); assert.ok(codes(r).includes('SANCTIONED_COUNTERPARTY'));
  }
});

test('EIP-2612 Permit signature to an EOA, unlimited, no expiry: DANGER', async () => {
  const r = await check({ typed_data: { domain: domUSDC, primaryType: 'Permit', types: {}, message: { owner: ME, spender: EOA, value: (2n ** 256n - 1n).toString(), nonce: 0, deadline: (2n ** 256n - 1n).toString() } } });
  assert.equal(r.verdict, 'DANGER'); for (const c of ['OFFCHAIN_APPROVAL', 'UNLIMITED_APPROVAL', 'NO_EXPIRY', 'SPENDER_IS_EOA']) assert.ok(codes(r).includes(c), c);
});

test('fake "USD Coin" domain and Permit2 lookalike: critical', async () => {
  const f = await check({ typed_data: { domain: { ...domUSDC, verifyingContract: UNLABELLED }, primaryType: 'TransferWithAuthorization', types: {}, message: { from: ME, to: PAY_TO, value: '1000', validAfter: '0', validBefore: String(T + 60), nonce: '0x' + '0'.repeat(64) } } }, 'preview');
  assert.ok(codes(f).includes('FAKE_TOKEN_DOMAIN')); assert.equal(f.verdict, 'DANGER');
  const p = await check({ typed_data: { domain: { name: 'Permit2', chainId: 8453, verifyingContract: UNLABELLED }, primaryType: 'PermitSingle', types: {}, message: { details: { token: USDC, amount: '1000', expiration: String(T + 3600), nonce: 0 }, spender: ROUTER, sigDeadline: String(T + 600) } } }, 'preview');
  assert.ok(codes(p).includes('PERMIT2_LOOKALIKE'));
});

test('x402: matching payment SAFE; overpay / wrong payTo / long validity DANGER (base64 headers accepted)', async () => {
  const req = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '15000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }] };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const pay = (auth) => ({ x402Version: 2, payload: { signature: '0x', authorization: { from: ME, to: PAY_TO, value: '15000', validAfter: '0', validBefore: String(T + 120), nonce: '0x' + '1'.repeat(64), ...auth } } });
  const ok = await check({ payment_required: b64(req), payment_payload: b64(pay({})) });
  assert.equal(ok.verdict, 'SAFE', JSON.stringify(ok.flags)); assert.equal(ok.x402.matches, true); assert.equal(ok.kind, 'x402_payment');
  const over = await check({ payment_required: req, payment_payload: pay({ value: '15000000', to: EOA, validBefore: String(T + 86400) }) });
  assert.equal(over.verdict, 'DANGER'); for (const c of ['X402_OVERPAY', 'X402_PAYTO_MISMATCH', 'X402_LONG_VALIDITY']) assert.ok(codes(over).includes(c), c);
  assert.deepEqual(over.x402.mismatches.sort(), ['amount', 'pay_to', 'validity']);
  const pv = await check({ payment_required: req, payment_payload: pay({ value: '15000000' }) }, 'preview');
  assert.equal(pv.x402.matches, false); assert.equal(pv.flags[0].message, undefined);
});

test('EIP-7702 delegation with chainId 0: DANGER; Seaport zero-price listing: DANGER', async () => {
  const d = await check({ authorization: { address: UNLABELLED, chainId: 0, nonce: 1 } });
  assert.equal(d.verdict, 'DANGER'); assert.ok(codes(d).includes('EIP7702_ALL_CHAINS'));
  const s = await check({ typed_data: { domain: { name: 'Seaport', version: '1.6', chainId: 8453, verifyingContract: '0x0000000000000068F116a894984e2DAB9D29Fa94' }, primaryType: 'OrderComponents', types: {}, message: { offerer: ME, offer: [{ itemType: 2, token: NFT, identifierOrCriteria: '1', startAmount: '1', endAmount: '1' }], consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', startAmount: '1', endAmount: '1', recipient: EOA }], endTime: String(T + 86400) } } }, 'preview');
  assert.ok(codes(s).includes('ZERO_PRICE_LISTING')); assert.equal(s.verdict, 'DANGER');
});

test('other chains decode offline only; chain mismatch flagged', async () => {
  const r = await check({ chain: 137, tx: { to: USDC, data: approveData(EOA) } });
  assert.ok(codes(r).includes('NO_ONCHAIN_CHECKS'));
  const m = await check({ chain: 'ethereum', typed_data: { domain: domUSDC, primaryType: 'Permit', types: {}, message: { owner: ME, spender: ROUTER, value: '1', nonce: 0, deadline: String(T + 600) } } }, 'preview');
  assert.ok(codes(m).includes('CHAIN_MISMATCH'));
});

test('verdictOf + input errors', () => {
  assert.equal(verdictOf([]).verdict, 'SAFE'); assert.equal(verdictOf([{ severity: 'medium' }]).verdict, 'CAUTION'); assert.equal(verdictOf([{ severity: 'high' }]).verdict, 'DANGER');
  assert.throws(() => normalizeInput({}), InputError); assert.throws(() => normalizeInput({ tx: { to: '0x12' } }), InputError);
});
