// TASignal engine: technical indicators, risk analytics, ATR position sizing and rule backtests from public OHLCV candles
// (Hyperliquid first, dYdX v4 indexer as fallback). Read-only analytics: never trades, no keys, no custody.
// Fail-closed: if no candle source answers, Incomplete (HTTP 503, never charged). Indicators that need more history than
// is available are null with a note, never extrapolated. Signals are computed on CLOSED candles only.
import { withDeadline } from './deadline.js';

export const ENGINE_VERSION = 'tasignal-0.1.0';
export const USER_AGENT = 'TASignal/0.1 (+https://api.youraitools.co/tasignal; read-only market data; hello@youraitools.co)';
export const DISCLAIMER = 'Not financial advice. Past performance does not guarantee future results. Technical indicators, risk metrics and backtests describe historical prices only; they are not predictions or trade recommendations. TASignal never trades, holds funds or keys.';
export const LIMITS = [
  'Prices are perpetual-futures candles from Hyperliquid (fallback: dYdX v4); they track but can differ slightly from spot prices.',
  'Only closed candles are used for indicators and signals; the in-progress candle is reported as last_price only.',
  'Backtests execute at the next candle open after a signal, with the fee you set; no slippage, funding or liquidity model. Results are historical simulations, not forecasts.',
  'An indicator that needs more history than is available is null with a note, never estimated.',
];
export const TIMEFRAMES = { '15m': { hl: '15m', dydx: '15MINS', ms: 900000 }, '1h': { hl: '1h', dydx: '1HOUR', ms: 3600000 }, '4h': { hl: '4h', dydx: '4HOURS', ms: 14400000 }, '1d': { hl: '1d', dydx: '1DAY', ms: 86400000 } };
export const STRATEGIES = ['sma_cross', 'ema_cross', 'rsi_reversion', 'breakout', 'macd_cross'];
const TIMEOUT = 7000;

export class InputError extends Error { constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; } }
export class Incomplete extends Error { constructor(message, sources_failed = []) { super(message); this.code = 'upstream_unavailable'; this.sources_failed = sources_failed; } }

const num = (v) => { const n = typeof v === 'number' ? v : Number.parseFloat(v); return Number.isFinite(n) ? n : null; };
const r = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const rp = (v) => (v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(8)));

export function normalizeSymbol(raw) {
  if (typeof raw !== 'string') throw new InputError('"symbol" must be a string, e.g. BTC');
  let s = raw.trim().toUpperCase().replace(/[\s_/]+/g, '-');
  s = s.replace(/-?(PERP|PERPETUAL|SWAP)$/, '').replace(/-?(USDT|USDC|USD)$/, '').replace(/-+$/, '');
  if (!/^[A-Z0-9]{1,15}$/.test(s)) throw new InputError('"symbol" must be a base asset ticker like BTC, ETH or SOL (letters and digits, max 15)');
  return s;
}
export function normalizeTimeframe(raw) {
  const t = String(raw ?? '1h').trim().toLowerCase().replace(/^60m$/, '1h').replace(/^240m$/, '4h').replace(/^(24h|1day|d)$/, '1d');
  if (!TIMEFRAMES[t]) throw new InputError(`"timeframe" must be one of ${Object.keys(TIMEFRAMES).join(', ')}`);
  return t;
}

