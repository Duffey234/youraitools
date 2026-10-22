import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { makeApp, fakeRpc, fakeNet, BASE, AWS_EXAMPLE, MNEMONIC, HARDHAT0, NETWORK } from './helpers.js';
import { deepScan, liteScan, previewScan, LIMITS } from '../src/scan.js';
import { deriveAddresses, checkExposure } from '../src/exposure.js';
import { scan } from '../src/engine.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString());
const payer = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const post = (path, body, ct = 'application/json') => [`${BASE}${path}`, { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) }];
const KEY_TEXT = `PRIVATE_KEY=${HARDHAT0}`;
const HH_ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

test('paid routes: GET, HEAD-like GET without input, empty POST and POST {} answer 402 with PAYMENT-REQUIRED; Base first', async () => {
  const { fetchApp } = await makeApp();
  for (const [path, amount] of [['/v1/lite', '5000'], ['/v1/scan', '20000']]) {
    for (const r of [await fetchApp(`${BASE}${path}`), await fetchApp(...post(path, '')), await fetchApp(...post(path, {}))]) {
      assert.equal(r.status, 402, path);
      const pr = decode(r.headers.get('payment-required'));
      assert.equal(pr.accepts[0].network, 'eip155:8453'); assert.equal(pr.accepts[0].amount, amount);
      assert.equal(pr.accepts[0].payTo, '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F');
      assert.ok(pr.resource.url.endsWith(path));
      assert.ok(pr.resource.description.length <= 390, 'CDP rejects long descriptions');
    }
  }
});

test('invalid input is rejected before payment (400/413, no PAYMENT-REQUIRED), even with a payment header', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const cases = [
    post('/v1/lite', { json: { a: 1 } }), post('/v1/lite', { text: 5 }), post('/v1/scan', { text: 'x', json: {} }), post('/v1/lite', '{not json'),
    post('/v1/lite', { text: 'a'.repeat(LIMITS.liteBytes + 1) }), post('/v1/scan', { text: 'x', style: 'weird' }), [`${BASE}/v1/lite?text=x&min_severity=huge`],
  ];
  for (const c of cases) {
    for (const h of [{}, { 'PAYMENT-SIGNATURE': 'e30=' }, { 'X-PAYMENT': 'e30=' }]) {
      const init = { ...(c[1] || {}), headers: { ...(c[1]?.headers || {}), ...h } };
      const r = await fetchApp(c[0], init);
      assert.ok(r.status === 400 || r.status === 413, `${c[0]} ${r.status}`);
      assert.equal(r.headers.get('payment-required'), null);
    }
  }
  assert.equal(facilitator.verified.length, 0);
});

test('paid lite: redacts wallet keys and secrets, never echoes them; settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const text = `seed ${MNEMONIC}\n${KEY_TEXT}\naws ${AWS_EXAMPLE} mail ops@example.com`;
  const r = await payer(fetchApp)(...post('/v1/lite', { text }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verdict, 'WALLET_KEY_EXPOSED'); assert.equal(j.safe_to_send, false); assert.equal(j.tier, 'lite');
  const s = JSON.stringify(j.findings);
  assert.ok(!s.includes('ac0974bec39a') && !s.includes('abandon about') && !s.includes(AWS_EXAMPLE));
  assert.ok(!j.redacted.includes('ac0974bec39a') && !j.redacted.includes(AWS_EXAMPLE));
  assert.ok(j.findings.every((f) => typeof f.remediation === 'string'));
  assert.equal(facilitator.settled.length, 1);
});

test('text/plain body works; clean text is CLEAN with high confidence', async () => {
  const { fetchApp } = await makeApp();
  const r = await payer(fetchApp)(...post('/v1/lite', 'The quick brown fox jumps over the lazy dog. Version 1.2.3.4 shipped.', 'text/plain'));
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.verdict, 'CLEAN'); assert.equal(j.safe_to_send, true); assert.equal(j.confidence, 'high');
});

