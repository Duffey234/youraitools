import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, atr, macd, backtest, signals, positionSize, riskMetrics, normalizeTimeframe, parseStrategy, technicalBias, indicators, DISCLAIMER } from '../src/engine.js';
const C = (closes) => closes.map((c, i) => ({ t: i * 3600000, T: i * 3600000 + 3599999, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) + 1, l: Math.min(c, i ? closes[i - 1] : c) - 1, c, v: 1 }));

test('indicator math against hand-computed values', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3); assert.equal(e[2], 2); assert.equal(e[3], 3); assert.equal(e[4], 4);
  const up = Array.from({ length: 30 }, (_, i) => 100 + i); assert.equal(rsi(up, 14).at(-1), 100);
  const dn = up.slice().reverse(); assert.equal(rsi(dn, 14).at(-1), 0);
  const flatBars = Array.from({ length: 20 }, (_, i) => ({ o: 10, h: 11, l: 9, c: 10 })); assert.equal(atr(flatBars, 14).at(-1), 2);
  const m = macd(up); assert.ok(m.line.at(-1) > 0); assert.equal(m.line[24], null); assert.notEqual(m.line[25], null);
  assert.match(DISCLAIMER, /Not financial advice\. Past performance does not guarantee future results\./);
});

test('timeframes and strategy parsing', () => {
  assert.equal(normalizeTimeframe('60m'), '1h'); assert.equal(normalizeTimeframe('1D'), '1d'); assert.throws(() => normalizeTimeframe('3h'));
  assert.deepEqual(parseStrategy({ strategy: 'ema_cross' }).params, { fast: 20, slow: 50 });
  assert.deepEqual(parseStrategy({ strategy: 'rsi_reversion', lower: '25' }).params, { period: 14, lower: 25, upper: 70 });
  assert.throws(() => parseStrategy({ strategy: 'ema_cross', fast: 60, slow: 50 }));
});

test('backtest has no lookahead: a signal at bar i close fills at bar i+1 open', () => {
  // flat at 100 then jump: the cross happens on the jump bar close; the fill must be the NEXT open (the high price)
  const closes = [...Array(30).fill(100), 120, 121, 122, 123, 124, 125];
  const bt = backtest(C(closes), '1h', { strategy: 'sma_cross', fast: 2, slow: 5, direction: 'long_only', feeBps: 0, bars: 500 });
  const t = bt.last_trades[0]; assert.equal(t.side, 'long'); assert.equal(t.entry, 120, 'entered at the open after the signal bar');
  const pos = signals(C(closes), { strategy: 'sma_cross', fast: 2, slow: 5 }); assert.equal(pos[30], 1);
});

test('backtest fees and buy-and-hold comparison on a pure uptrend', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 * 1.01 ** i);
  const a = backtest(C(closes), '1d', { strategy: 'ema_cross', fast: 5, slow: 20, direction: 'long_only', feeBps: 0, bars: 500 });
  const b = backtest(C(closes), '1d', { strategy: 'ema_cross', fast: 5, slow: 20, direction: 'long_only', feeBps: 50, bars: 500 });
  assert.ok(a.total_return_pct > b.total_return_pct, 'fees reduce returns'); assert.equal(a.current_position, 'long'); assert.equal(a.max_drawdown_pct, 0);
  assert.ok(Math.abs(a.total_return_pct - a.buy_and_hold_return_pct) < 1e-6, 'always long after the first signal = buy and hold');
});

test('position sizing math and validation', () => {
  const p = positionSize({ entry: 100, stop: null, side: 'long', atrValue: 2.5, stopAtr: 2, accountUsd: 10000, riskPct: 1 });
  assert.equal(p.stop, 95); assert.equal(p.risk_usd, 100); assert.equal(p.units, 20); assert.equal(p.notional_usd, 2000); assert.equal(p.implied_leverage, 0.2); assert.equal(p.take_profit_2r, 110);
  const s = positionSize({ entry: 100, stop: 104, side: 'short', atrValue: 1, accountUsd: 1000, riskPct: 2 }); assert.equal(s.units, 5); assert.equal(s.take_profit_2r, 92);
  assert.throws(() => positionSize({ entry: 100, stop: 105, side: 'long', atrValue: 1 }));
});

test('risk metrics: VaR ordering, drawdown and too-short history', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.05 * Math.sin(i / 5)) * 1.001 ** i);
  const m = riskMetrics(C(closes), '1h');
  assert.ok(m.var_99_per_bar_pct >= m.var_95_per_bar_pct); assert.ok(m.cvar_95_per_bar_pct >= m.var_95_per_bar_pct); assert.ok(m.max_drawdown_pct < 0);
  assert.equal(riskMetrics(C(closes.slice(0, 20)), '1h'), null);
});

test('bias: uptrend reads bullish, downtrend bearish, short history keeps unknown fields null', () => {
  const upC = C(Array.from({ length: 260 }, (_, i) => 100 * 1.003 ** i + Math.sin(i) * 0.3));
  const b = technicalBias(indicators(upC, '1h')); assert.equal(b.trend, 'uptrend'); assert.ok(b.score > 0);
  const dnC = C(Array.from({ length: 260 }, (_, i) => 100 * 0.997 ** i + Math.sin(i) * 0.3));
  const d = technicalBias(indicators(dnC, '1h')); assert.equal(d.trend, 'downtrend'); assert.ok(d.score < 0);
  const s = indicators(C([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), '1h'); assert.equal(s.ema_20, null); assert.equal(s.rsi_14, null);
});
