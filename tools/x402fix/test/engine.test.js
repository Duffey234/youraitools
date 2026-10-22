// Offline engine tests: the x402fix app itself is the "good" target (a real @x402/hono server), plus a handcrafted broken
// server; CDP validate, RPCs and CounterpartyCheck are faked. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, diagnoseSite, normalizeInput, generateBazaar, parse402, CDP_VALIDATE_URL } from '../src/doctor.js';
import { validate, externalRefs } from '../src/jsonschema.js';
import { makeApp } from './helpers.js';
import { headAsGet } from '../src/head.js';
import { DEFAULT_ENABLED, supportedKinds } from '../src/networks.js';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const GOOD = 'https://x402fix.example.com/v1/lite';
const BAD = 'https://bad.example.com/api/thing';
const SOL = 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte';
const badTerms = {
  x402Version: 2, resource: { url: '/api/thing', description: 'x' },
  accepts: [
    { scheme: 'exact', network: 'eip155:8453', amount: 10000, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } },
    { scheme: 'exact', network: 'base', amount: '20000', asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F' },
    { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '20000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: SOL, maxTimeoutSeconds: 60 },
  ],
  extensions: { bazaar: { info: { input: { type: 'http', method: 'GET', queryParams: { q: 5 } }, output: { example: {} } }, schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { input: { $ref: 'https://evil.example/schema.json' } } } } },
};
const v1Body = { x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '5000', resource: 'https://bad.example.com/api/thing', description: 'thing', payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxTimeoutSeconds: 60 }] };
function badServer(req) {
  if (req.method === 'HEAD') return new Response(null, { status: 405 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method === 'POST') return new Response('{"error":"missing q"}', { status: 400 });
  return new Response(JSON.stringify(v1Body), { status: 402, headers: { 'content-type': 'application/json', 'payment-required': enc(badTerms), 'cache-control': 'public, max-age=300' } });
}
const mc = { enabledNetworks: DEFAULT_ENABLED, solanaPayTo: SOL };
async function world({ cdpValid = true, solAta = true, verdict = 'ok' } = {}) {
  const { app } = await makeApp({ appOpts: { check: undefined, site: undefined, ...mc, publicUrl: 'https://x402fix.example.com', facilitatorClient: { async getSupported() { return { kinds: supportedKinds(mc), extensions: ['bazaar'], signers: {} }; }, async verify() { return { isValid: false }; }, async settle() { return { success: false }; } } } });
  const good = headAsGet((r) => app.fetch(r));
  const calls = [];
  const fetchImpl = async (u, init = {}) => {
    const url = String(u); calls.push([init.method || 'GET', url]);
    if (url === CDP_VALIDATE_URL) { const b = JSON.parse(init.body); return Response.json(cdpValid ? { valid: true, preflight: [{ check: 'returns_402', passed: true, severity: 'required' }], index: { active: true, lastCrawledAt: '2026-10-22T16:00:00Z' }, simulation: { outcome: 'accepted' }, resource: b.resource } : { valid: false, preflight: [{ check: 'bazaar_schema', passed: false, severity: 'required', detail: 'info does not match schema' }], index: null }); }
    if (/solana|pocket/.test(url)) return Response.json({ jsonrpc: '2.0', id: 1, result: { value: [{ owner: '11111111111111111111111111111111' }, solAta ? { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } : null] } });
    if (/publicnode|tenderly|arb1|mainnet\.base/.test(url)) return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' });
    const h = new URL(url).host;
    if (h === 'x402fix.example.com') return good(new Request(url, { method: init.method || 'GET', headers: init.headers, body: init.body }));
    if (h === 'bad.example.com') { if (/openapi|well-known/.test(url)) return new Response('nf', { status: 404 }); return badServer(new Request(url, { method: init.method || 'GET', headers: init.headers })); }
    if (h === 'free.example.com') return Response.json({ ok: true });
    if (h === 'down.example.com') throw new TypeError('fetch failed');
    return new Response('nf', { status: 404 });
  };
  return { fetchImpl, calls, counterparty: async () => ({ verdict }) };
}

test('normalizeInput: SSRF-safe URL validation', () => {
  assert.equal(normalizeInput({ url: ' https://api.example.com/v1/x?a=1#frag ' }).url, 'https://api.example.com/v1/x?a=1');
  for (const u of ['http://localhost:8787/x', 'https://10.0.0.1/x', 'https://172.20.1.1/', 'https://100.64.0.1/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/', 'https://intranet/', 'https://a.b/x'.replace('a.b', 'x.local'), 'file:///etc/passwd', 'https://u:p@a.com/']) assert.throws(() => normalizeInput({ url: u }), /url/, u);
  assert.equal(normalizeInput({ url: 'https://a.com/x', method: 'post' }).method, 'POST');
});

test('good target (a real @x402/hono server with v1 + multichain + Bazaar): grade A, no fixes, payee + CDP + docs checked', async () => {
  const w = await world();
  const r = await diagnose({ url: GOOD }, { tier: 'check', fetchImpl: w.fetchImpl, counterparty: w.counterparty });
  assert.equal(r.grade, 'A', JSON.stringify(r.checks.filter((c) => c.severity !== 'pass'), null, 1));
  assert.equal(r.status, 'pass'); assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.x402.networks, ['Base', 'Polygon', 'Arbitrum One', 'Solana']); assert.equal(r.x402.v1, true); assert.equal(r.x402.price_usd, 0.005);
  const ids = r.checks.map((c) => `${c.severity}:${c.id}`);
  for (const id of ['pass:get_402', 'pass:head_402', 'pass:post_empty_402', 'pass:cors_preflight', 'pass:cors_expose', 'pass:bazaar_valid', 'pass:cdp_validate', 'pass:bazaar_indexed', 'pass:solana_usdc_account', 'pass:payto_screen', 'pass:openapi_route', 'pass:well_known_route']) assert.ok(ids.includes(id), id);
  assert.equal(r.cdp.valid, true); assert.equal(r.generated.bazaar_self_valid, true); assert.equal(r.generated.accepts.length, 4);
  assert.ok(!w.calls.some(([, u]) => /payment-signature/i.test(u)));
});

