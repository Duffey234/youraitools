// SolVerdict client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (verdict, score, flag counts, 10/min per IP). Full reports: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/solverdict';
export const FALLBACK_API_BASE = 'https://solverdict.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/check`;
export const PRICES = { lite: '$0.005', check: '$0.02' };
export const DISCLAIMER = 'Automated, informational risk signals from public on-chain and market data. Not financial advice, not an audit, no guarantee.';
export const FULL_DETAILS = `Reasons and evidence (mint / freeze authority, Token-2022 extensions, metadata authority, pools, liquidity and sells, holders, age): paid API ${API_BASE}/v1/lite|check?mint=<mint> (${PRICES.lite} / ${PRICES.check} USDC over x402, or a prepaid credits key).`;

/** Validate the mint argument locally (no network). Returns { token } or { error }. */
export function toToken(args = {}) {
  const v = args.mint ?? args.token ?? args.address;
  if (typeof v !== 'string' || !v.trim()) return { error: '"mint" is required: a Solana token mint address (base58)' };
  const s = v.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { error: '"mint" must be a base58 Solana address (32-44 characters)' };
  return { token: s };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(token, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 25000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?mint=${encodeURIComponent(token)}`, { headers: { accept: 'application/json', 'user-agent': 'solverdict-npm' } }), ms, 'SolVerdict preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `SolVerdict preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
