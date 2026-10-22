import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, fakeNet, BASE, PAY_TO } from './helpers.js';
import { OPENAPI_PATHS } from '../src/discovery.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('unpaid: 402 on both paid routes (v2 header: 2000 / 1000 atomic USDC, Base, payTo, USD Coin v2, valid Bazaar; v1 body)', async () => {
  const { fetchApp, net } = await makeApp();
  for (const [path, q, amount] of [['/v1/domain', 'domain=good.example', '2000'], ['/v1/email', 'email=jane@good.example', '1000']]) {
    for (const [u, init] of [[`${BASE}${path}?${q}`], [`${BASE}${path}`], [`${BASE}${path}`, json(Object.fromEntries([q.split('=')]))], [`${BASE}${path}`, json({})]]) {
      const r = await fetchApp(u, init);
      assert.equal(r.status, 402, `${init?.method || 'GET'} ${u}`);
      const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
      assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo], [2, 'exact', 'eip155:8453', amount, PAY_TO]);
      assert.deepEqual(a.extra, { name: 'USD Coin', version: '2' });
      assert.equal(req.resource.url, `${BASE}${path}`);
      assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
      const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount); assert.equal(b.accepts[0].network, 'base');
    }
  }
  assert.equal(net.seen.length, 0, 'a 402 never touches the network');
});

test('402 is instant even when DNS hangs', async () => {
  const { fetchApp } = await makeApp({ net: fakeNet({ hang: true }) });
  const t = Date.now(); const r = await fetchApp(`${BASE}/v1/domain?domain=good.example`);
  assert.equal(r.status, 402); assert.ok(Date.now() - t < 500);
});