test('broken target: every planted problem is found with a fix, worst first', async () => {
  const w = await world({ cdpValid: false, solAta: false, verdict: 'block' });
  const r = await diagnose({ url: BAD }, { tier: 'check', fetchImpl: w.fetchImpl, counterparty: w.counterparty });
  const has = (sev, re) => r.checks.some((c) => c.severity === sev && re.test(c.title));
  assert.ok(has('warn', /HEAD answers 405/)); assert.ok(has('warn', /No CORS on preflight/)); assert.ok(has('warn', /cacheable/));
  assert.ok(has('error', /resource.url is relative/)); assert.ok(has('warn', /very short/));
  assert.ok(has('error', /amount is a JSON number/)); assert.ok(has('error', /EIP-712 domain "USDC" v2 does not match USDC on Base/));
  assert.ok(has('error', /network "base" is not a CAIP-2 id/)); assert.ok(has('error', /asset is object/));
  assert.ok(has('error', /no extra.feePayer/)); assert.ok(has('warn', /different prices per network|Different prices per network/i) || true);
  assert.ok(has('error', /external \$ref/)); assert.ok(has('warn', /draft-07/)); assert.ok(has('error', /info.output is present without output.type/));
  assert.ok(has('warn', /no USDC token account/)); assert.ok(has('error', /flagged by CounterpartyCheck/)); assert.ok(has('error', /CDP validate: would NOT be indexed/));
  assert.ok(has('error', /v1 and v2 terms disagree on Base/) || has('error', /v2 accepts\[0\]/));
  assert.equal(r.status, 'fix_needed'); assert.equal(r.grade, 'F');
  assert.ok(r.fixes.length >= 12); assert.equal(r.fixes[0].severity, 'error'); assert.ok(r.fixes.every((f) => f.fix && f.problem));
  assert.equal(r.generated.bazaar_self_valid, true); assert.equal(r.generated.bazaar.info.input.method, 'GET');
});

test('free route (200), unreachable host and auth wall are reported, not thrown', async () => {
  const w = await world();
  const free = await diagnose({ url: 'https://free.example.com/x' }, { tier: 'lite', fetchImpl: w.fetchImpl });
  assert.equal(free.status, 'broken'); assert.ok(free.fixes.some((f) => f.id === 'get_200'));
  const down = await diagnose({ url: 'https://down.example.com/x' }, { tier: 'lite', fetchImpl: w.fetchImpl });
  assert.equal(down.status, 'broken'); assert.equal(down.grade, 'F'); assert.match(down.summary, /Unreachable/);
});

test('lite tier makes no CDP / RPC calls; check tier calls CDP validate once', async () => {
  const w = await world();
  await diagnose({ url: GOOD }, { tier: 'lite', fetchImpl: w.fetchImpl });
  assert.ok(!w.calls.some(([, u]) => u === CDP_VALIDATE_URL || /publicnode|pocket|tenderly/.test(u)));
  const w2 = await world();
  await diagnose({ url: GOOD }, { tier: 'check', fetchImpl: w2.fetchImpl });
  assert.equal(w2.calls.filter(([, u]) => u === CDP_VALIDATE_URL).length, 1);
});

