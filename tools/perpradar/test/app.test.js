import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, mockVenues } from './helpers.js';
import { headAsGet } from '../src/head.js';
import { handle as stdioHandle, TOOLS as STDIO_TOOLS } from '../src/mcp-stdio.js';
import { toSymbol } from '../src/lite.js';
import { _clearCache } from '../src/engine.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ROUTES = [['lite', '5000', 'symbol=BTC'], ['full', '30000', 'symbol=ETH'], ['scan', '20000', 'universe=all']];
const NFA = /Not financial advice\. Past performance does not guarantee future results\./;
const mcp = (fetchApp, body) => fetchApp(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });
test.beforeEach(() => _clearCache());

test('unpaid: every paid route answers 402 on GET, POST, empty POST and bare probes (v2 header + valid Bazaar, v1 body); no upstream call', async () => {
  const { fetchApp, net } = await makeApp();
  for (const [tier, amount, qs] of ROUTES) {
    for (const [u, init] of [[`${BASE}/v1/${tier}?${qs}`], [`${BASE}/v1/${tier}`], [`${BASE}/v1/${tier}`, json(Object.fromEntries(new URLSearchParams(qs)))], [`${BASE}/v1/${tier}`, { method: 'POST' }], [`${BASE}/v1/${tier}`, json({})]]) {
      const r = await fetchApp(u, init);
      assert.equal(r.status, 402, `${init?.method || 'GET'} ${u}`);
      const req = decode(r.headers.get('PAYMENT-REQUIRED')); const a = req.accepts[0];
      assert.deepEqual([req.x402Version, a.scheme, a.network, a.amount, a.payTo, a.asset], [2, 'exact', 'eip155:8453', amount, PAY_TO, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
      assert.equal(req.resource.url, `${BASE}/v1/${tier}`);
      assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
      assert.ok(r.headers.get('PAYMENT-REQUIRED').length < 12000, 'header size');
      const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount); assert.equal(b.accepts[0].network, 'base');
    }
  }
  assert.equal(net.calls.length, 0);
});

test('HEAD = 402 + PAYMENT-REQUIRED with no body and never settles', async () => {
  const { app, facilitator } = await makeApp();
  const h = headAsGet((req) => app.fetch(req));
  for (const [tier, amount, qs] of ROUTES) {
    const r = await h(new Request(`${BASE}/v1/${tier}?${qs}`, { method: 'HEAD', headers: { 'payment-signature': 'junk', 'x-payment': 'junk' } }));
    assert.equal(r.status, 402); assert.equal(decode(r.headers.get('payment-required')).accepts[0].amount, amount); assert.equal(await r.text(), '');
  }
  assert.equal(facilitator.verified.length, 0);
});

test('bad input: 400 before payment (never a 402, never charged, nothing fetched)', async () => {
  const { fetchApp, facilitator, net } = await makeApp();
  for (const tier of ['lite', 'full', 'preview']) for (const s of ['B T C', '<script>', 'A'.repeat(20), '$$']) {
    const r = await fetchApp(`${BASE}/v1/${tier}?symbol=${encodeURIComponent(s)}`); assert.equal(r.status, 400, `${tier} ${s}`);
  }
  for (const qs of ['universe=some', 'symbols=,', 'limit=5', 'universe=all&limit=99', 'universe=all&min_oi_usd=-1', `symbols=${Array.from({ length: 26 }, (_, i) => `A${i}`).join(',')}`]) {
    const r = await fetchApp(`${BASE}/v1/scan?${qs}`); assert.ok([400].includes(r.status), `scan ${qs}: ${r.status}`);
  }
  assert.equal((await fetchApp(`${BASE}/v1/full`, json({ symbol: 5 }))).status, 400);
  assert.equal((await fetchApp(`${BASE}/v1/full`, json({ foo: 1 }))).status, 400);
  assert.equal(facilitator.verified.length, 0); assert.equal(net.calls.length, 0);
});

test('paid v2 lite: per-venue funding normalized (8h, APR), cross-venue read, settled once, disclaimer', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/lite?symbol=btc-perp`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier, 'lite'); assert.equal(j.symbol, 'BTC'); assert.equal(j.venues_ok, 4); assert.equal(j.confidence, 'high');
  const hl = j.venues.find((v) => v.venue === 'hyperliquid'); assert.equal(hl.funding_8h_pct, 0.01); assert.equal(hl.funding_apr_pct, 10.95);
  const px = j.venues.find((v) => v.venue === 'paradex'); assert.equal(px.funding_interval_hours, 8); assert.equal(px.funding_8h_pct, 0.01);
  assert.equal(j.venues[0].premium_pct, undefined, 'premium is full-tier');
  assert.equal(j.positioning, 'neutral'); assert.match(j.disclaimer, NFA);
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '5000');
  assert.ok(r.headers.get('payment-response'));
});

test('paid v2 full (POST body) and scan: history, regime, carry; universe extremes and spreads', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/full`, json({ symbol: 'BTC' }));
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.tier, 'full'); assert.equal(j.history.hyperliquid_7d.samples, 168); assert.ok(j.history.dydx_100h); assert.equal(j.regime.based_on, 'hyperliquid_7d');
  assert.ok(j.history.hyperliquid_7d.zscore_latest > 2); assert.match(j.regime.vs_recent, /unusually high/);
  assert.equal(j.carry.length, 4); assert.ok(j.venues[0].premium_pct !== undefined); assert.match(j.disclaimer, NFA);
  const s = await v2pay(fetchApp)(`${BASE}/v1/scan?universe=all&limit=3`);
  assert.equal(s.status, 200); const sj = await s.json();
  assert.equal(sj.mode, 'universe'); assert.ok(sj.highest_funding.length <= 3);
  assert.ok(!sj.highest_funding.some((x) => x.symbol === 'MATIC' || x.symbol === 'OLD'), 'delisted / settled markets excluded');
  assert.equal(sj.widest_spreads[0].symbol, 'ETH');
  const w = await v2pay(fetchApp)(`${BASE}/v1/scan?symbols=BTC,SOL,NOPE`);
  const wj = await w.json(); assert.deepEqual(wj.not_listed, ['NOPE']); assert.equal(wj.watchlist.length, 2);
  assert.deepEqual(facilitator.settled.map((x) => x.amount), ['30000', '20000', '20000']);
});

