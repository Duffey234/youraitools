// CounterpartyCheck client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (verdict, confidence, kind, flag counts; 10/min per IP). Reasons and evidence: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/counterpartycheck';
export const FALLBACK_API_BASE = 'https://counterparty.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/quick`;
export const PRICES = { lite: '$0.005', quick: '$0.015', full: '$0.05' };
export const DISCLAIMER = 'Automated pre-payment due-diligence signals from public lists and on-chain data. Not legal, compliance or financial advice; "ok" means no known risk signal was found, not a guarantee.';
export const FULL_DETAILS = `Reasons and evidence (OFAC SDN and scam-list matches, x402 directory, verification, deployer, ENS / Basename, cross-chain, age, exposure): paid API ${API_BASE}/v1/lite|quick|full?address=... (${PRICES.lite} / ${PRICES.quick} / ${PRICES.full} USDC over x402).`;
const CHAINS = ['base', 'ethereum', 'polygon', 'arbitrum', 'solana'];

/** Validate the tool arguments locally (no network). Returns { query } or { error }. */
export function toQuery(args = {}) {
  const a = args.address ?? args.counterparty;
  if (typeof a !== 'string' || !a.trim()) return { error: '"address" is required: an EVM address (0x + 40 hex), an ENS name or a Solana address' };
  const s = a.trim();
  const evm = /^0x[0-9a-fA-F]{40}$/.test(s); const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  const name = /^[^\s/?#]{1,250}\.eth$/i.test(s); // ENS name or Basename, resolved by the API (a failed lookup is never "ok")
  if (!evm && !sol && !name) return { error: '"address" must be an EVM address (0x + 40 hex), an ENS name / Basename (e.g. vitalik.eth) or a Solana base58 address' };
  if (name && args.chain && String(args.chain).toLowerCase() === 'solana') return { error: 'ENS names resolve to EVM addresses; use chain base, ethereum, polygon or arbitrum' };
  const chain = args.chain ? String(args.chain).toLowerCase() : sol ? 'solana' : 'base';
  if (!CHAINS.includes(chain)) return { error: `"chain" must be one of ${CHAINS.join(', ')}` };
  const intent = args.intent ? String(args.intent).toLowerCase() : 'pay';
  if (!['pay', 'approve', 'interact'].includes(intent)) return { error: '"intent" must be pay, approve or interact' };
  return { query: { address: evm ? s.toLowerCase() : s, chain, intent } };
}
export const qs = (q) => new URLSearchParams(q).toString();

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(query, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 25000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?${qs(query)}`, { headers: { accept: 'application/json', 'user-agent': 'counterpartycheck-npm' } }), ms, 'CounterpartyCheck preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `CounterpartyCheck preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