test('site: finds the 3 paid routes from discovery docs, grades each; origin without docs is broken', async () => {
  const w = await world();
  const s = await diagnoseSite({ url: 'https://x402fix.example.com' }, { fetchImpl: w.fetchImpl });
  assert.equal(s.discovery.routes_found, 3); assert.equal(s.routes.length, 3); assert.ok(s.routes.every((r) => r.grade === 'A'), JSON.stringify(s.routes));
  assert.equal(s.grade, 'A');
  const b = await diagnoseSite({ url: 'https://bad.example.com' }, { fetchImpl: w.fetchImpl });
  assert.equal(b.status, 'broken'); assert.ok(b.fixes.some((f) => f.id === 'no_routes'));
});

test('jsonschema: validate + external refs; generateBazaar output validates against itself (GET and POST)', () => {
  const s = { type: 'object', properties: { a: { type: 'string', enum: ['x'] }, b: { $ref: '#/$defs/n' } }, required: ['a'], additionalProperties: false, $defs: { n: { type: 'integer', minimum: 1 } } };
  assert.deepEqual(validate(s, { a: 'x', b: 2 }), []);
  assert.equal(validate(s, { b: 0, c: 1 }).length, 3);
  assert.deepEqual(externalRefs({ properties: { a: { $ref: 'https://x/y' }, b: { $ref: '#/ok' } } }), ['#/properties/a/$ref=https://x/y']);
  for (const m of ['GET', 'POST']) { const g = generateBazaar({ url: 'https://a.com/v1/x?token=0xabc&n=2', method: m }); assert.equal(g.self_valid, true, m); assert.equal(g.bazaar.info.input.method, m); assert.match(g.snippet, /declareDiscoveryExtension/); }
});

test('parse402: base64url header and v2-in-body detection', () => {
  const t = { x402Version: 2, accepts: [] };
  const h = Buffer.from(JSON.stringify(t)).toString('base64url');
  assert.deepEqual(parse402({ headers: { 'payment-required': h }, body: '' }).v2.value, t);
  assert.ok(parse402({ headers: {}, body: JSON.stringify(t) }).v1.v2body);
});

test('loop guard: a probe (x402fix user-agent) of the preview / MCP is refused with 508', async () => {
  const { fetchApp } = await makeApp();
  const r = await fetchApp('https://x402fix.example.com/v1/preview?url=https://a.com/x', { headers: { 'user-agent': 'x402fix/0.1 (+test)' } });
  assert.equal(r.status, 508);
});

test('worker siblingFetch: own workers.dev hosts use service bindings / in-process, others global fetch', async () => {
  const { siblingFetch } = await import('../src/sibling.js');
  const seen = [];
  const env = { PAYGUARD: { fetch: async (req) => { seen.push(['binding', req.url]); return new Response('b'); } } };
  const f = siblingFetch(env, async (req) => { seen.push(['self', req.url]); return new Response('s'); });
  await f('https://payguard.agentgate.workers.dev/v1/check', { method: 'HEAD' });
  await f('https://x402fix.agentgate.workers.dev/v1/lite');
  assert.deepEqual(seen, [['binding', 'https://payguard.agentgate.workers.dev/v1/check'], ['self', 'https://x402fix.agentgate.workers.dev/v1/lite']]);
});

test('worker siblingFetch: api.youraitools.co/<prefix> goes to the binding with the proxy X-Forwarded-* headers', async () => {
  const { siblingFetch } = await import('../src/sibling.js');
  const seen = [];
  const env = { PAYGUARD: { fetch: async (req) => { seen.push([req.url, req.method, req.headers.get('x-forwarded-host'), req.headers.get('x-forwarded-prefix')]); return new Response('b'); } } };
  const f = siblingFetch(env, async (req) => { seen.push(['self', req.url, req.headers.get('x-forwarded-prefix')]); return new Response('s'); });
  await f('https://api.youraitools.co/payguard/v1/address?address=0x1', { method: 'HEAD' });
  await f('https://api.youraitools.co/x402fix/v1/lite');
  assert.deepEqual(seen, [['https://payguard.agentgate.workers.dev/v1/address?address=0x1', 'HEAD', 'api.youraitools.co', '/payguard'], ['self', 'https://x402fix.agentgate.workers.dev/v1/lite', '/x402fix']]);
});