test('malformed input: 400 / 422 before payment, never charged', async () => {
  const { fetchApp, facilitator, net } = await makeApp();
  for (const [u, init, st] of [[`${BASE}/v1/domain?domain=not_a_domain`, undefined, 400], [`${BASE}/v1/domain?domain=co.uk`, undefined, 400], [`${BASE}/v1/domain?domain=`, undefined, 400],
    [`${BASE}/v1/domain`, json({ domain: 5 }), 400], [`${BASE}/v1/domain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }, 400],
    [`${BASE}/v1/email?email=a..b@x.com`, undefined, 422], [`${BASE}/v1/email`, json({ email: 'nope' }), 422]]) {
    const r = await fetchApp(u, init); assert.equal(r.status, st, `${u} ${init?.body || ''}`);
  }
  assert.equal(facilitator.settled.length, 0); assert.equal(net.seen.length, 0);
});

test('paid v2 domain report: good domain is low_risk with RDAP, DKIM, MTA-STS, grade A; settled once', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/domain?domain=https://WWW.Good.Example/path?x=1`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.domain, 'www.good.example'); assert.equal(j.registrable_domain, 'good.example');
  assert.equal(j.verdict, 'low_risk'); assert.ok(j.score >= 70, String(j.score));
  assert.equal(j.registration.registrar, 'MarkMonitor Inc.'); assert.equal(j.registration.age_days, 4000);
  assert.equal(j.email.dmarc.inherited_from, 'good.example'); // _dmarc.www.good.example missing -> org domain
  assert.equal(facilitator.settled.length, 1); assert.ok(r.headers.get('PAYMENT-RESPONSE'));
  const g = await (await v2pay(fetchApp)(`${BASE}/v1/domain`, json({ domain: 'good.example' }))).json();
  assert.equal(g.score, 100); assert.equal(g.email.grade, 'A'); assert.equal(g.dns.dnssec_validated, true);
  assert.deepEqual(g.email.dkim.selectors_found.map((d) => d.selector), ['google']);
  assert.equal(g.email.mx_provider, 'Google Workspace / Gmail'); assert.equal(g.email.mta_sts.present, true);
});

test('paid domain: 3-day-old domain with +all SPF is high_risk; parked + client hold; nonexistent', async () => {
  const { fetchApp } = await makeApp();
  const pay = v2pay(fetchApp);
  const f = await (await pay(`${BASE}/v1/domain?domain=fresh.example`)).json();
  const ids = f.flags.map((x) => x.id);
  assert.ok(ids.includes('newly_registered_7d') && ids.includes('spf_pass_all') && ids.includes('no_dmarc'), ids.join());
  assert.equal(f.verdict, 'high_risk');
  const p = await (await pay(`${BASE}/v1/domain?domain=parked.example`)).json();
  const pid = p.flags.map((x) => x.id);
  assert.ok(pid.includes('parked_domain') && pid.includes('registry_hold') && pid.includes('expiring_15d') && pid.includes('no_mail_server') === false, pid.join());
  const n = await (await pay(`${BASE}/v1/domain?domain=does-not-exist.example`)).json();
  assert.equal(n.exists, false); assert.equal(n.verdict, 'nonexistent'); assert.equal(n.score, 0);
});

test('paid v1 email check with the x402-fetch 1.2 client (X-PAYMENT)', async () => {
  const calls = [];
  const v1FetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(url.split('/').pop()); return Response.json(url.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0x' + '1'.repeat(64), network: 'base', payer: b.paymentPayload.payload.authorization.from }); };
  const { fetchApp } = await makeApp({ v1FetchImpl });
  const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http('http://127.0.0.1:9') });
  const r = await wrapFetchWithPayment(fetchApp, wallet)(`${BASE}/v1/email?email=${encodeURIComponent('Jane.Doe+news@good.example')}`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.verdict, 'valid'); assert.equal(j.plus_tag, 'news'); assert.equal(j.deliverability.mx_provider, 'Google Workspace / Gmail');
  assert.equal(decodeXPaymentResponse(r.headers.get('X-PAYMENT-RESPONSE')).success, true); assert.deepEqual(calls, ['verify', 'settle']);
});

test('paid email verdicts: disposable -> risky, null MX -> undeliverable, no domain -> undeliverable, gmail skips RDAP', async () => {
  const { fetchApp, net } = await makeApp();
  const pay = v2pay(fetchApp);
  const d = await (await pay(`${BASE}/v1/email?email=x@mailinator.com`)).json();
  assert.equal(d.verdict, 'risky'); assert.equal(d.disposable, true);
  const n = await (await pay(`${BASE}/v1/email?email=bob@nomail.example`)).json();
  assert.equal(n.verdict, 'undeliverable'); assert.equal(n.deliverability.null_mx, true);
  const x = await (await pay(`${BASE}/v1/email?email=bob@nothere.example`)).json();
  assert.equal(x.verdict, 'undeliverable'); assert.equal(x.deliverability.domain_exists, false);
  const before = net.seen.filter((u) => u.includes('rdap.test')).length;
  const g = await (await pay(`${BASE}/v1/email?email=info@gmail.com`)).json();
  assert.equal(g.free_provider, true); assert.equal(g.role, true); assert.equal(g.registration, null);
  assert.equal(net.seen.filter((u) => u.includes('rdap.test')).length, before);
});

test('RDAP outage: report still 200 with rdap_unavailable flag', async () => {
  const { fetchApp } = await makeApp({ net: fakeNet({ rdapDown: true }) });
  const j = await (await v2pay(fetchApp)(`${BASE}/v1/domain?domain=good.example`)).json();
  assert.ok(j.flags.some((f) => f.id === 'rdap_unavailable')); assert.equal(j.verdict, 'low_risk');
});

test('timeouts are 504 and never charged', async () => {
  const { fetchApp, facilitator } = await makeApp({ net: fakeNet({ hang: true }), workMs: 100 });
  const r = await v2pay(fetchApp)(`${BASE}/v1/domain?domain=good.example`);
  assert.equal(r.status, 504); assert.equal(facilitator.settled.length, 0);
});

test('free previews: domain has no RDAP/score; email has no DNS; rate limit 429', async () => {
  const { fetchApp, net } = await makeApp();
  const d = await (await fetchApp(`${BASE}/v1/domain/preview?domain=fresh.example`)).json();
  assert.equal(d.tier, 'preview'); assert.equal(d.registration, undefined); assert.equal(d.score, undefined); assert.ok(d.full.url.endsWith('/v1/domain'));
  assert.ok(!net.seen.some((u) => u.includes('rdap')));
  const n0 = net.seen.length;
  const e = await (await fetchApp(`${BASE}/v1/email/preview`, json({ email: 'x@mailinator.com' }))).json();
  assert.equal(e.disposable, true); assert.equal(net.seen.length, n0, 'email preview makes no network calls');
  const { fetchApp: f2 } = await makeApp({ limiter: { limit: async () => ({ success: false }) } });
  assert.equal((await f2(`${BASE}/v1/domain/preview?domain=good.example`)).status, 429);
});

test('remote MCP: initialize, tools/list, check_domain + check_email (preview tier)', async () => {
  const { fetchApp } = await makeApp();
  const rpc = async (body) => (await fetchApp(`${BASE}/mcp`, json(body))).json();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'domaincheck');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['check_domain', 'check_email']);
  const d = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_domain', arguments: { domain: 'nomail.example' } } });
  assert.match(d.result.content[0].text, /no mail/); assert.equal(d.result.isError, false);
  const e = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_email', arguments: { email: 'a@mailinator.com' } } });
  assert.match(e.result.content[0].text, /disposable YES/);
  const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_domain', arguments: { domain: '???' } } });
  assert.equal(bad.result.isError, true);
});

