// PerpRadar client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (positioning label, venues, confidence; 10/min per IP). Rates, OI, history and scans: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/perpradar';
export const FALLBACK_API_BASE = 'https://perpradar.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/full`;
export const PRICES = { lite: '$0.005', full: '$0.03', scan: '$0.02' };
export const DISCLAIMER = 'Not financial advice. Past performance does not guarantee future results. Read-only market analytics; PerpRadar never trades, holds funds or keys.';
export const FULL_DETAILS = `Per-venue funding (8h %, APR), open interest, premium, 7-day funding history and carry: paid API ${API_BASE}/v1/lite|full?symbol=<ticker> (${PRICES.lite} / ${PRICES.full} USDC over x402, or a prepaid credits key); universe scan ${API_BASE}/v1/scan?universe=all (${PRICES.scan}).`;

/** Validate the symbol argument locally (no network). Returns { symbol } or { error }. */
export function toSymbol(args = {}) {
  const v = args.symbol ?? args.coin ?? args.asset ?? args.ticker;
  if (typeof v !== 'string' || !v.trim()) return { error: '"symbol" is required: an asset ticker, e.g. BTC' };
  let s = v.trim().toUpperCase().replace(/[\s_/]+/g, '-').replace(/-?(PERP|PERPETUAL|SWAP)$/, '').replace(/-?(USDT|USDC|USD)$/, '').replace(/-+$/, '');
  if (!/^[A-Z0-9]{1,15}$/.test(s)) return { error: '"symbol" must be a ticker like BTC, ETH or SOL' };
  return { symbol: s };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(symbol, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 30000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?symbol=${encodeURIComponent(symbol)}`, { headers: { accept: 'application/json', 'user-agent': 'perpradar-npm' } }), ms, 'PerpRadar preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `PerpRadar preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
