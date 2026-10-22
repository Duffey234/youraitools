// TASignal: tool definition used by the generic app (routes, inputs, views, copy).
import { taLite, taRisk, taBacktest, normalizeSymbol, normalizeTimeframe, parseStrategy, parseRisk, InputError, Incomplete, DISCLAIMER, LIMITS, ENGINE_VERSION, USER_AGENT, STRATEGIES, TIMEFRAMES } from './engine.js';
import { LITE_EXAMPLE, RISK_EXAMPLE, BACKTEST_EXAMPLE } from './examples.js';
import { withDeadline } from './deadline.js';
export { InputError, Incomplete, DISCLAIMER, LIMITS, ENGINE_VERSION, USER_AGENT };

export const NAME = 'TASignal';
export const SLUG = 'tasignal';
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-tasignal/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/tasignal';
export const SOURCES = { hyperliquid: 'https://api.hyperliquid.xyz/info (candleSnapshot)', dydx: 'https://indexer.dydx.trade/v4/candles (fallback)' };
export const DESCRIPTION = 'Technical analysis, risk analytics and backtests for trading agents in one x402 API: RSI, MACD, EMA 20/50/200, Bollinger Bands, ATR, ADX, stochastic, realized volatility and a descriptive technical bias score for any crypto asset on 15m/1h/4h/1d candles; historical VaR/CVaR, max drawdown, Sharpe/Sortino and ATR-based position sizing; and rule backtests (SMA/EMA cross, RSI reversion, Donchian breakout, MACD cross) with fees, next-open fills, trade list and equity curve. Candles from Hyperliquid with dYdX v4 fallback. Read-only analytics; free preview and remote MCP. Not financial advice.';
const SYM = { type: 'string', description: 'Base asset ticker, e.g. BTC, ETH, SOL, HYPE (BTC-PERP, ETH-USD and SOLUSDT are accepted too)' };
const TF = { type: 'string', enum: Object.keys(TIMEFRAMES), description: 'Candle timeframe: 15m, 1h, 4h or 1d (default 1h; risk default 4h)' };
const n = (description) => ({ type: 'number', description });
const i = (description) => ({ type: 'integer', description });
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', env: 'X402_PRICE_LITE', dflt: '$0.005', op: 'ta_indicators_lite',
    summary: 'Indicator snapshot + technical bias: RSI, MACD, EMA 20/50/200, Bollinger, ATR, ADX, stochastic, realized vol, trend and regime',
    desc: 'Technical indicators for any crypto asset on closed 15m/1h/4h/1d candles: RSI 14, MACD 12/26/9 with cross, EMA 20/50/200, SMA 20, Bollinger Bands 20/2 (%b, bandwidth), ATR 14 and ATR %, ADX 14 with +DI/-DI, stochastic %K, annualized realized volatility, volume vs 20-bar average, 20-bar high/low; plus a descriptive technical bias score (-100..100) with components, trend (up/down/mixed) and regime (trending/ranging). Candles from Hyperliquid, dYdX v4 fallback. Not financial advice.',
    returns: 'Indicators (RSI, MACD, EMAs, Bollinger, ATR, ADX, stochastic, realized vol), technical bias score with components, trend, regime, confidence, sources_failed.',
    input: { symbol: 'BTC', timeframe: '1h' }, schema: { properties: { symbol: SYM, timeframe: TF }, required: ['symbol'] }, example: LITE_EXAMPLE },
  { tier: 'risk', path: '/v1/risk', key: 'priceRisk', env: 'X402_PRICE_RISK', dflt: '$0.02', op: 'ta_risk_position_size',
    summary: 'Risk analytics + position sizing: historical VaR/CVaR 95/99, max and current drawdown, volatility, Sharpe/Sortino, ATR stop, units, notional, leverage',
    desc: 'Risk analytics and position sizing for a crypto asset: historical VaR and CVaR at 95/99% per bar and per day, annualized volatility, max drawdown and current drawdown from the high, Sharpe and Sortino, worst/best bar over up to 1000 closed candles; ATR(14)-based stop (or your stop), risk per unit and, with account_usd and risk_pct, the position size in units and USD notional, implied leverage and 2R/3R levels. Not financial advice.',
    returns: 'VaR/CVaR, volatility, drawdowns, Sharpe/Sortino, ATR, stop price and distance, units, notional, implied leverage, 2R/3R levels.',
    input: { symbol: 'ETH', timeframe: '4h', account_usd: 10000, risk_pct: 1, side: 'long' },
    schema: { properties: { symbol: SYM, timeframe: TF, account_usd: n('Account size in USD (optional; enables units, notional, leverage)'), risk_pct: n('Percent of the account risked if the stop is hit (default 1)'), side: { type: 'string', enum: ['long', 'short'], description: 'Position side (default long)' }, stop_atr: n('Stop distance in ATR(14) multiples when no stop is given (default 2)'), entry: n('Entry price (default: last price)'), stop: n('Stop price (optional; overrides stop_atr)'), bars: i('Candles for risk metrics, 50-1000 (default 500)') }, required: ['symbol'] },
    example: RISK_EXAMPLE },
  { tier: 'backtest', path: '/v1/backtest', key: 'priceBacktest', env: 'X402_PRICE_BACKTEST', dflt: '$0.05', op: 'ta_backtest',
    summary: 'Rule backtest: SMA/EMA cross, RSI reversion, Donchian breakout or MACD cross on up to 2000 candles with fees; return vs buy-and-hold, drawdown, Sharpe, win rate, profit factor, trades, equity curve',
    desc: `Backtest a rule-based strategy (${STRATEGIES.join(', ')}) on up to 2000 closed candles of any crypto asset: signals on close, fills at the next open, fees per side, long-only or long/short. Returns total and annualized return, buy-and-hold return and excess, max drawdown, Sharpe, trade count, win rate, profit factor, average trade, exposure, the last 20 trades and a 50-point equity curve. Historical simulation only. Not financial advice; past performance does not guarantee future results.`,
    returns: 'Total / annualized return, vs buy-and-hold, max drawdown, Sharpe, trades, win rate, profit factor, exposure, last 20 trades, equity curve, current position.',
    input: { symbol: 'SOL', timeframe: '4h', strategy: 'ema_cross', fast: 20, slow: 50 },
    schema: { properties: { symbol: SYM, timeframe: TF, strategy: { type: 'string', enum: STRATEGIES, description: 'Strategy rule' }, fast: i('Fast period (sma_cross/ema_cross default 20, macd_cross 12)'), slow: i('Slow period (sma_cross/ema_cross default 50, macd_cross 26)'), signal: i('MACD signal period (default 9)'), period: i('RSI period (default 14) or breakout lookback (default 20)'), lower: n('RSI entry level for longs (default 30)'), upper: n('RSI entry level for shorts / exit (default 70)'), direction: { type: 'string', enum: ['long_only', 'long_short'], description: 'default long_only' }, fee_bps: n('Fee per side in basis points (default 5)'), bars: i('Candles to test, 100-2000 (default 500)') }, required: ['symbol', 'strategy'] },
    example: BACKTEST_EXAMPLE },
];
export const PREVIEW = { path: '/v1/preview', tier: 'preview', input: { symbol: 'BTC', timeframe: '1h' }, schema: { properties: { symbol: SYM, timeframe: TF }, required: ['symbol'] }, returns: 'technical bias label, trend and regime, confidence (no indicator values)' };

