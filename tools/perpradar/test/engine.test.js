import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol, normalizeSymbols, positioning, perpSnapshot, perpScan, perpFull, _clearCache, DISCLAIMER } from '../src/engine.js';
import { mockVenues } from './mock.js';
test.beforeEach(() => _clearCache());

test('symbol normalization', () => {
  for (const [i, o] of [['btc', 'BTC'], ['BTC-PERP', 'BTC'], ['eth-usd', 'ETH'], ['SOLUSDT', 'SOL'], ['sol/usdc', 'SOL'], [' hype ', 'HYPE'], ['1000PEPE', '1000PEPE']]) assert.equal(normalizeSymbol(i), o);
  for (const b of ['', '-', 'A B', 'x'.repeat(16), '../etc']) assert.throws(() => normalizeSymbol(b));
  assert.deepEqual(normalizeSymbols('btc, ETH,btc'), ['BTC', 'ETH']);
});

test('positioning thresholds', () => {
  assert.deepEqual([45, 15, 0, -15, -45, null].map(positioning), ['crowded_long', 'long_bias', 'neutral', 'short_bias', 'crowded_short', 'unknown']);
  assert.match(DISCLAIMER, /Not financial advice\. Past performance does not guarantee future results\./);
});

test('normalization math: hourly, 8h and Hyperliquid k-markets', async () => {
  const net = mockVenues();
  const btc = await perpSnapshot('BTC', { fetchImpl: net.fetchImpl, now: 1 });
  const by = Object.fromEntries(btc.venues.map((v) => [v.venue, v]));
  assert.equal(by.hyperliquid.funding_apr_pct, 10.95); // 0.0000125/h * 8760
  assert.equal(by.paradex.funding_apr_pct, 10.95); // 0.0001/8h
  assert.equal(by.dydx.funding_apr_pct, 8.76);
  assert.equal(by.aevo.funding_apr_pct, 5.256);
  assert.equal(by.hyperliquid.open_interest_usd, 3200000000);
  assert.equal(btc.funding.cheapest_to_be_long, 'aevo'); assert.equal(btc.funding.median_apr_pct, 9.855);
  const pepe = await perpSnapshot('PEPE', { fetchImpl: net.fetchImpl, now: 1 });
  assert.equal(pepe.venues[0].market, 'kPEPE'); assert.equal(pepe.venues[0].mark_price, 0.00001); assert.equal(pepe.venues[0].open_interest, 9e9);
});

test('fail-closed history: a failed history source is listed, regime unknown only if no history at all', async () => {
  const net = mockVenues({ fail: new Set(['hyperliquid_history']) });
  const r = await perpFull('BTC', { fetchImpl: net.fetchImpl, now: 1 });
  assert.ok(r.sources_failed.includes('hyperliquid_history')); assert.equal(r.regime.based_on, 'dydx_100h'); assert.equal(r.confidence, 'medium');
  _clearCache();
  const sol = await perpFull('SOL', { fetchImpl: mockVenues({ fail: new Set(['hyperliquid_history']) }).fetchImpl, now: 1 });
  assert.equal(sol.regime.vs_recent, 'unknown');
});

test('scan: OI filter, venue failure listed, one venue only = low confidence', async () => {
  const r = await perpScan({ minOiUsd: 1_000_000, limit: 10 }, { fetchImpl: mockVenues({ fail: new Set(['dydx', 'paradex']) }).fetchImpl, now: 1 });
  assert.deepEqual(r.sources_failed, ['dydx', 'paradex']); assert.equal(r.confidence, 'low');
  assert.ok(!r.highest_funding.some((x) => x.symbol === 'MATIC'));
  assert.ok(r.highest_funding.every((x) => x.oi_usd_total >= 1_000_000));
  assert.equal(r.widest_spreads.length, 0, 'no spreads from a single venue');
});