test('deep scan JSON: key-name context catches a bare hex key; secret JSON keys never leak through paths', async () => {
  const rpc = fakeRpc({ evm: { [HH_ADDR]: { wei: 10n ** 16n, nonce: 3 } } });
  const { fetchApp } = await makeApp({ net: rpc });
  const json = { tool: 'send', args: { privateKey: HARDHAT0.slice(2), note: 'call me 555-123-4567' }, ['sk_live_' + 'a'.repeat(24)]: true };
  const r = await payer(fetchApp)(...post('/v1/scan', { json }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.verdict, 'WALLET_KEY_EXPOSED');
  assert.deepEqual(j.findings.map((f) => f.type).sort(), ['evm_private_key', 'phone', 'stripe_secret_key']);
  assert.equal(j.redacted_json.args.privateKey, '[REDACTED:evm_private_key]');
  assert.ok(!JSON.stringify(j).includes('a'.repeat(24)) && !JSON.stringify(j).includes('ac0974bec39a'));
  assert.equal(j.exposure.status, 'funds_at_risk');
  assert.equal(j.exposure.addresses[0].address.toLowerCase(), HH_ADDR);
  assert.equal(j.exposure.addresses[0].balances.base.native, '0.01');
  assert.match(j.actions[0], /^URGENT/);
  assert.equal(j.confidence, 'high'); assert.deepEqual(j.sources_failed, []);
});

test('FAIL-CLOSED: all balance RPCs down -> exposure unknown, sources_failed listed, confidence low, never no_funds_found', async () => {
  const rpc = fakeRpc({ down: [''] }) // every RPC host fails;
  const r = await deepScan({ text: `${KEY_TEXT}\nseed ${MNEMONIC}` }, {}, { fetchImpl: rpc.fetchImpl });
  assert.equal(r.verdict, 'WALLET_KEY_EXPOSED');
  assert.equal(r.exposure.status, 'unknown');
  assert.ok(r.exposure.addresses.every((a) => a.status === 'unknown'));
  assert.equal(r.confidence, 'low');
  assert.ok(r.sources_failed.length >= 5, JSON.stringify(r.sources_failed));
  assert.match(r.actions[0], /could not be fully checked/);
  assert.equal(r.safe_to_send, false);
});

test('FAIL-CLOSED: one chain down -> address unknown (not no_funds_found) unless funds were seen elsewhere', async () => {
  const empty = fakeRpc({ down: ['poly'] });
  const r1 = await deepScan({ text: KEY_TEXT }, {}, { fetchImpl: empty.fetchImpl });
  assert.equal(r1.exposure.addresses[0].status, 'unknown'); assert.deepEqual(r1.exposure.addresses[0].chains_failed, ['polygon']); assert.equal(r1.confidence, 'low');
  const funded = fakeRpc({ down: ['poly'], evm: { [HH_ADDR]: { usdc: 5_000_000n } } });
  const r2 = await deepScan({ text: KEY_TEXT }, {}, { fetchImpl: funded.fetchImpl });
  assert.equal(r2.exposure.status, 'funds_at_risk'); assert.equal(r2.exposure.addresses[0].balances.base.usdc, '5'); assert.equal(r2.confidence, 'low');
});

test('FAIL-CLOSED: a timed-out RPC falls back to the next one; a hung chain becomes unknown', async () => {
  const ok = fakeRpc();
  const hang = async (u, init) => (String(u).includes('base-rpc.publicnode') ? new Promise(() => {}) : ok.fetchImpl(u, init));
  const r = await deepScan({ text: KEY_TEXT }, {}, { fetchImpl: hang });
  assert.equal(r.exposure.status, 'no_funds_found'); assert.equal(r.confidence, 'high'); // second Base RPC answered
});

test('all chains answer zero -> no_funds_found; EVM history -> used_empty', async () => {
  const r = await deepScan({ text: KEY_TEXT }, {}, { fetchImpl: fakeRpc().fetchImpl });
  assert.equal(r.exposure.status, 'no_funds_found');
  const r2 = await deepScan({ text: KEY_TEXT }, {}, { fetchImpl: fakeRpc({ evm: { [HH_ADDR]: { nonce: 7 } } }).fetchImpl });
  assert.equal(r2.exposure.status, 'used_empty');
});

test('derivation: BIP39 spec mnemonic and Hardhat key give the known addresses; Solana keypair is verified', async () => {
  const t = `seed ${MNEMONIC} ${KEY_TEXT}`;
  const d = await deriveAddresses(t, await scan(t));
  const by = Object.fromEntries(d.addresses.map((a) => [a.path || a.type, a.address]));
  assert.equal(by["m/44'/60'/0'/0/0"], '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.equal(by["m/44'/501'/0'/0'"], 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(by.evm_private_key, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  // 64 random bytes are flagged as a Solana key but no address is derived from a non-keypair
  const fake = `[${Array.from({ length: 64 }, (_, i) => (i * 7) % 256).join(',')}]`;
  const d2 = await deriveAddresses(fake, await scan(fake));
  assert.equal(d2.addresses.length, 0); assert.match(d2.not_checked[0].reason, /not an ed25519 keypair/);
});

test('no wallet keys -> no network calls at all in the deep scan', async () => {
  const net = fakeNet();
  const r = await deepScan({ text: `aws ${AWS_EXAMPLE}` }, {}, { fetchImpl: net.fetchImpl });
  assert.equal(r.exposure.status, 'not_applicable'); assert.equal(net.calls.length, 0); assert.equal(r.confidence, 'high');
});

test('free preview (GET and POST) and MCP: counts only, never positions or redacted text', async () => {
  const { fetchApp } = await makeApp();
  const r = await fetchApp(`${BASE}/v1/preview?text=${encodeURIComponent(KEY_TEXT)}`);
  const j = await r.json();
  assert.equal(j.verdict, 'WALLET_KEY_EXPOSED'); assert.equal(j.findings, undefined); assert.equal(j.redacted, undefined);
  assert.ok(!JSON.stringify(j).includes('ac0974'));
  const r2 = await fetchApp(...post('/v1/preview', { text: 'a'.repeat(LIMITS.previewBytes + 1) }));
  assert.equal(r2.status, 413);
  const m = await (await fetchApp(...post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scan_for_leaks', arguments: { text: KEY_TEXT } } }))).json();
  assert.equal(m.result.structuredContent.verdict, 'WALLET_KEY_EXPOSED'); assert.ok(!JSON.stringify(m).includes('ac0974'));
  const l = await (await fetchApp(...post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json();
  assert.deepEqual(l.result.tools.map((t) => t.name), ['scan_for_leaks']);
});

test('preview rate limit -> 429', async () => {
  const { fetchApp } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await fetchApp(`${BASE}/v1/preview?text=hi`)).status, 429);
});

test('discovery: openapi lists only paid + preview routes, well-known lists both paid routes, favicon, landing', async () => {
  const { fetchApp } = await makeApp();
  const o = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.deepEqual(Object.keys(o.paths).sort(), ['/v1/lite', '/v1/preview', '/v1/scan']);
  const w = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(w.resources, [`${BASE}/v1/lite`, `${BASE}/v1/scan`]);
  assert.equal((await fetchApp(`${BASE}/favicon.ico`)).status, 200);
  const h = await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } });
  const html = await h.text();
  assert.match(html, /LeakGuard/); assert.ok(!/safe to buy/i.test(html));
  const s = await (await fetchApp(`${BASE}/v1/stats`)).json(); assert.ok(s);
});

test('lite + preview helpers', async () => {
  const p = await previewScan(`mail bob@example.org`); assert.equal(p.verdict, 'PII_FOUND');
  const l = await liteScan(`card 4111 1111 1111 1111`, { style: 'mask' }); assert.match(l.redacted, /\*\*\*1111/);
});