export function parseInput(tier, raw = {}) {
  const s = raw.symbol ?? raw.coin ?? raw.asset ?? raw.ticker;
  if (s === undefined || s === '') throw new InputError('"symbol" is required, e.g. BTC');
  const symbol = normalizeSymbol(String(s));
  if (tier === 'risk') return { symbol, timeframe: normalizeTimeframe(raw.timeframe ?? raw.interval ?? '4h'), ...parseRisk(raw) };
  const timeframe = normalizeTimeframe(raw.timeframe ?? raw.interval ?? '1h');
  if (tier === 'backtest') return { symbol, timeframe, ...parseStrategy(raw) };
  return { symbol, timeframe };
}
export function run(tier, v, ctx) {
  if (tier === 'risk') return taRisk(v.symbol, v.timeframe, v, ctx);
  if (tier === 'backtest') return taBacktest(v.symbol, v.timeframe, v, ctx);
  return taLite(v.symbol, v.timeframe, ctx);
}
export function paidView(tier, r) { return r; }
export function previewView(r) {
  return { symbol: r.symbol, timeframe: r.timeframe, bias: r.signal.bias, trend: r.signal.trend, regime: r.signal.regime, source: r.source, confidence: r.confidence, sources_failed: r.sources_failed, checked_at: r.checked_at, disclaimer: DISCLAIMER };
}
export function fullLinks(origin, v, prices) {
  const q = `symbol=${encodeURIComponent(v.symbol)}&timeframe=${v.timeframe}`;
  return { lite: `${origin}/v1/lite?${q}`, risk: `${origin}/v1/risk?symbol=${encodeURIComponent(v.symbol)}&timeframe=4h&account_usd=10000&risk_pct=1`, backtest: `${origin}/v1/backtest?${q}&strategy=ema_cross`, prices, adds: 'indicator values and the bias score with components (lite); VaR/CVaR, drawdowns, Sharpe/Sortino and ATR position sizing (risk); rule backtests with trades and equity curve (backtest)' };
}
export const MCP_INSTRUCTIONS = 'Call ta_bias with an asset ticker (BTC, ETH, SOL...) and optional timeframe for the technical bias, trend and regime. Indicator values, risk/position sizing and backtests are on the paid x402 routes. Not financial advice.';
export const MCP_TOOLS = [
  { name: 'ta_bias', title: 'Technical bias, trend and regime (free preview)', description: 'Descriptive technical read for a crypto asset on closed 15m/1h/4h/1d candles: bias (strong bearish ... strong bullish), trend (up/down/mixed) and regime (trending/ranging) from RSI, MACD, EMA 20/50/200, Bollinger and ADX. Free preview tier. The paid x402 routes add every indicator value and the bias components (/v1/lite), VaR/CVaR, drawdowns and ATR position sizing (/v1/risk) and rule backtests (/v1/backtest). Read-only analytics; not financial advice.', inputSchema: { type: 'object', properties: { symbol: SYM, timeframe: TF }, required: ['symbol'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false } },
];
export function previewText(pv, origin, v, prices) {
  return `TASignal ${pv.symbol} ${pv.timeframe}: ${pv.bias.replace(/_/g, ' ')} bias, trend ${pv.trend}, regime ${pv.regime} (source ${pv.source}, confidence ${pv.confidence}${pv.sources_failed.length ? `; failed: ${pv.sources_failed.join(', ')}` : ''}).\nIndicator values and bias components: ${origin}/v1/lite?symbol=${encodeURIComponent(v.symbol)}&timeframe=${v.timeframe} (${prices.lite}); risk and position sizing: /v1/risk (${prices.risk}); backtests: /v1/backtest (${prices.backtest}). x402 USDC on Base or Solana.\n${DISCLAIMER}`;
}
export async function probeSources({ fetchImpl }) {
  const probe = async (name, url, init) => { const t0 = Date.now(); try { const r = await withDeadline(fetchImpl(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init?.headers || {}) } }), 6000, name); return [name, { status: r.status, ms: Date.now() - t0 }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
  return Object.fromEntries(await Promise.all([
    probe('hyperliquid', 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"meta"}' }),
    probe('dydx', 'https://indexer.dydx.trade/v4/time'),
  ]));
}
export const LANDING = {
  title: 'TASignal: technical indicators, risk metrics, position sizing and backtests for crypto trading agents (x402 API + MCP)',
  h1: 'TA<span>Signal</span>',
  lead: 'Technical analysis, risk and backtests for trading agents in one pay-per-call API. Get <b>RSI, MACD, EMA 20/50/200, Bollinger, ATR, ADX</b>, stochastic and realized volatility with a descriptive bias score for any crypto asset on 15m/1h/4h/1d candles; <b>VaR/CVaR, drawdowns, Sharpe/Sortino and ATR position sizing</b>; and <b>rule backtests</b> (SMA/EMA cross, RSI reversion, breakout, MACD cross) with fees, trades and an equity curve. Candles from Hyperliquid with dYdX v4 fallback. Read-only analytics: TASignal never trades and never touches funds.',
  snippet: (origin) => `// Trading agent: read the chart, size the position, check the rule's history
const ta = await (await pay('${origin}/v1/lite?symbol=ETH&timeframe=4h')).json();
console.log(ta.signal.bias, ta.indicators.rsi_14, ta.indicators.atr_pct);
const size = await (await pay('${origin}/v1/risk?symbol=ETH&timeframe=4h&account_usd=5000&risk_pct=0.5')).json();
console.log(size.position_sizing.stop, size.position_sizing.units);
const bt = await (await pay('${origin}/v1/backtest?symbol=ETH&timeframe=4h&strategy=ema_cross&fast=20&slow=50')).json();
console.log(bt.result.total_return_pct, bt.result.buy_and_hold_return_pct, bt.result.max_drawdown_pct);`,
};