test('FAIL-CLOSED: all venues down = 503 upstream_unavailable (not settled); partial outage = sources_failed + lower confidence, never estimated', async () => {
  const down = await makeApp({ net: mockVenues({ fail: new Set(['hyperliquid', 'dydx', 'paradex', 'aevo']) }) });
  for (const [tier, , qs] of ROUTES) {
    const r = await v2pay(down.fetchApp)(`${BASE}/v1/${tier}?${qs}`);
    assert.equal(r.status, 503, tier); const j = await r.json();
    assert.equal(j.error, 'upstream_unavailable'); assert.equal(j.charged, false); assert.ok(j.sources_failed.length >= 3);
  }
  assert.equal(down.facilitator.settled.length, 0, 'never settled');
  _clearCache();
  const part = await makeApp({ net: mockVenues({ fail: new Set(['hyperliquid', 'paradex', 'aevo']) }) });
  const r = await v2pay(part.fetchApp)(`${BASE}/v1/lite?symbol=BTC`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.deepEqual(j.sources_failed, ['aevo', 'hyperliquid', 'paradex']); assert.equal(j.venues_ok, 1); assert.equal(j.confidence, 'low');
  assert.equal(j.positioning, 'unknown'); assert.equal(j.funding.median_apr_pct, null); assert.equal(j.funding.cross_venue_spread_apr_pct, null);
  assert.deepEqual(j.venues.map((v) => v.venue), ['dydx']);
});

test('unknown symbol = 404 symbol_not_found (not settled); upstream timeout = 503 (not settled)', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/lite?symbol=ZZZQ`);
  assert.equal(r.status, 404); assert.equal((await r.json()).error, 'symbol_not_found');
  _clearCache();
  const realSet = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => realSet(fn, Math.min(ms, 30), ...a);
  try {
    const slow = await makeApp({ net: mockVenues({ fail: new Set(['hyperliquid:timeout', 'dydx:timeout', 'paradex:timeout', 'aevo:timeout']) }) });
    const t = await v2pay(slow.fetchApp)(`${BASE}/v1/full?symbol=BTC`);
    assert.equal(t.status, 503); assert.equal(slow.facilitator.settled.length, 0);
  } finally { globalThis.setTimeout = realSet; }
  assert.equal(facilitator.settled.length, 0);
});

test('free preview: positioning only (no rates), rate limit', async () => {
  let n = 0; const limiter = { limit: async () => ({ success: ++n <= 2 }) };
  const { fetchApp } = await makeApp({ limiter });
  const r = await fetchApp(`${BASE}/v1/preview?symbol=ETH`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.symbol, 'ETH'); assert.ok(j.positioning); assert.equal(j.funding, undefined); assert.equal(j.venues, undefined);
  assert.equal(j.full.prices.full, '$0.03'); assert.match(j.disclaimer, NFA);
  assert.equal((await fetchApp(`${BASE}/v1/preview?symbol=BTC`)).status, 200);
  assert.equal((await fetchApp(`${BASE}/v1/preview?symbol=BTC`)).status, 429);
});

test('remote MCP: initialize, tools/list, tools/call (preview tier)', async () => {
  const { fetchApp } = await makeApp();
  const init = await (await mcp(fetchApp, { method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
  assert.equal(init.result.serverInfo.name, 'perpradar');
  const list = await (await mcp(fetchApp, { method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['perp_positioning']);
  const call = await (await mcp(fetchApp, { method: 'tools/call', params: { name: 'perp_positioning', arguments: { symbol: 'BTC' } } })).json();
  assert.equal(call.result.isError, false); assert.match(call.result.content[0].text, /PerpRadar BTC: neutral/); assert.match(call.result.content[0].text, NFA);
  const bad = await (await mcp(fetchApp, { method: 'tools/call', params: { name: 'perp_positioning', arguments: { symbol: '!!' } } })).json();
  assert.equal(bad.result.isError, true);
});

test('discovery: info JSON, landing HTML, openapi, /.well-known/x402, favicon, health', async () => {
  const { fetchApp } = await makeApp();
  const info = await (await fetchApp(`${BASE}/`, { headers: { accept: 'application/json' } })).json();
  assert.equal(info.name, 'PerpRadar'); assert.deepEqual(info.paid.map((p) => [p.path, p.price]), [['/v1/lite', '$0.005'], ['/v1/full', '$0.03'], ['/v1/scan', '$0.02']]);
  assert.match(info.disclaimer, NFA); assert.match(info.policy.custody, /never trades/);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Perp<span>Radar/); assert.match(html, NFA); assert.ok(!/guarantee[ds]? (profit|return)/i.test(html));
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.equal(oa.paths['/v1/full'].get['x-payment-info'].price.amount, '0.03'); assert.equal(oa.servers[0].url, BASE); assert.match(oa.info.description, NFA);
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  assert.deepEqual(wk.resources, [`${BASE}/v1/lite`, `${BASE}/v1/full`, `${BASE}/v1/scan`]); assert.match(wk.instructions, NFA);
  assert.equal((await fetchApp(`${BASE}/favicon.ico`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetchApp(`${BASE}/health`)).status, 200);
  const hs = await (await fetchApp(`${BASE}/health?sources=1`)).json(); assert.equal(hs.sources.hyperliquid.status, 200);
});

test('stdio MCP package: validates locally, uses the hosted preview, no key = free mode, scan is paid-only', async () => {
  assert.deepEqual(STDIO_TOOLS.map((t) => t.name), ['perp_funding', 'perp_funding_scan']);
  assert.equal(toSymbol({ symbol: 'eth-usd' }).symbol, 'ETH'); assert.ok(toSymbol({ symbol: '<x>' }).error); assert.ok(toSymbol({}).error);
  const seen = [];
  const fetchImpl = async (u) => { seen.push(String(u)); return Response.json({ symbol: 'SOL', positioning: 'short_bias', positioning_note: 'Shorts pay longs: mild short bias.', venues_listed: ['hyperliquid', 'dydx'], confidence: 'medium' }); };
  const r = await stdioHandle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'perp_funding', arguments: { symbol: 'sol' } } }, { fetchImpl, env: {} });
  assert.match(r.result.content[0].text, /PerpRadar SOL: short bias/); assert.match(r.result.content[0].text, NFA);
  assert.equal(seen[0], 'https://api.youraitools.co/perpradar/v1/preview?symbol=SOL');
  const s = await stdioHandle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'perp_funding_scan', arguments: {} } }, { fetchImpl, env: {} });
  assert.equal(s.result.isError, true); assert.match(s.result.content[0].text, /paid only/);
});