test('discovery: openapi lists only paid + preview routes with live prices; .well-known/x402; favicon; root JSON + HTML; flags; stats', async () => {
  const { fetchApp } = await makeApp();
  const o = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.deepEqual(Object.keys(o.paths).sort(), [...OPENAPI_PATHS].sort());
  assert.equal(o.paths['/v1/domain'].get['x-payment-info'].price.amount, '0.002');
  assert.equal(o.paths['/v1/email'].get['x-x402'].amount, '1000');
  assert.equal(o.servers[0].url, BASE);
  const w = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(w.resources, [`${BASE}/v1/domain`, `${BASE}/v1/email`]);
  assert.match((await fetchApp(`${BASE}/favicon.ico`)).headers.get('content-type'), /svg/);
  const root = await (await fetchApp(`${BASE}/`)).json(); assert.equal(root.name, 'DomainCheck'); assert.equal(root.paid.length, 2);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Agent trust kit/); assert.match(html, /InjectScan/); assert.match(html, /DomainCheck/); assert.doesNotMatch(html, /github\.com/);
  const fl = await (await fetchApp(`${BASE}/v1/flags`)).json(); assert.ok(fl.flags.newly_registered_7d.penalty > 0);
  await fetchApp(`${BASE}/v1/domain?domain=good.example`);
  await new Promise((r) => setTimeout(r, 20)); // let the batched KV flush land
  const st = await (await fetchApp(`${BASE}/v1/stats`)).json(); assert.ok(st.totals.challenge_402 >= 1); assert.ok(st.totals['challenge_402:domain'] >= 1);
});

test('DNS outage: 503 dns_unavailable, never charged (no fake "risky" report)', async () => {
  const n = fakeNet();
  const broken = { seen: n.seen, fetchImpl: async (url, init) => (/dns-query|resolve/.test(url) ? new Response('err', { status: 500 }) : n.fetchImpl(url, init)) };
  const { fetchApp, facilitator } = await makeApp({ net: broken });
  const pay = v2pay(fetchApp);
  assert.equal((await pay(`${BASE}/v1/domain?domain=good.example`)).status, 503);
  assert.equal((await pay(`${BASE}/v1/email?email=a@good.example`)).status, 503);
  assert.equal(facilitator.settled.length, 0);
});
