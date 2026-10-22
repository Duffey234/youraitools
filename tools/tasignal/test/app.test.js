import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { makeApp, BASE, PAY_TO, mockSources } from './helpers.js';
import { headAsGet } from '../src/head.js';
import { handle as stdioHandle, TOOLS as STDIO_TOOLS } from '../src/mcp-stdio.js';
import { toInput } from '../src/lite.js';
import { _clearCache } from '../src/engine.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const v2pay = (fetchApp) => wrapFetchWithPaymentFromConfig(fetchApp, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ROUTES = [['lite', '5000', 'symbol=BTC&timeframe=1h'], ['risk', '20000', 'symbol=ETH&account_usd=10000'], ['backtest', '50000', 'symbol=SOL&strategy=ema_cross']];
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
      assert.ok(validateDiscoveryExtension(req.extensions.bazaar).valid, 'bazaar declaration valid');
      assert.ok(r.headers.get('PAYMENT-REQUIRED').length < 12000, 'header size');
      const b = await r.json(); assert.equal(b.x402Version, 1); assert.equal(b.accepts[0].maxAmountRequired, amount);
    }
  }
  assert.equal(net.calls.length, 0);
});

test('HEAD = 402 + PAYMENT-REQUIRED with no body and never settles', async () => {
  const { app, facilitator } = await makeApp();
  const h = headAsGet((req) => app.fetch(req));
  for (const [tier, amount, qs] of ROUTES) {
    const r = await h(new Request(`${BASE}/v1/${tier}?${qs}`, { method: 'HEAD', headers: { 'payment-signature': 'junk' } }));
    assert.equal(r.status, 402); assert.equal(decode(r.headers.get('payment-required')).accepts[0].amount, amount); assert.equal(await r.text(), '');
  }
  assert.equal(facilitator.verified.length, 0);
});

test('bad input: 400 before payment (never charged, nothing fetched)', async () => {
  const { fetchApp, facilitator, net } = await makeApp();
  for (const qs of ['symbol=%3Cx%3E', 'symbol=BTC&timeframe=2h', 'timeframe=1h']) for (const t of ['lite', 'preview']) assert.equal((await fetchApp(`${BASE}/v1/${t}?${qs}`)).status, 400, `${t} ${qs}`);
  for (const qs of ['symbol=BTC&side=sideways', 'symbol=BTC&risk_pct=0', 'symbol=BTC&account_usd=-5', 'symbol=BTC&bars=5']) assert.equal((await fetchApp(`${BASE}/v1/risk?${qs}`)).status, 400, qs);
  for (const qs of ['symbol=BTC', 'symbol=BTC&strategy=martingale', 'symbol=BTC&strategy=sma_cross&fast=50&slow=20', 'symbol=BTC&strategy=rsi_reversion&lower=60', 'symbol=BTC&strategy=breakout&bars=99999', 'symbol=BTC&strategy=ema_cross&direction=yolo', 'symbol=BTC&strategy=ema_cross&fee_bps=500']) assert.equal((await fetchApp(`${BASE}/v1/backtest?${qs}`)).status, 400, qs);
  assert.equal(facilitator.verified.length, 0); assert.equal(net.calls.length, 0);
});

