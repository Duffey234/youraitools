// TokenVerdict client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (verdict, score, flag counts; 10/min per IP). Reasons and evidence: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/tokenverdict';
export const FALLBACK_API_BASE = 'https://tokenverdict.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/quick`;
export const PRICES = { lite: '$0.005', quick: '$0.015', deep: '$0.05' };
export const DISCLAIMER = 'Automated, informational risk signals from public on-chain and market data at the time of the check. Not financial advice, not an audit, no guarantee.';
export const FULL_DETAILS = `Reasons and evidence (sell simulation and taxes, owner powers, proxy, liquidity/LP, holders, age): paid API ${API_BASE}/v1/lite|quick|deep?token=0x... (${PRICES.lite} / ${PRICES.quick} / ${PRICES.deep} USDC on Base over x402).`;

/** Validate the token argument locally (no network). Returns { token } or { error }. */
export function toToken(args = {}) {
  const v = args.token ?? args.address;
  if (typeof v !== 'string' || !v.trim()) return { error: '"token" is required: a Base ERC-20 contract address (0x + 40 hex)' };
  const s = v.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { error: '"token" must be a 0x-prefixed 40-hex-character Base contract address' };
  return { token: s.toLowerCase() };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(token, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 25000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?token=${encodeURIComponent(token)}`, { headers: { accept: 'application/json', 'user-agent': 'tokenverdict-npm' } }), ms, 'TokenVerdict preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `TokenVerdict preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
