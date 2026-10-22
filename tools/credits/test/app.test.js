import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, pay, dec, BASE } from './helpers.js';
import { KEY_RE, keyHash } from '../src/ledger.js';
import { gateOps } from '../src/gate.js';

const bearer = (k) => ({ authorization: `Bearer ${k}` });

test('pack routes answer 402 (GET, POST, POST {}) with the pack price; v1 terms in the body', async () => {
  const { f } = build({ multichain: true });
  for (const [p, amt] of [['/v1/pack/1', '1000000'], ['/v1/pack/5', '5000000'], ['/v1/pack/sample', '5000'], ['/v1/topup/1', '1000000'], ['/v1/topup/5', '5000000']]) {
    for (const init of [{}, { method: 'POST' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }]) {
      const r = await f(p, init);
      assert.equal(r.status, 402, p);
      const pr = dec(r.headers.get('payment-required'));
      assert.equal(pr.resource.url, `${BASE}${p}`);
      assert.deepEqual(pr.accepts.map((a) => a.network), ['eip155:8453', 'eip155:137', 'eip155:42161', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
      assert.ok(pr.accepts.every((a) => a.amount === amt));
      assert.equal(pr.extensions.bazaar.info.output.type, 'json');
      const body = await r.json();
      assert.equal(body.x402Version, 1); assert.equal(body.accepts[0].maxAmountRequired, amt); assert.equal(body.accepts[0].network, 'base');
    }
  }
});

test('buying a pack mints a key (shown once) with the right balance; $5 pack has the 10% bonus', async () => {
  const { f, accounts, facilitator } = build();
  for (const [p, bal] of [['/v1/pack/1', '1.00'], ['/v1/pack/5', '5.50'], ['/v1/pack/sample', '0.005']]) {
    const { r } = await pay(f, p);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('payment-response'));
    assert.equal(r.headers.get('cache-control').includes('no-store') || r.headers.get('cache-control').includes('private'), true);
    const j = await r.json();
    assert.match(j.api_key, KEY_RE); assert.equal(j.shown_once, true); assert.equal(j.balance_usd, bal);
    const mem = accounts.mems.get(await keyHash(j.api_key));
    assert.ok(mem.get('a'), 'account stored under the key hash');
    assert.ok(![...accounts.mems.keys()].includes(j.api_key), 'raw key never used as a storage name');
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(mem.get('a').payments[0].transaction, '0x' + 'ab'.repeat(32), 'settlement recorded');
    const b = await (await f('/v1/balance', { headers: bearer(j.api_key) })).json();
    assert.equal(b.balance_usd, bal); assert.equal(b.status, 'active');
  }
  assert.equal(facilitator.settled.length, 3);
});

test('a pack whose settlement fails returns no key and leaves no account', async () => {
  const { f, accounts } = build({ settleOk: false });
  const { r } = await pay(f, '/v1/pack/1');
  assert.equal(r.status, 402);
  const t = await r.text(); assert.ok(!/yatc_(?!EXAMPLE)/.test(t), 'key never revealed'); assert.ok(!/api_key":"yatc_(?!EXAMPLE)/.test(t));
  await new Promise((res) => setTimeout(res, 10));
  const live = [...accounts.mems.values()].filter((m) => m.get('a'));
  assert.equal(live.length, 0);
});

test('balance: missing key 401, malformed 401, unknown 404', async () => {
  const { f } = build();
  assert.equal((await f('/v1/balance')).status, 401);
  assert.equal((await f('/v1/balance', { headers: bearer('nope') })).status, 401);
  assert.equal((await f('/v1/balance', { headers: bearer('yatc_' + 'A'.repeat(43)) })).status, 404);
});

test('top-up: bare 402, bad key 400 before payment, paid top-up credits after settlement, failed settlement credits nothing', async () => {
  const { f, facilitator } = build();
  const { r } = await pay(f, '/v1/pack/1'); const { api_key } = await r.json();
  assert.equal((await f('/v1/topup/5', { method: 'POST' })).status, 402);
  const before = facilitator.verified.length;
  const bad = await f('/v1/topup/5', { method: 'POST', headers: bearer('yatc_' + 'B'.repeat(43)) });
  assert.equal(bad.status, 400); assert.equal(facilitator.verified.length, before, 'never reaches payment');
  const t = await pay(f, '/v1/topup/5', { headers: bearer(api_key) });
  assert.equal(t.r.status, 200);
  assert.equal((await (await f('/v1/balance', { headers: bearer(api_key) })).json()).balance_usd, '6.50');
  facilitator.settleOk = false;
  const t2 = await pay(f, '/v1/topup/1', { headers: bearer(api_key) });
  assert.equal(t2.r.status, 402);
  await new Promise((res) => setTimeout(res, 10));
  const b = await (await f('/v1/balance', { headers: bearer(api_key) })).json();
  assert.equal(b.balance_usd, '6.50'); assert.equal(b.payments.length, 2);
});

test('gate: atomic debit, insufficient balance, idempotent refund', async () => {
  const { f, accounts } = build();
  const { r } = await pay(f, '/v1/pack/sample'); const { api_key: key } = await r.json();
  const g = gateOps(accounts, null);
  const ref = (i) => 'r_' + String(i).padStart(24, '0');
  assert.deepEqual(await g.debit({ key, amount: '3000', tool: 'payguard', route: 'GET /v1/address', ref: ref(1) }), { ok: true, balance: 2000 });
  assert.deepEqual(await g.debit({ key, amount: '3000', tool: 'payguard', ref: ref(2) }), { ok: false, reason: 'insufficient_balance', balance: 2000 });
  assert.deepEqual(await g.refund({ key, ref: ref(1) }), { ok: true, balance: 5000 });
  assert.deepEqual(await g.refund({ key, ref: ref(1) }), { ok: true, balance: 5000 }, 'second refund is a no-op');
  assert.equal((await g.debit({ key: 'yatc_' + 'C'.repeat(43), amount: 1000, ref: ref(3) })).reason, 'invalid_key');
  assert.equal((await g.debit({ key: 'garbage', amount: 1000, ref: ref(3) })).reason, 'invalid_key');
  assert.equal((await g.debit({ key, amount: -5, ref: ref(4) })).reason, 'bad_request');
  assert.equal((await g.debit({ key, amount: 1000, ref: 'x' })).reason, 'bad_request');
});

test('gate: 200 concurrent debits never overspend (exactly floor(balance / price) succeed)', async () => {
  const { f, accounts } = build({ delayMs: 3 });
  const { r } = await pay(f, '/v1/pack/1'); const { api_key: key } = await r.json();
  const g = gateOps(accounts, null);
  const res = await Promise.all(Array.from({ length: 200 }, (_, i) => g.debit({ key, amount: 15000, tool: 'tokenverdict', ref: 'r_' + String(i).padStart(24, '0') })));
  assert.equal(res.filter((x) => x.ok).length, 66);
  assert.equal(res.filter((x) => x.reason === 'insufficient_balance').length, 134);
  const b = await (await f('/v1/balance', { headers: bearer(key) })).json();
  assert.equal(b.balance_usd, '0.01'); assert.equal(b.calls, 66); assert.equal(b.by_tool.tokenverdict.calls, 66);
});

test('rotate: balance moves to a new key, old key stops working', async () => {
  const { f, accounts } = build();
  const { r } = await pay(f, '/v1/pack/1'); const { api_key: old } = await r.json();
  const rr = await f('/v1/key/rotate', { method: 'POST', headers: bearer(old) });
  assert.equal(rr.status, 200);
  const { api_key: fresh, balance_usd } = await rr.json();
  assert.match(fresh, KEY_RE); assert.notEqual(fresh, old); assert.equal(balance_usd, '1.00');
  const g = gateOps(accounts, null);
  assert.equal((await g.debit({ key: old, amount: 1000, ref: 'r_' + '0'.repeat(24) })).reason, 'invalid_key');
  assert.equal((await g.debit({ key: fresh, amount: 1000, ref: 'r_' + '0'.repeat(24) })).ok, true);
});

test('free docs: landing, openapi, well-known, prices, preview, MCP', async () => {
  const { f } = build();
  const html = await (await f('/', { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Buy \$1 with a browser wallet/); assert.match(html, /not refundable/);
  const j = await (await f('/')).json(); assert.equal(j.packs.length, 3);
  const oa = await (await f('/openapi.json')).json(); assert.ok(oa.paths['/v1/pack/1'].post['x-x402']); assert.equal(oa.paths['/v1/pack/5'].get['x-x402'].amount, '5000000');
  const wk = await (await f('/.well-known/x402')).json(); assert.equal(wk.resources.length, 5);
  const q = await (await f('/v1/preview?pack=5')).json(); assert.equal(q.credit_usd, '5.50'); assert.equal(q.calls.find((c) => c.tool === 'PayGuard').calls, 5500);
  const m = await (await f('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
  assert.deepEqual(m.result.tools.map((t) => t.name), ['credits_quote', 'credits_balance']);
  const c = await (await f('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'credits_quote', arguments: { pack: '1' } } }) })).json();
  assert.match(c.result.content[0].text, /\$1.00 of credits/);
  const txt = JSON.stringify([j, oa, wk]);
  for (const w of [/invest/i, /profit/i, /yield/i, /airdrop/i]) assert.ok(!w.test(txt.replace(/not a token or investment/g, '')), `no ${w}`);
});
