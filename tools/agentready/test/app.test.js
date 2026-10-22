import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, GOOD, POOR, DOWN, PRIVATE_DNS } from './helpers.js';
import { headAsGet } from '../src/head.js';
import { handle as stdioHandle, TOOLS as STDIO_TOOLS } from '../src/mcp-stdio.js';
import { toUrl } from '../src/lite.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ROUTES = [['lite', '5000'], ['audit', '30000']];
const q = (u) => encodeURIComponent(u);
const mcp = (fetchApp, body) => fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });

test('unpaid: every paid route answers 402 on GET, POST, empty POST and bare probes (v2 header + valid Bazaar, v1 body); no site is fetched', async () => {
  const { fetchApp, engine } = await makeApp();
  for (const [tier, amount] of ROUTES) {
    for (const [u, init] of [[`${BASE}/v1/${tier}?url=${q(GOOD)}`], [`${BASE}/v1/${tier}`], [`${BASE}/v1/${tier}`, json({ url: GOOD })], [`${BASE}/v1/${tier}`, { method: 'POST' }], [`${BASE}/v1/${tier}`, json({})]]) {
      const r = await fetchApp(u, init);
      assert.equal(r.status, 402, `${init?.method || 'GET'} ${u}`);
      const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
      assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', amount, PAY_TO, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
      assert.equal(req.resource.url, `${BASE}/v1/${tier}`);
      assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
      const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount); assert.equal(b.accepts[0].network, 'base');
    }
  }
  assert.equal(engine.calls.length, 0); assert.equal(engine.web.calls.length, 0);
});

test('HEAD = 402 + PAYMENT-REQUIRED with no body and never settles', async () => {
  const { app, facilitator } = await makeApp();
  const h = headAsGet((req) => app.fetch(req));
  for (const [tier, amount] of ROUTES) {
    const r = await h(new Request(`${BASE}/v1/${tier}?url=${q(GOOD)}`, { method: 'HEAD', headers: { 'payment-signature': 'junk', 'x-payment': 'junk' } }));
    assert.equal(r.status, 402); assert.equal(decode(r.headers.get('payment-required')).accepts[0].amount, amount); assert.equal(await r.text(), '');
  }
  assert.equal(facilitator.verified.length, 0);
});

test('bad, private and internal URLs: 400 before payment (never a 402, never charged, nothing fetched)', async () => {
  const { fetchApp, facilitator, engine } = await makeApp();
  for (const u of ['ftp://a.com', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'localhost', 'https://db.internal/', 'https://a.com:2375/', 'https://user:pw@a.com/', 'not a url']) {
    for (const tier of ['lite', 'audit', 'preview']) { const r = await fetchApp(`${BASE}/v1/${tier}?url=${q(u)}`); assert.equal(r.status, 400, `${tier} ${u}`); }
  }
  assert.equal((await fetchApp(`${BASE}/v1/audit`, json({ url: 5 }))).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/audit`, json({ foo: 1 }))).status, 400);
  assert.equal(facilitator.verified.length, 0); assert.equal(engine.calls.length, 0);
});

test('paid v2 audit on an agent-ready site: 200, all 23 checks, settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/audit?url=${q(GOOD)}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier, 'audit'); assert.equal(j.score, 100); assert.equal(j.grade, 'A'); assert.equal(j.checks.length, 23); assert.equal(j.report, `${BASE}/r/good-site.com`);
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '30000');
  assert.ok(r.headers.get('payment-response'));
});

test('paid v2 lite on a poor site: score, grade, top 5 fixes, blocked bots; POST body works', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/lite`, json({ url: POOR }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier, 'lite'); assert.equal(j.grade, 'F'); assert.equal(j.top_issues.length, 5); assert.ok(j.ai_bots_blocked.includes('ChatGPT-User'));
  assert.equal(j.snippets, undefined, 'snippets are audit-tier only'); assert.equal(j.checks, undefined);
  assert.equal(facilitator.settled[0].amount, '5000');
});

test('FAIL-CLOSED on paid routes: unreachable site = 503 checks_incomplete, private DNS = 422; neither is settled', async () => {
  const { fetchApp, facilitator } = await makeApp();
  for (const tier of ['lite', 'audit']) {
    const r = await v2pay(fetchApp)(`${BASE}/v1/${tier}?url=${q(DOWN)}`);
    assert.equal(r.status, 503); const j = await r.json();
    assert.equal(j.error, 'checks_incomplete'); assert.deepEqual(j.sources_failed, ['home']); assert.equal(j.charged, false);
    const p = await v2pay(fetchApp)(`${BASE}/v1/${tier}?url=${q(PRIVATE_DNS)}`);
    assert.equal(p.status, 422); assert.equal((await p.json()).error, 'ssrf_blocked');
  }
  assert.equal(facilitator.settled.length, 0, 'never settled');
  assert.ok(facilitator.verified.length >= 4, 'payments were verified, then not settled');
});

test('engine timeout = 503 checks_incomplete, not settled', async () => {
  const { fetchApp, facilitator } = await makeApp({ engine: { analyze: () => new Promise(() => {}), calls: [], web: { calls: [] } }, appOpts: {} });
  const realSet = globalThis.setTimeout; // shrink the 20 s budget for this test
  globalThis.setTimeout = (fn, ms, ...a) => realSet(fn, Math.min(ms, 30), ...a);
  try {
    const r = await v2pay(fetchApp)(`${BASE}/v1/lite?url=${q(GOOD)}`);
    assert.equal(r.status, 503); assert.equal((await r.json()).error, 'checks_incomplete');
  } finally { globalThis.setTimeout = realSet; }
  assert.equal(facilitator.settled.length, 0);
});

test('free preview: score, grade and categories only; report page, badge, rate limit', async () => {
  let n = 0; const limiter = { limit: async () => ({ success: ++n <= 3 }) };
  const { fetchApp } = await makeApp({ limiter });
  const r = await fetchApp(`${BASE}/v1/preview?url=${q(POOR)}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier, 'preview'); assert.equal(j.grade, 'F'); assert.equal(j.checks, undefined); assert.equal(j.fixes, undefined); assert.equal(typeof j.issues, 'number');
  assert.equal(j.full.prices.audit, '$0.03'); assert.equal(j.report, `${BASE}/r/poor-site.com`);
  const h = await fetchApp(`${BASE}/r/good-site.com`);
  assert.equal(h.status, 200); const html = await h.text();
  assert.match(html, /og:image" content="https:\/\/agentready\.example\.com\/og\/a\.png/); assert.match(html, /data-tier="audit"/); assert.match(html, /eth_signTypedData_v4/);
  const b = await fetchApp(`${BASE}/badge/good-site.com.svg`);
  assert.equal(b.headers.get('content-type'), 'image/svg+xml; charset=utf-8'); assert.match(await b.text(), /100 A/);
  assert.equal((await fetchApp(`${BASE}/r/localhost`)).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/preview?url=${q(GOOD)}`)).status, 429);
});

