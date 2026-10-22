// FACILITATOR=payai|cdp switch. The CDP facilitator is mocked (no network); one test exercises the real
// @coinbase/x402 createFacilitatorConfig offline with a throwaway Ed25519 key to pin the package API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createFacilitatorConfig } from '@coinbase/x402';
import { configFromEnv } from '../src/config.js';
import { selectFacilitator } from '../src/facilitator-select.js';
import { logExtensionResponses } from '../src/facilitator.js';
import { makeApp, NETWORK, fakeNet, AYB } from './helpers.js';

const PAYAI = 'https://facilitator.payai.network';
const CDP_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const KEYS = { CDP_API_KEY_ID: 'test-key-id', CDP_API_KEY_SECRET: 'test-key-secret' };
const mockCdp = () => { const calls = []; return { calls, createConfig: (id, secret) => { calls.push([id, secret]); return { url: CDP_URL, createAuthHeaders: async () => ({ verify: { Authorization: 'Bearer mock-verify' }, settle: { Authorization: 'Bearer mock-settle' }, supported: { Authorization: 'Bearer mock-supported' } }) }; } }; };
const quiet = () => { const warnings = []; return { warnings, warn: (m) => warnings.push(m) }; };

test('selectFacilitator: default and explicit payai use FACILITATOR_URL, never build a CDP config', () => {
  const cdp = mockCdp();
  for (const env of [{}, { FACILITATOR: 'payai' }, { FACILITATOR: ' PayAI ' }, { FACILITATOR: 'payai', ...KEYS }]) {
    const f = selectFacilitator(configFromEnv(env), { createConfig: cdp.createConfig, warn: assert.fail });
    assert.deepEqual([f.name, f.url, f.createAuthHeaders], ['payai', PAYAI, undefined]);
  }
  assert.equal(cdp.calls.length, 0);
});

test('selectFacilitator: cdp with both keys passes them to createFacilitatorConfig and uses its url + createAuthHeaders', () => {
  const cdp = mockCdp();
  const f = selectFacilitator(configFromEnv({ FACILITATOR: 'cdp', ...KEYS }), { createConfig: cdp.createConfig, warn: assert.fail });
  assert.equal(f.name, 'cdp'); assert.equal(f.url, CDP_URL); assert.equal(typeof f.createAuthHeaders, 'function');
  assert.deepEqual(cdp.calls, [['test-key-id', 'test-key-secret']]);
});

test('selectFacilitator: cdp with a missing key (or an unknown value) falls back to PayAI with a warning', () => {
  for (const env of [{ FACILITATOR: 'cdp' }, { FACILITATOR: 'cdp', CDP_API_KEY_ID: 'x' }, { FACILITATOR: 'cdp', CDP_API_KEY_SECRET: 'y' }, { FACILITATOR: 'coinbase', ...KEYS }]) {
    const cdp = mockCdp(); const q = quiet();
    const f = selectFacilitator(configFromEnv(env), { createConfig: cdp.createConfig, warn: q.warn });
    assert.equal(f.name, 'payai'); assert.equal(f.url, PAYAI); assert.equal(f.createAuthHeaders, undefined);
    assert.equal(q.warnings.length, 1); assert.match(q.warnings[0], /PayAI/);
    assert.equal(cdp.calls.length, 0);
  }
});

test('real @coinbase/x402: createFacilitatorConfig(id, secret) -> CDP v2 url + per-path Bearer JWT headers (offline)', async () => {
  const cfg = createFacilitatorConfig('test-key-id', ed25519Secret());
  assert.equal(cfg.url, CDP_URL);
  const h = await cfg.createAuthHeaders();
  for (const op of ['verify', 'settle', 'supported']) {
    assert.match(h[op].Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, op);
    assert.match(h[op]['Correlation-Context'], /source=x402/);
  }
});

