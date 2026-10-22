// TASignal client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (bias, trend, regime; 10/min per IP). Indicator values, risk and backtests: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/tasignal';
export const FALLBACK_API_BASE = 'https://tasignal.agentgate.workers.dev';
export const PRICES = { lite: '$0.005', risk: '$0.02', backtest: '$0.05' };
export const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
export const DISCLAIMER = 'Not financial advice. Past performance does not guarantee future results. Read-only technical analytics; TASignal never trades, holds funds or keys.';
export const FULL_DETAILS = `Indicator values and bias components: ${API_BASE}/v1/lite?symbol=<ticker>&timeframe=1h (${PRICES.lite}); VaR/CVaR and ATR position sizing: /v1/risk (${PRICES.risk}); rule backtests: /v1/backtest (${PRICES.backtest}). USDC over x402 or a prepaid credits key.`;

/** Validate symbol/timeframe locally (no network). Returns { symbol, timeframe } or { error }. */
export function toInput(args = {}) {
  const v = args.symbol ?? args.coin ?? args.asset ?? args.ticker;
  if (typeof v !== 'string' || !v.trim()) return { error: '"symbol" is required: an asset ticker, e.g. BTC' };
  const s = v.trim().toUpperCase().replace(/[\s_/]+/g, '-').replace(/-?(PERP|PERPETUAL|SWAP)$/, '').replace(/-?(USDT|USDC|USD)$/, '').replace(/-+$/, '');
  if (!/^[A-Z0-9]{1,15}$/.test(s)) return { error: '"symbol" must be a ticker like BTC, ETH or SOL' };
  const tf = String(args.timeframe ?? '1h').toLowerCase();
  if (!TIMEFRAMES.includes(tf)) return { error: `"timeframe" must be one of ${TIMEFRAMES.join(', ')}` };
  return { symbol: s, timeframe: tf };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview({ symbol, timeframe }, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 30000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`, { headers: { accept: 'application/json', 'user-agent': 'tasignal-npm' } }), ms, 'TASignal preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `TASignal preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
