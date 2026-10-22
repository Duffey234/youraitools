// Direct USDC transfer + POST /v1/claim, against mocked public-RPC answers (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build, PAY_TO, pay, dec } from './helpers.js';
import { KEY_RE } from '../src/ledger.js';
import { CHAINS, TRANSFER_TOPIC } from '../src/claim.js';

const BUYER = '0x' + '22'.repeat(20);
const SECRET = '0x' + '5e'.repeat(32);
const commit = (s) => createHash('sha256').update(Buffer.from(s.slice(2), 'hex')).digest('hex');
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hx = (n) => '0x' + BigInt(n).toString(16);
const TX = (i) => '0x' + String(i).padStart(2, '0').repeat(32);

/** One fake chain state: txs[hash] = { tx, receipt }; head block number. */
function chainMock({ head = 1000 } = {}) {
  const txs = {}; const calls = [];
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body); calls.push({ url, method });
    const t = txs[params?.[0]];
    const result = method === 'eth_blockNumber' ? hx(m.head) : method === 'eth_getTransactionByHash' ? (t ? t.tx : null) : (t ? t.receipt : null);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
  };
  const m = { head, txs, calls, fetchImpl };
  /** Add a transfer. Overrides: token (tx.to), to (recipient), amount, from, suffix, status, block, logFrom, mined. */
  m.add = (hash, o = {}) => {
    const chain = CHAINS[o.chain || 'base'];
    const token = o.token || chain.usdc; const to = o.to || PAY_TO; const amount = o.amount ?? 1000000; const from = o.from || BUYER;
    const suffix = o.suffix === undefined ? commit(SECRET) : o.suffix;
    const input = '0xa9059cbb' + pad(to).slice(2) + BigInt(amount).toString(16).padStart(64, '0') + suffix;
    txs[hash] = { tx: { hash, from, to: token, input, blockNumber: hx(o.block ?? 990) },
      receipt: o.mined === false ? null : { status: o.status || '0x1', blockNumber: hx(o.block ?? 990), logs: [{ address: token, topics: [TRANSFER_TOPIC, pad(o.logFrom || from), pad(to)], data: pad(hx(amount)) }] } };
  };
  return m;
}
const claim = (f, body) => f('/v1/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: 'base', secret: SECRET, ...body }) });

test('valid claim: 1 USDC on Base mints a $1.00 key bound to the tx sender', async () => {
  const m = chainMock(); m.add(TX(1));
  const { f } = build({ rpcFetch: m.fetchImpl });
  const r = await claim(f, { txHash: TX(1) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.api_key, KEY_RE); assert.equal(j.balance_usd, '1.00'); assert.equal(j.payment.payer, BUYER); assert.equal(j.payment.method, 'direct_transfer');
  const b = await (await f('/v1/balance', { headers: { authorization: `Bearer ${j.api_key}` } })).json();
  assert.equal(b.balance_usd, '1.00'); assert.equal(b.payments[0].transaction, TX(1)); assert.equal(b.payments[0].network, 'eip155:8453');
  assert.ok(m.calls.every((c) => CHAINS.base.rpcs.includes(c.url)), 'public Base RPC only');
});

test('valid claim: 5 USDC on Polygon and Arbitrum mint $5.50 keys', async () => {
  for (const chain of ['polygon', 'arbitrum']) {
    const m = chainMock({ head: 2000 }); m.add(TX(2), { chain, amount: 5000000, block: 1900 });
    const { f } = build({ rpcFetch: m.fetchImpl });
    const r = await claim(f, { chain, txHash: TX(2) });
    assert.equal(r.status, 200, chain); assert.equal((await r.json()).balance_usd, '5.50');
  }
});

test('replay: the same tx can only be claimed once (also under concurrency)', async () => {
  const m = chainMock(); m.add(TX(3));
  const { f } = build({ rpcFetch: m.fetchImpl, delayMs: 3 });
  const rs = await Promise.all(Array.from({ length: 8 }, () => claim(f, { txHash: TX(3) })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 7);
  const again = await claim(f, { txHash: TX(3) });
  assert.equal(again.status, 409); assert.equal((await again.json()).error, 'already_claimed');
});

test('wrong amount is rejected (no pack costs 2 USDC; 0.999999 is not 1)', async () => {
  const m = chainMock(); m.add(TX(4), { amount: 2000000 }); m.add(TX(5), { amount: 999999 });
  const { f } = build({ rpcFetch: m.fetchImpl });
  for (const h of [TX(4), TX(5)]) { const r = await claim(f, { txHash: h }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'wrong_amount'); }
});

test('wrong recipient is rejected', async () => {
  const m = chainMock(); m.add(TX(6), { to: '0x' + '99'.repeat(20) });
  const { f } = build({ rpcFetch: m.fetchImpl });
  const r = await claim(f, { txHash: TX(6) }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'wrong_recipient');
});

test('wrong token is rejected (other ERC-20, or Base USDC address claimed on Polygon)', async () => {
  const m = chainMock(); m.add(TX(7), { token: '0x' + '77'.repeat(20) }); m.add(TX(8), { chain: 'base' });
  const { f } = build({ rpcFetch: m.fetchImpl });
  let r = await claim(f, { txHash: TX(7) }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'wrong_token');
  r = await claim(f, { chain: 'polygon', txHash: TX(8) }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'wrong_token');
});

test('unconfirmed tx: 202 pending (not mined, then too few confirmations), then 200 once confirmed', async () => {
  const m = chainMock({ head: 1000 }); m.add(TX(9), { mined: false });
  const { f } = build({ rpcFetch: m.fetchImpl });
  let r = await claim(f, { txHash: TX(9) }); assert.equal(r.status, 202); assert.equal((await r.json()).status, 'pending');
  m.add(TX(9), { block: 999 });
  r = await claim(f, { txHash: TX(9) }); assert.equal(r.status, 202); const j = await r.json(); assert.equal(j.confirmations, 2); assert.equal(j.needed, 5); assert.ok(r.headers.get('retry-after'));
  r = await claim(f, { txHash: TX(10) }); assert.equal(r.status, 202, 'unknown tx = not seen yet');
  m.head = 1003;
  r = await claim(f, { txHash: TX(9) }); assert.equal(r.status, 200);
});

test('front-running and x402 txs: wrong claim code 403, no claim code 400, sender mismatch 400, reverted 400', async () => {
  const m = chainMock();
  m.add(TX(11)); m.add(TX(12), { suffix: '' }); m.add(TX(13), { logFrom: '0x' + '44'.repeat(20) }); m.add(TX(14), { status: '0x0' });
  const { f } = build({ rpcFetch: m.fetchImpl });
  let r = await claim(f, { txHash: TX(11), secret: '0x' + 'ab'.repeat(32) }); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'claim_code_mismatch');
  r = await claim(f, { txHash: TX(11) }); assert.equal(r.status, 200, 'the real buyer can still claim after a wrong guess');
  r = await claim(f, { txHash: TX(12) }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'missing_claim_code');
  r = await claim(f, { txHash: TX(13) }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'transfer_not_found');
  r = await claim(f, { txHash: TX(14) }); assert.equal(r.status, 400); assert.equal((await r.json()).error, 'tx_failed');
});

test('bad input 400; RPC down 503 (nothing reserved, retry works); RPC timeout is bounded', async () => {
  const m = chainMock(); m.add(TX(15));
  let down = true;
  const fetchImpl = async (u, i) => { if (down) throw new Error('boom'); return m.fetchImpl(u, i); };
  const { f } = build({ rpcFetch: fetchImpl });
  for (const b of [{ chain: 'solana', txHash: TX(15) }, { txHash: '0x12' }, { txHash: TX(15), secret: 'nope' }]) assert.equal((await claim(f, b)).status, 400);
  assert.equal((await claim(f, { txHash: TX(15) })).status, 503);
  down = false;
  assert.equal((await claim(f, { txHash: TX(15) })).status, 200);
  const hang = build({ rpcFetch: () => new Promise(() => {}) });
  const t0 = Date.now(); const r = await claim(hang.f, { txHash: TX(16) });
  assert.equal(r.status, 503); assert.ok(Date.now() - t0 < 10000, 'two endpoints x 4 s');
});

test('x402 terms of the paid routes are unchanged by the claim route; landing keeps the one-click button and adds direct send', async () => {
  const { f } = build({ multichain: true });
  const r = await f('/v1/pack/1', { method: 'POST' }); assert.equal(r.status, 402);
  const pr = dec(r.headers.get('payment-required')); assert.equal(pr.accepts[0].payTo, PAY_TO); assert.equal(pr.accepts[0].amount, '1000000');
  const html = await (await f('/', { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Buy \$1 with a browser wallet/); assert.match(html, /eth_signTypedData_v4/);
  assert.match(html, /Or send 1 USDC directly \(no signature prompt\)/); assert.match(html, /eth_sendTransaction/); assert.match(html, /0xa9059cbb/);
  assert.match(html, /authorizes exactly this pack's amount/);
  const g = await f('/v1/claim'); assert.equal(g.status, 405);
});