async function getJson(fetchImpl, url, init = {}, what = url) {
  const ctl = new AbortController();
  const p = (async () => {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(init.headers || {}) } });
    if (!res.ok) { const e = new Error(`${what}: HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  })();
  try { return await withDeadline(p, TIMEOUT, what); } finally { ctl.abort(); }
}

// Hyperliquid universe (cached 5 min per isolate): unknown coins return HTTP 500 from candleSnapshot, so resolve first.
let HL_META = null;
async function hlUniverse(f, now) {
  if (HL_META && HL_META.f === f && now - HL_META.at < 300000) return HL_META.names;
  const j = await getJson(f, 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"meta"}' }, 'hyperliquid');
  const names = new Set((j.universe || []).filter((u) => !u.isDelisted).map((u) => u.name));
  HL_META = { f, at: now, names };
  return names;
}
export function _clearCache() { HL_META = null; }
async function hlCandles(f, sym, tf, bars, now) {
  const names = await hlUniverse(f, now);
  const coin = names.has(sym) ? sym : names.has(`k${sym}`) ? `k${sym}` : null;
  if (!coin) return { market: null, candles: [] };
  const scale = coin === sym ? 1 : 1000;
  const j = await getJson(f, 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: TIMEFRAMES[tf].hl, startTime: now - (bars + 2) * TIMEFRAMES[tf].ms } }) }, 'hyperliquid');
  return { market: coin, candles: (Array.isArray(j) ? j : []).map((c) => ({ t: c.t, T: c.T, o: num(c.o) / scale, h: num(c.h) / scale, l: num(c.l) / scale, c: num(c.c) / scale, v: num(c.v) * scale })) };
}
async function dydxCandles(f, sym, tf, bars, now) {
  let j;
  try { j = await getJson(f, `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${encodeURIComponent(sym)}-USD?resolution=${TIMEFRAMES[tf].dydx}&limit=${Math.min(1000, bars + 2)}`, {}, 'dydx'); }
  catch (e) { if (e.status === 404 || e.status === 400) return { market: `${sym}-USD`, candles: [] }; throw e; }
  const ms = TIMEFRAMES[tf].ms;
  return { market: `${sym}-USD`, candles: (j.candles || []).map((c) => { const t = Date.parse(c.startedAt); return { t, T: t + ms - 1, o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close), v: num(c.baseTokenVolume) }; }).reverse() };
}

/** Closed candles for sym/tf (oldest first), with source and fail-closed bookkeeping. */
export async function getCandles(sym, tf, bars, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const failed = []; let got = null; let source = null;
  for (const [name, fn] of [['hyperliquid', hlCandles], ['dydx', dydxCandles]]) {
    try {
      const x = await fn(fetchImpl, sym, tf, bars, now);
      const closed = x.candles.filter((c) => c.T < now && [c.o, c.h, c.l, c.c].every((v) => v !== null && v > 0));
      const last = x.candles.at(-1);
      if (closed.length) { got = { ...x, closed, live: last && last.T >= now ? last : null }; source = name; break; }
    } catch { failed.push(name); }
  }
  if (!got) {
    if (failed.length) throw new Incomplete(`No candle source answered for ${sym} (${failed.join(', ')} failed). Not charged; retry shortly.`, failed);
    throw new InputError(`${sym} has no candles on Hyperliquid or dYdX`, 404, 'symbol_not_found');
  }
  const closed = got.closed.slice(-bars);
  return { source, market: got.market, candles: closed, last_price: got.live?.c ?? closed.at(-1).c, failed };
}

// ---- indicators (pure functions over arrays; null until enough data) ----
export function sma(a, n) { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
export function ema(a, n) { const o = Array(a.length).fill(null); const k = 2 / (n + 1); let e = null; for (let i = 0; i < a.length; i++) { if (i === n - 1) { e = a.slice(0, n).reduce((x, y) => x + y, 0) / n; o[i] = e; } else if (i >= n) { e = a[i] * k + e * (1 - k); o[i] = e; } } return o; }
export function rsi(a, n = 14) {
  const o = Array(a.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return o;
}
export function macd(a, f = 12, s = 26, sig = 9) {
  const ef = ema(a, f), es = ema(a, s); const line = a.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
  const start = line.findIndex((x) => x !== null); const sl = Array(a.length).fill(null);
  if (start >= 0) { const e = ema(line.slice(start), sig); e.forEach((v, i) => { sl[start + i] = v; }); }
  return { line, signal: sl, hist: line.map((x, i) => (x !== null && sl[i] !== null ? x - sl[i] : null)) };
}
export function trueRange(c) { return c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)))); }
export function atr(c, n = 14) { const tr = trueRange(c); const o = Array(c.length).fill(null); let a = null; for (let i = 0; i < c.length; i++) { if (i === n - 1) { a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n; o[i] = a; } else if (i >= n) { a = (a * (n - 1) + tr[i]) / n; o[i] = a; } } return o; }
export function adx(c, n = 14) {
  if (c.length < 2 * n + 1) return null;
  const tr = trueRange(c); let atrS = 0, pS = 0, mS = 0; const dx = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { atrS += tr[i]; pS += p; mS += m; } else { atrS = atrS - atrS / n + tr[i]; pS = pS - pS / n + p; mS = mS - mS / n + m; }
    if (i >= n) { const pdi = atrS ? 100 * pS / atrS : 0, mdi = atrS ? 100 * mS / atrS : 0; dx.push({ dx: pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0, pdi, mdi }); }
  }
  let a = dx.slice(0, n).reduce((s, x) => s + x.dx, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i].dx) / n;
  const last = dx.at(-1);
  return { adx: a, plus_di: last.pdi, minus_di: last.mdi };
}
const stdev = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const barsPerYear = (tf) => 365 * 86400000 / TIMEFRAMES[tf].ms;

export function indicators(candles, tf) {
  const c = candles.map((x) => x.c); const n = c.length; const last = (a) => a[n - 1];
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), s20 = sma(c, 20);
  const rs = rsi(c, 14), m = macd(c), at = atr(candles, 14), ad = adx(candles, 14);
  const sd20 = n >= 20 ? stdev(c.slice(-20)) * Math.sqrt(19 / 20) : null;
  const bbU = s20[n - 1] !== null ? s20[n - 1] + 2 * sd20 : null, bbL = s20[n - 1] !== null ? s20[n - 1] - 2 * sd20 : null;
  const hh = n >= 14 ? Math.max(...candles.slice(-14).map((x) => x.h)) : null, ll = n >= 14 ? Math.min(...candles.slice(-14).map((x) => x.l)) : null;
  const k = hh !== null && hh > ll ? (c[n - 1] - ll) / (hh - ll) * 100 : null;
  const lr = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const vol = lr.length >= 20 ? stdev(lr.slice(-Math.min(lr.length, 90))) * Math.sqrt(barsPerYear(tf)) * 100 : null;
  const v20 = n >= 21 ? candles.slice(-21, -1).reduce((s, x) => s + x.v, 0) / 20 : null;
  const notes = [];
  if (n < 200) notes.push(`ema_200 needs 200 closed candles (have ${n})`);
  if (n < 35) notes.push(`macd needs 35 closed candles (have ${n})`);
  return {
    close: rp(c[n - 1]),
    ema_20: rp(last(e20)), ema_50: rp(last(e50)), ema_200: rp(last(e200)), sma_20: rp(last(s20)),
    rsi_14: r(last(rs), 2),
    macd: { line: rp(last(m.line)), signal: rp(last(m.signal)), histogram: rp(last(m.hist)), cross: m.hist[n - 1] !== null && m.hist[n - 2] !== null ? (m.hist[n - 2] <= 0 && m.hist[n - 1] > 0 ? 'bullish_cross' : m.hist[n - 2] >= 0 && m.hist[n - 1] < 0 ? 'bearish_cross' : 'none') : null },
    bollinger_20_2: { upper: rp(bbU), middle: rp(last(s20)), lower: rp(bbL), percent_b: bbU !== null && bbU > bbL ? r((c[n - 1] - bbL) / (bbU - bbL), 3) : null, bandwidth_pct: bbU !== null && s20[n - 1] ? r((bbU - bbL) / s20[n - 1] * 100, 3) : null },
    atr_14: rp(last(at)), atr_pct: last(at) !== null ? r(last(at) / c[n - 1] * 100, 3) : null,
    adx_14: ad ? { adx: r(ad.adx, 2), plus_di: r(ad.plus_di, 2), minus_di: r(ad.minus_di, 2) } : null,
    stochastic_k_14: r(k, 2),
    realized_vol_annual_pct: r(vol, 2),
    volume_vs_20_avg: v20 ? r(candles[n - 1].v / v20, 3) : null,
    change_pct: { bars_1: n >= 2 ? r((c[n - 1] / c[n - 2] - 1) * 100, 3) : null, bars_24: n >= 25 ? r((c[n - 1] / c[n - 25] - 1) * 100, 3) : null },
    high_20: n >= 20 ? rp(Math.max(...candles.slice(-20).map((x) => x.h))) : null, low_20: n >= 20 ? rp(Math.min(...candles.slice(-20).map((x) => x.l))) : null,
    notes,
  };
}

/** Descriptive technical bias from the indicator snapshot: score -100..100 with components. */
export function technicalBias(ind) {
  const comp = []; const add = (name, pts, why) => comp.push({ name, points: pts, why });
  const { close, ema_20: e20, ema_50: e50, ema_200: e200 } = ind;
  if (e20 !== null && e50 !== null) add('ema_20_vs_50', e20 > e50 ? 20 : -20, e20 > e50 ? 'EMA20 above EMA50' : 'EMA20 below EMA50');
  if (e200 !== null) add('price_vs_ema_200', close > e200 ? 20 : -20, close > e200 ? 'price above EMA200' : 'price below EMA200');
  if (ind.macd.histogram !== null) add('macd_histogram', ind.macd.histogram > 0 ? 15 : -15, ind.macd.histogram > 0 ? 'MACD above signal' : 'MACD below signal');
  if (ind.rsi_14 !== null) add('rsi_14', ind.rsi_14 >= 70 ? -10 : ind.rsi_14 <= 30 ? 10 : ind.rsi_14 > 50 ? 10 : -10, ind.rsi_14 >= 70 ? 'RSI overbought (>= 70)' : ind.rsi_14 <= 30 ? 'RSI oversold (<= 30)' : ind.rsi_14 > 50 ? 'RSI above 50' : 'RSI below 50');
  if (ind.adx_14) add('adx_direction', ind.adx_14.adx >= 20 ? (ind.adx_14.plus_di > ind.adx_14.minus_di ? 15 : -15) : 0, ind.adx_14.adx >= 20 ? `trend strength ADX ${ind.adx_14.adx} (${ind.adx_14.plus_di > ind.adx_14.minus_di ? '+DI' : '-DI'} leads)` : `weak trend (ADX ${ind.adx_14.adx} < 20)`);
  if (ind.bollinger_20_2.percent_b !== null) { const b = ind.bollinger_20_2.percent_b; add('bollinger_percent_b', b > 1 ? -10 : b < 0 ? 10 : 0, b > 1 ? 'close above upper band (stretched)' : b < 0 ? 'close below lower band (stretched)' : 'inside the bands'); }
  const max = comp.reduce((s, x) => s + Math.abs(x.points === 0 ? 15 : x.points), 0);
  const score = max ? Math.round(comp.reduce((s, x) => s + x.points, 0) / max * 100) : null;
  const bias = score === null ? 'unknown' : score >= 50 ? 'strong_bullish' : score >= 15 ? 'bullish' : score > -15 ? 'neutral' : score > -50 ? 'bearish' : 'strong_bearish';
  const trend = e20 !== null && e50 !== null ? (e200 !== null ? (close > e20 && e20 > e50 && e50 > e200 ? 'uptrend' : close < e20 && e20 < e50 && e50 < e200 ? 'downtrend' : 'mixed') : (e20 > e50 ? 'up (short history)' : 'down (short history)')) : 'unknown';
  const regime = ind.adx_14 ? (ind.adx_14.adx >= 25 ? 'trending' : ind.adx_14.adx < 18 ? 'ranging' : 'transitional') : 'unknown';
  return { bias, score, trend, regime, components: comp, note: 'Descriptive summary of the indicators above on closed candles; not a prediction or a recommendation to trade.' };
}

export async function taLite(sym, tf, ctx = {}) {
  const d = await getCandles(sym, tf, 300, ctx);
  const ind = indicators(d.candles, tf);
  const confidence = d.candles.length >= 200 && !d.failed.length ? 'high' : d.candles.length >= 50 ? 'medium' : 'low';
  return { symbol: sym, timeframe: tf, source: d.source, market: d.market, candles_used: d.candles.length, last_closed_at: new Date(d.candles.at(-1).T + 1).toISOString(), last_price: rp(d.last_price), indicators: ind, signal: technicalBias(ind), confidence, sources_failed: d.failed, checked_at: new Date(ctx.now ?? Date.now()).toISOString() };
}

// ---- risk analytics + ATR position sizing ----
const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
export function riskMetrics(candles, tf) {
  const c = candles.map((x) => x.c);
  const ret = c.slice(1).map((x, i) => x / c[i] - 1);
  if (ret.length < 30) return null;
  const bpy = barsPerYear(tf); const mean = ret.reduce((s, x) => s + x, 0) / ret.length; const sd = stdev(ret);
  const down = ret.filter((x) => x < 0); const dd = Math.sqrt(down.reduce((s, x) => s + x * x, 0) / ret.length);
  let peak = c[0], mdd = 0; for (const x of c) { peak = Math.max(peak, x); mdd = Math.min(mdd, x / peak - 1); }
  const hi = Math.max(...c);
  const var95 = -quant(ret, 0.05), var99 = -quant(ret, 0.01);
  const tail = (q) => { const t = ret.filter((x) => x <= quant(ret, q)); return t.length ? -t.reduce((s, x) => s + x, 0) / t.length : null; };
  const perDay = Math.sqrt(86400000 / TIMEFRAMES[tf].ms);
  return {
    bars: ret.length, period_return_pct: r((c.at(-1) / c[0] - 1) * 100, 3),
    volatility_annual_pct: r(sd * Math.sqrt(bpy) * 100, 2),
    sharpe_annual: sd ? r(mean / sd * Math.sqrt(bpy), 3) : null, sortino_annual: dd ? r(mean / dd * Math.sqrt(bpy), 3) : null,
    max_drawdown_pct: r(mdd * 100, 3), current_drawdown_from_high_pct: r((c.at(-1) / hi - 1) * 100, 3),
    var_95_per_bar_pct: r(var95 * 100, 3), var_99_per_bar_pct: r(var99 * 100, 3), cvar_95_per_bar_pct: r(tail(0.05) * 100, 3), cvar_99_per_bar_pct: r(tail(0.01) * 100, 3),
    var_95_1d_pct: r(var95 * perDay * 100, 3), var_99_1d_pct: r(var99 * perDay * 100, 3),
    worst_bar_pct: r(Math.min(...ret) * 100, 3), best_bar_pct: r(Math.max(...ret) * 100, 3),
    method: 'historical simulation on closed-candle simple returns; 1-day VaR scaled by sqrt(time); Sharpe/Sortino use a 0% risk-free rate',
  };
}
export function positionSize({ entry, stop, side = 'long', atrValue, stopAtr = 2, accountUsd = null, riskPct = 1 }) {
  let stopPrice = stop ?? null; let method = 'given stop';
  if (stopPrice === null) { if (atrValue === null) return null; stopPrice = side === 'long' ? entry - stopAtr * atrValue : entry + stopAtr * atrValue; method = `${stopAtr} x ATR(14) from entry`; }
  if ((side === 'long' && stopPrice >= entry) || (side === 'short' && stopPrice <= entry)) throw new InputError(`"stop" must be ${side === 'long' ? 'below' : 'above'} the entry for a ${side} position`);
  if (stopPrice <= 0) return { side, entry: rp(entry), stop: null, note: 'ATR stop would be at or below zero; pass a "stop" price' };
  const perUnit = Math.abs(entry - stopPrice);
  const out = { side, entry: rp(entry), stop: rp(stopPrice), stop_method: method, stop_distance_pct: r(perUnit / entry * 100, 3), risk_per_unit: rp(perUnit), risk_pct_of_account: riskPct };
  if (accountUsd !== null) {
    const riskUsd = accountUsd * riskPct / 100; const units = riskUsd / perUnit; const notional = units * entry;
    Object.assign(out, { account_usd: accountUsd, risk_usd: r(riskUsd, 2), units: rp(units), notional_usd: r(notional, 2), implied_leverage: r(notional / accountUsd, 3), take_profit_2r: rp(side === 'long' ? entry + 2 * perUnit : entry - 2 * perUnit), take_profit_3r: rp(side === 'long' ? entry + 3 * perUnit : entry - 3 * perUnit) });
    if (notional / accountUsd > 5) out.warning = 'Implied leverage above 5x: the stop is tight relative to the risk budget.';
  } else out.note = 'Pass account_usd to get units, notional and implied leverage.';
  return out;
}
export async function taRisk(sym, tf, p = {}, ctx = {}) {
  const d = await getCandles(sym, tf, Math.min(1000, p.bars ?? 500), ctx);
  const m = riskMetrics(d.candles, tf);
  if (!m) throw new Incomplete(`Only ${d.candles.length} closed candles for ${sym} ${tf}; need 31 for risk metrics. Not charged.`, []);
  const at = atr(d.candles, 14).at(-1);
  const entry = p.entry ?? d.last_price;
  const ps = positionSize({ entry, stop: p.stop ?? null, side: p.side || 'long', atrValue: at, stopAtr: p.stopAtr ?? 2, accountUsd: p.accountUsd ?? null, riskPct: p.riskPct ?? 1 });
  return { symbol: sym, timeframe: tf, source: d.source, market: d.market, candles_used: d.candles.length, last_price: rp(d.last_price), atr_14: rp(at), atr_pct: r(at / d.last_price * 100, 3), risk: m, position_sizing: ps, confidence: d.candles.length >= 300 && !d.failed.length ? 'high' : 'medium', sources_failed: d.failed, checked_at: new Date(ctx.now ?? Date.now()).toISOString() };
}

// ---- rule backtest (signal on close, fill at next open, fees per side) ----
export function signals(candles, s) {
  const c = candles.map((x) => x.c); const n = c.length; const pos = Array(n).fill(null); // desired position after bar i close: 1, 0, -1
  if (s.strategy === 'sma_cross' || s.strategy === 'ema_cross') {
    const f = (s.strategy === 'sma_cross' ? sma : ema)(c, s.fast), sl = (s.strategy === 'sma_cross' ? sma : ema)(c, s.slow);
    for (let i = 0; i < n; i++) if (f[i] !== null && sl[i] !== null) pos[i] = f[i] > sl[i] ? 1 : -1;
  } else if (s.strategy === 'macd_cross') {
    const m = macd(c, s.fast, s.slow, s.signal); for (let i = 0; i < n; i++) if (m.hist[i] !== null) pos[i] = m.hist[i] > 0 ? 1 : -1;
  } else if (s.strategy === 'rsi_reversion') {
    const x = rsi(c, s.period); let cur = 0;
    for (let i = 0; i < n; i++) { if (x[i] === null) continue; if (x[i] <= s.lower) cur = 1; else if (x[i] >= s.upper) cur = -1; else if (cur === 1 && x[i] >= 50) cur = 0; else if (cur === -1 && x[i] <= 50) cur = 0; pos[i] = cur; }
  } else if (s.strategy === 'breakout') {
    let cur = 0;
    for (let i = s.period; i < n; i++) { const w = candles.slice(i - s.period, i); const hi = Math.max(...w.map((x) => x.h)), lo = Math.min(...w.map((x) => x.l)); if (c[i] > hi) cur = 1; else if (c[i] < lo) cur = -1; pos[i] = cur; }
  }
  return pos;
}
export function backtest(candles, tf, s) {
  const raw = signals(candles, s);
  const want = raw.map((p) => (p === null ? null : s.direction === 'long_only' ? Math.max(0, p) : p));
  const fee = s.feeBps / 10000; let eq = 1, pos = 0, entryPx = null, entryT = null, entryEq = 1; const trades = []; const curve = [];
  let peak = 1, mdd = 0, barsIn = 0; const rets = [];
  const first = want.findIndex((x) => x !== null);
  if (first < 0 || first >= candles.length - 2) throw new InputError('not enough candles for these strategy parameters', 422, 'insufficient_history');
  for (let i = first + 1; i < candles.length; i++) {
    const target = want[i - 1]; const o = candles[i].o; const prevEq = eq;
    if (target !== null && target !== pos) {
      if (pos !== 0) { eq *= 1 - fee; trades.push({ side: pos > 0 ? 'long' : 'short', entry_time: new Date(entryT).toISOString(), entry: rp(entryPx), exit_time: new Date(candles[i].t).toISOString(), exit: rp(o), return_pct: r((eq / entryEq - 1) * 100, 3) }); }
      pos = target; if (pos !== 0) { eq *= 1 - fee; entryPx = o; entryT = candles[i].t; entryEq = eq; }
    }
    if (pos !== 0) { eq *= 1 + pos * (candles[i].c / o - 1); barsIn++; }
    // carry overnight: from this close to next open is part of the next bar's o->c? include close->next open gap
    if (pos !== 0 && i + 1 < candles.length) eq *= 1 + pos * (candles[i + 1].o / candles[i].c - 1);
    rets.push(eq / prevEq - 1);
    peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1);
    curve.push([candles[i].t, eq]);
  }
  if (pos !== 0) trades.push({ side: pos > 0 ? 'long' : 'short', entry_time: new Date(entryT).toISOString(), entry: rp(entryPx), exit_time: null, exit: null, open: true, return_pct: r((eq / entryEq - 1) * 100, 3) });
  const closedT = trades.filter((t) => !t.open); const wins = closedT.filter((t) => t.return_pct > 0); const losses = closedT.filter((t) => t.return_pct <= 0);
  const gp = wins.reduce((s, t) => s + t.return_pct, 0), gl = -losses.reduce((s, t) => s + t.return_pct, 0);
  const bpy = barsPerYear(tf); const sd = stdev(rets); const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const years = (candles.at(-1).T - candles[first + 1].t) / (365 * 86400000);
  const bh = candles.at(-1).c / candles[first + 1].o - 1;
  const step = Math.max(1, Math.ceil(curve.length / 50));
  return {
    period: { from: new Date(candles[first + 1].t).toISOString(), to: new Date(candles.at(-1).T + 1).toISOString(), bars: curve.length },
    total_return_pct: r((eq - 1) * 100, 3), buy_and_hold_return_pct: r(bh * 100, 3), excess_vs_buy_and_hold_pct: r((eq - 1 - bh) * 100, 3),
    annualized_return_pct: years > 0.05 ? r((eq ** (1 / years) - 1) * 100, 2) : null,
    max_drawdown_pct: r(mdd * 100, 3), sharpe_annual: sd ? r(mean / sd * Math.sqrt(bpy), 3) : null,
    trades: closedT.length, win_rate_pct: closedT.length ? r(wins.length / closedT.length * 100, 2) : null, profit_factor: gl > 0 ? r(gp / gl, 3) : null,
    avg_trade_pct: closedT.length ? r(closedT.reduce((s, t) => s + t.return_pct, 0) / closedT.length, 3) : null,
    exposure_pct: r(barsIn / curve.length * 100, 2), fees_bps_per_side: s.feeBps,
    last_trades: trades.slice(-20), equity_curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1).map(([t, e]) => [new Date(t).toISOString(), r(e, 5)]),
    current_position: pos > 0 ? 'long' : pos < 0 ? 'short' : 'flat',
    assumptions: 'Signals on candle close, fills at the next candle open, fees per side as set; no slippage, funding, borrow or liquidity limits; position size 100% of equity, no leverage.',
  };
}
export async function taBacktest(sym, tf, s, ctx = {}) {
  const d = await getCandles(sym, tf, s.bars, ctx);
  const bt = backtest(d.candles, tf, s);
  return { symbol: sym, timeframe: tf, source: d.source, market: d.market, candles_used: d.candles.length, strategy: { name: s.strategy, params: s.params, direction: s.direction }, result: bt, confidence: d.candles.length >= Math.min(s.bars, 300) && !d.failed.length ? 'high' : 'medium', sources_failed: d.failed, checked_at: new Date(ctx.now ?? Date.now()).toISOString() };
}

const intIn = (v, d, lo, hi, name) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new InputError(`"${name}" must be an integer from ${lo} to ${hi}`); return n; };
const numIn = (v, d, lo, hi, name) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new InputError(`"${name}" must be a number from ${lo} to ${hi}`); return n; };
export function parseStrategy(raw) {
  const name = String(raw.strategy ?? '').trim().toLowerCase();
  if (!STRATEGIES.includes(name)) throw new InputError(`"strategy" must be one of ${STRATEGIES.join(', ')}`);
  const s = { strategy: name, feeBps: numIn(raw.fee_bps, 5, 0, 100, 'fee_bps'), bars: intIn(raw.bars, 500, 100, 2000, 'bars') };
  const dir = String(raw.direction ?? 'long_only').toLowerCase(); if (!['long_only', 'long_short'].includes(dir)) throw new InputError('"direction" must be long_only or long_short'); s.direction = dir;
  if (name === 'sma_cross' || name === 'ema_cross') { s.fast = intIn(raw.fast, 20, 2, 200, 'fast'); s.slow = intIn(raw.slow, 50, 3, 400, 'slow'); if (s.fast >= s.slow) throw new InputError('"fast" must be smaller than "slow"'); s.params = { fast: s.fast, slow: s.slow }; }
  if (name === 'macd_cross') { s.fast = intIn(raw.fast, 12, 2, 100, 'fast'); s.slow = intIn(raw.slow, 26, 3, 200, 'slow'); s.signal = intIn(raw.signal, 9, 2, 50, 'signal'); if (s.fast >= s.slow) throw new InputError('"fast" must be smaller than "slow"'); s.params = { fast: s.fast, slow: s.slow, signal: s.signal }; }
  if (name === 'rsi_reversion') { s.period = intIn(raw.period, 14, 2, 100, 'period'); s.lower = numIn(raw.lower, 30, 1, 49, 'lower'); s.upper = numIn(raw.upper, 70, 51, 99, 'upper'); s.params = { period: s.period, lower: s.lower, upper: s.upper }; }
  if (name === 'breakout') { s.period = intIn(raw.period, 20, 5, 200, 'period'); s.params = { period: s.period }; }
  return s;
}
export function parseRisk(raw) {
  const side = String(raw.side ?? 'long').toLowerCase(); if (!['long', 'short'].includes(side)) throw new InputError('"side" must be long or short');
  return { side, accountUsd: numIn(raw.account_usd, null, 1, 1e10, 'account_usd'), riskPct: numIn(raw.risk_pct, 1, 0.01, 100, 'risk_pct'), stopAtr: numIn(raw.stop_atr, 2, 0.1, 20, 'stop_atr'), entry: numIn(raw.entry, null, 1e-12, 1e12, 'entry'), stop: numIn(raw.stop, null, 1e-12, 1e12, 'stop'), bars: intIn(raw.bars, 500, 50, 1000, 'bars') };
}