test('remote MCP: initialize, tools/list, tools/call (preview tier)', async () => {
  const { fetchApp } = await makeApp();
  const init = await (await mcp(fetchApp, { method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
  assert.equal(init.result.serverInfo.name, 'agentready');
  const list = await (await mcp(fetchApp, { method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['audit_website']);
  const call = await (await mcp(fetchApp, { method: 'tools/call', params: { name: 'audit_website', arguments: { url: 'good-site.com' } } })).json();
  assert.equal(call.result.isError, false); assert.match(call.result.content[0].text, /AgentReady good-site\.com: 100\/100 \(grade A/);
  const bad = await (await mcp(fetchApp, { method: 'tools/call', params: { name: 'audit_website', arguments: { url: 'http://10.0.0.1' } } })).json();
  assert.equal(bad.result.isError, true);
});

test('discovery: info JSON, landing HTML, openapi, /.well-known/x402, favicon, og, health', async () => {
  const { fetchApp } = await makeApp();
  const info = await (await fetchApp(`${BASE}/`, { headers: { accept: 'application/json' } })).json();
  assert.equal(info.name, 'AgentReady'); assert.deepEqual(info.paid.map((p) => [p.path, p.price]), [['/v1/lite', '$0.005'], ['/v1/audit', '$0.03']]);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Agent<span>Ready/); assert.match(html, /Agent trust kit/);
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.equal(oa.paths['/v1/audit'].get['x-payment-info'].price.amount, '0.03'); assert.equal(oa.servers[0].url, BASE);
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(wk.resources, [`${BASE}/v1/lite`, `${BASE}/v1/audit`]);
  assert.equal((await fetchApp(`${BASE}/favicon.ico`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetchApp(`${BASE}/og/generic.png`)).headers.get('content-type'), 'image/png');
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
});

test('stdio MCP package: validates locally, uses the hosted preview, no key = free mode', async () => {
  assert.deepEqual(STDIO_TOOLS.map((t) => t.name), ['audit_website']);
  assert.equal(toUrl({ url: 'stripe.com' }).url, 'https://stripe.com/'); assert.ok(toUrl({ url: 'ftp://x' }).error); assert.ok(toUrl({}).error);
  const seen = [];
  const fetchImpl = async (u) => { seen.push(String(u)); return Response.json({ host: 'stripe.com', score: 74, grade: 'C', verdict: 'partially_ready', confidence: 'high', categories: { access: { score: 30, max: 30 } }, counts: { fail: 6, warn: 3 } }); };
  const r = await stdioHandle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'audit_website', arguments: { url: 'stripe.com' } } }, { fetchImpl, env: {} });
  assert.match(r.result.content[0].text, /AgentReady stripe\.com: 74\/100 \(grade C/);
  assert.equal(seen[0], 'https://api.youraitools.co/agentready/v1/preview?url=https%3A%2F%2Fstripe.com%2F');
});