test('paid v2 lite: indicators on closed candles, bias with components, settled once, disclaimer', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/lite?symbol=btc-perp&timeframe=1h`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.tier, 'lite'); assert.equal(j.symbol, 'BTC'); assert.equal(j.source, 'hyperliquid'); assert.equal(j.candles_used, 300);
  assert.equal(j.last_closed_at, '2026-10-22T12:00:00.000Z', 'in-progress 12:00 candle excluded');
  for (const k of ['rsi_14', 'ema_20', 'ema_200', 'atr_14', 'realized_vol_annual_pct']) assert.equal(typeof j.indicators[k], 'number', k);
  assert.ok(j.signal.components.length >= 5); assert.ok(['strong_bullish', 'bullish', 'neutral', 'bearish', 'strong_bearish'].includes(j.signal.bias));
  assert.equal(j.confidence, 'high'); assert.match(j.disclaimer, NFA);
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '5000');
});

test('paid v2 risk (POST) and backtest: VaR, sizing math, trades, equity curve', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const r = await v2pay(fetchApp)(`${BASE}/v1/risk`, json({ symbol: 'ETH', account_usd: 10000, risk_pct: 1, side: 'long', stop_atr: 2 }));
  assert.equal(r.status, 200); const j = await r.json();
  const ps = j.position_sizing; assert.equal(ps.risk_usd, 100); assert.ok(ps.stop < ps.entry);
  assert.ok(Math.abs(ps.units * ps.risk_per_unit - 100) < 0.01); assert.ok(j.risk.var_99_per_bar_pct >= j.risk.var_95_per_bar_pct); assert.ok(j.risk.max_drawdown_pct <= 0);
  assert.equal(j.timeframe, '4h');
  const b = await v2pay(fetchApp)(`${BASE}/v1/backtest?symbol=SOL&timeframe=4h&strategy=sma_cross&fast=10&slow=30&direction=long_short&bars=400`);
  assert.equal(b.status, 200); const bj = await b.json();
  assert.equal(bj.strategy.name, 'sma_cross'); assert.ok(bj.result.trades > 3); assert.ok(bj.result.equity_curve.length <= 51); assert.match(bj.disclaimer, NFA);
  assert.deepEqual(facilitator.settled.map((x) => x.amount), ['20000', '50000']);
});

test('FAIL-CLOSED: Hyperliquid down = dYdX fallback with sources_failed; both down = 503 (not settled); unknown symbol = 404 (not settled)', async () => {
  const half = await makeApp({ net: mockSources({ fail: new Set(['hyperliquid']) }) });
  const r = await v2pay(half.fetchApp)(`${BASE}/v1/lite?symbol=ETH`);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.source, 'dydx'); assert.deepEqual(j.sources_failed, ['hyperliquid']); assert.notEqual(j.confidence, 'high');
  _clearCache();
  const down = await makeApp({ net: mockSources({ fail: new Set(['hyperliquid', 'dydx']) }) });
  for (const [tier, , qs] of ROUTES) {
    const x = await v2pay(down.fetchApp)(`${BASE}/v1/${tier}?${qs}`);
    assert.equal(x.status, 503, tier); const xj = await x.json(); assert.equal(xj.error, 'upstream_unavailable'); assert.equal(xj.charged, false); assert.deepEqual(xj.sources_failed, ['hyperliquid', 'dydx']);
  }
  assert.equal(down.facilitator.settled.length, 0);
  _clearCache();
  const { fetchApp, facilitator } = await makeApp();
  const nf = await v2pay(fetchApp)(`${BASE}/v1/lite?symbol=ZZZQ`);
  assert.equal(nf.status, 404); assert.equal(facilitator.settled.length, 0);
  const only = await v2pay(fetchApp)(`${BASE}/v1/lite?symbol=DYDXONLY`);
  assert.equal(only.status, 200); const oj = await only.json(); assert.equal(oj.source, 'dydx'); assert.deepEqual(oj.sources_failed, [], 'not listed on Hyperliquid is not a failure');
});

test('short history: indicators that need more data are null with a note (never extrapolated)', async () => {
  const { fetchApp } = await makeApp({ net: mockSources({ bars: 60 }) });
  const j = await (await v2pay(fetchApp)(`${BASE}/v1/lite?symbol=BTC`)).json();
  assert.equal(j.indicators.ema_200, null); assert.ok(j.indicators.notes.some((n) => /ema_200/.test(n))); assert.equal(j.confidence, 'medium');
});

test('free preview: bias/trend/regime only, rate limit; MCP preview', async () => {
  let n = 0; const limiter = { limit: async () => ({ success: ++n <= 2 }) };
  const { fetchApp } = await makeApp({ limiter });
  const j = await (await fetchApp(`${BASE}/v1/preview?symbol=ETH&timeframe=4h`)).json();
  assert.equal(j.symbol, 'ETH'); assert.ok(j.bias); assert.equal(j.indicators, undefined); assert.equal(j.full.prices.backtest, '$0.05'); assert.match(j.disclaimer, NFA);
  const call = await (await mcp(fetchApp, { method: 'tools/call', params: { name: 'ta_bias', arguments: { symbol: 'BTC' } } })).json();
  assert.equal(call.result.isError, false); assert.match(call.result.content[0].text, /TASignal BTC 1h: /); assert.match(call.result.content[0].text, NFA);
  assert.equal((await fetchApp(`${BASE}/v1/preview?symbol=BTC`)).status, 429);
  const init = await (await mcp(fetchApp, { method: 'initialize', params: {} })).json(); assert.equal(init.result.serverInfo.name, 'tasignal');
  const list = await (await mcp(fetchApp, { method: 'tools/list' })).json(); assert.deepEqual(list.result.tools.map((t) => t.name), ['ta_bias']);
});

test('discovery: info JSON, landing HTML, openapi, /.well-known/x402, favicon, health', async () => {
  const { fetchApp } = await makeApp();
  const info = await (await fetchApp(`${BASE}/`, { headers: { accept: 'application/json' } })).json();
  assert.equal(info.name, 'TASignal'); assert.deepEqual(info.paid.map((p) => [p.path, p.price]), [['/v1/lite', '$0.005'], ['/v1/risk', '$0.02'], ['/v1/backtest', '$0.05']]);
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /TA<span>Signal/); assert.match(html, NFA); assert.ok(!/guarantee[ds]? (profit|return)/i.test(html));
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json(); assert.equal(oa.paths['/v1/backtest'].get['x-payment-info'].price.amount, '0.05');
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json(); assert.deepEqual(wk.resources, [`${BASE}/v1/lite`, `${BASE}/v1/risk`, `${BASE}/v1/backtest`]);
  assert.equal((await fetchApp(`${BASE}/favicon.ico`)).headers.get('content-type'), 'image/svg+xml');
  const hs = await (await fetchApp(`${BASE}/health?sources=1`)).json(); assert.equal(hs.sources.hyperliquid.status, 200);
});

test('stdio MCP package: validates locally, preview by default, risk/backtest paid-only', async () => {
  assert.deepEqual(STDIO_TOOLS.map((t) => t.name), ['ta_indicators', 'ta_position_size', 'ta_backtest']);
  assert.deepEqual(toInput({ symbol: 'eth-usd', timeframe: '4h' }), { symbol: 'ETH', timeframe: '4h' }); assert.ok(toInput({ symbol: 'BTC', timeframe: '2h' }).error);
  const seen = [];
  const fetchImpl = async (u) => { seen.push(String(u)); return Response.json({ symbol: 'SOL', timeframe: '1h', bias: 'bullish', trend: 'uptrend', regime: 'trending', confidence: 'high' }); };
  const r = await stdioHandle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ta_indicators', arguments: { symbol: 'sol' } } }, { fetchImpl, env: {} });
  assert.match(r.result.content[0].text, /TASignal SOL 1h: bullish bias/); assert.match(r.result.content[0].text, NFA);
  assert.equal(seen[0], 'https://api.youraitools.co/tasignal/v1/preview?symbol=SOL&timeframe=1h');
  const b = await stdioHandle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ta_backtest', arguments: { symbol: 'SOL', strategy: 'ema_cross' } } }, { fetchImpl, env: {} });
  assert.equal(b.result.isError, true); assert.match(b.result.content[0].text, /paid only/);
});