test('logExtensionResponses logs the decoded EXTENSION-RESPONSES and never throws', () => {
  const lines = [];
  const r = { success: true, extensionResponses: { bazaar: { status: 'processing' } } };
  assert.equal(logExtensionResponses('cdp', 'settle', r, (l) => lines.push(l)), r);
  assert.deepEqual(lines, ['x402 EXTENSION-RESPONSES cdp settle: {"bazaar":{"status":"processing"}}']);
  assert.equal(logExtensionResponses('cdp', 'verify', { isValid: true }, () => assert.fail()).isValid, true);
});

// --- end to end through createApp with a mocked facilitator HTTP endpoint ---
function facilitatorHttp() {
  const calls = [];
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const fetchImpl = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, headers, body });
    const ext = { 'content-type': 'application/json', 'EXTENSION-RESPONSES': b64({ bazaar: { status: 'processing' } }) };
    const from = body?.paymentPayload?.payload?.authorization?.from;
    if (url.endsWith('/verify')) return new Response(JSON.stringify({ isValid: true, payer: from }), { headers: ext });
    if (url.endsWith('/settle')) return new Response(JSON.stringify({ success: true, transaction: '0x' + 'cd'.repeat(32), network: NETWORK, payer: from }), { headers: ext });
    return new Response('unexpected', { status: 500 });
  };
  return { calls, fetchImpl };
}
async function withMockedFetch(fn) {
  const real = globalThis.fetch; const http = facilitatorHttp(); const logs = []; const realLog = console.log, realWarn = console.warn;
  globalThis.fetch = http.fetchImpl; console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  try { return await fn(http, logs); } finally { globalThis.fetch = real; console.log = realLog; console.warn = realWarn; }
}
const build = async (env, cdp) => {
  const c = configFromEnv(env);
  const appOpts = { facilitatorClient: undefined, facilitator: c.facilitator, cdpApiKeyId: c.cdpApiKeyId, cdpApiKeySecret: c.cdpApiKeySecret, cdpDeps: { createConfig: cdp.createConfig } };
  return (await await makeApp({ appOpts, net: fakeNet() })).fetchApp;
};
const payer = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const UNPAID = `https://x402fix.example.com/v1/check?url=${AYB}`;
const PAID = UNPAID;

test('FACILITATOR=cdp: the 402 makes no network call; verify + settle go to the CDP url with auth headers; EXTENSION-RESPONSES logged', async () => {
  await withMockedFetch(async (http, logs) => {
    const fetchApp = await build({ FACILITATOR: 'cdp', ...KEYS }, mockCdp());
    const unpaid = await fetchApp(UNPAID);
    assert.equal(unpaid.status, 402); assert.equal(http.calls.length, 0, 'no-network 402');
    const r = await payer(fetchApp)(PAID);
    assert.equal(r.status, 200); assert.equal((await r.json()).grade, 'A');
    assert.deepEqual(http.calls.map((c) => c.url), [`${CDP_URL}/verify`, `${CDP_URL}/settle`]);
    assert.equal(http.calls[0].headers.authorization, 'Bearer mock-verify');
    assert.equal(http.calls[1].headers.authorization, 'Bearer mock-settle');
    assert.ok(logs.some((l) => /x402 EXTENSION-RESPONSES cdp settle: \{"bazaar":\{"status":"processing"\}\}/.test(l)), logs.join('\n'));
  });
});

test('FACILITATOR unset (production default) and cdp-without-keys both settle through PayAI with no auth header', async () => {
  for (const env of [{}, { FACILITATOR: 'cdp' }]) {
    await withMockedFetch(async (http, logs) => {
      const cdp = mockCdp();
      const r = await payer(await build(env, cdp))(PAID);
      assert.equal(r.status, 200);
      assert.deepEqual(http.calls.map((c) => c.url), [`${PAYAI}/verify`, `${PAYAI}/settle`]);
      assert.equal(http.calls[0].headers.authorization, undefined);
      assert.equal(cdp.calls.length, 0);
      if (env.FACILITATOR) assert.ok(logs.some((l) => /falling back to PayAI/.test(l)));
    });
  }
});

function ed25519Secret() {
  // CDP Ed25519 secret format: base64(32-byte seed || 32-byte public key)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return Buffer.concat([seed, pub]).toString('base64');
}