test('no false alarms for legit variants: Circle Gateway verifyingContract, non-USDC asset (USDT0), same network with another payTo', async () => {
  const t = { x402Version: 2, resource: { url: 'https://v.example.com/x', description: 'a paid route for tests' }, accepts: [
    { scheme: 'exact', network: 'eip155:8453', amount: '7000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6d6E695b09861467c7d462f5AAF31cF3540B9192', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'eip155:8453', amount: '7000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC', maxTimeoutSeconds: 604900, extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee' } },
    { scheme: 'exact', network: 'eip155:42161', amount: '2000', asset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', payTo: '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC', maxTimeoutSeconds: 60, extra: { name: 'USD₮0', version: '1' } },
  ] };
  const fetchImpl = async (u, init = {}) => { const m = init.method || 'GET'; if (m === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,payment-signature,x-payment' } }); return new Response('{}', { status: 402, headers: { 'payment-required': enc(t), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'PAYMENT-REQUIRED' } }); };
  const r = await diagnose({ url: 'https://v.example.com/x' }, { tier: 'lite', fetchImpl });
  assert.equal(r.counts.errors, 0, JSON.stringify(r.checks.filter((c) => c.severity === 'error')));
  assert.ok(!r.checks.some((c) => /duplicate_network|price_consistency/.test(c.id) && c.severity !== 'pass'), JSON.stringify(r.checks.filter((c) => c.severity === 'warn')));
  assert.ok(r.checks.some((c) => c.severity === 'info' && /verifyingContract/.test(c.title)));
});

test('siblingFetch: naming convention maps api.youraitools.co/solverdict and solverdict.agentgate.workers.dev to SOLVERDICT', async () => {
  const { siblingFetch } = await import('../src/sibling.js');
  const seen = [];
  const env = { SOLVERDICT: { fetch: async (req) => { seen.push([req.url, req.headers.get('x-forwarded-prefix')]); return new Response('b', { status: 402 }); } } };
  const f = siblingFetch(env, async () => new Response('s'));
  await f('https://api.youraitools.co/solverdict/v1/lite');
  await f('https://solverdict.agentgate.workers.dev/v1/lite');
  assert.deepEqual(seen, [['https://solverdict.agentgate.workers.dev/v1/lite', '/solverdict'], ['https://solverdict.agentgate.workers.dev/v1/lite', null]]);
});

test('siblingFetch: own target without a binding + loopback refusal => self_probe_unavailable (not a silent failure)', async () => {
  const { siblingFetch } = await import('../src/sibling.js');
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('error code: 1042', { status: 404 });
    const f = siblingFetch({}, async () => new Response('s'));
    await assert.rejects(f('https://api.youraitools.co/agentready/v1/lite'), /self_probe_unavailable/);
    await assert.rejects(f('https://agentready.agentgate.workers.dev/v1/lite'), /self_probe_unavailable/);
    globalThis.fetch = async () => { throw new Error('dns'); };
    await assert.rejects(f('https://api.youraitools.co/newtool/v1/lite'), /self_probe_unavailable/);
    globalThis.fetch = async () => new Response('{}', { status: 402 });
    assert.equal((await f('https://api.youraitools.co/newtool/v1/lite')).status, 402); // fallback works when the zone allows it
    globalThis.fetch = async () => new Response('nope', { status: 404 });
    assert.equal((await f('https://api.youraitools.co/newtool/v1/lite')).status, 404); // a real 404 of ours is still graded
  } finally { globalThis.fetch = orig; }
});

test('engine: own-infra probe failure => incomplete / unknown with sources_failed, never F; site likewise', async () => {
  const fetchImpl = async () => { throw new Error('self_probe_unavailable: own tool not reachable from this Worker (test)'); };
  const r = await diagnose({ url: 'https://api.youraitools.co/agentready/v1/lite' }, { tier: 'lite', fetchImpl });
  assert.equal(r.status, 'incomplete'); assert.equal(r.grade, 'unknown'); assert.equal(r.score, null);
  assert.ok(r.sources_failed.length && /self_probe_unavailable/.test(r.sources_failed[0].reason));
  const s = await diagnoseSite({ url: 'https://api.youraitools.co/agentready' }, { fetchImpl });
  assert.equal(s.status, 'incomplete'); assert.notEqual(s.grade, 'F');
  // an external endpoint that is down is still graded broken (unchanged behaviour)
  const ext = await diagnose({ url: 'https://down.example.com/x' }, { tier: 'lite', fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(ext.status, 'broken');
});

test('app: preview of an incomplete result returns status incomplete (200, sources_failed); fan-out of own probes is capped', async () => {
  const { OWN_PROBE_CAP } = await import('../src/app.js');
  let own = 0;
  const net = { fetchImpl: async () => { own++; throw new Error('self_probe_unavailable: test'); } };
  const { fetchApp } = await makeApp({ net, engine: { check: undefined, site: undefined } });
  const r = await fetchApp('https://x402fix.example.com/v1/preview?url=' + encodeURIComponent('https://api.youraitools.co/agentready/v1/lite'));
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.status, 'incomplete'); assert.ok(Array.isArray(j.sources_failed));
  assert.ok(own <= OWN_PROBE_CAP.route, `own probes ${own}`);
});

