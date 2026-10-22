// SignCheck client used by the npm package (library + stdio MCP server). Free tier: the hosted offline preview
// (verdict, summary, flag codes; 10/min per IP). Full check: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/signcheck';
export const FALLBACK_API_BASE = 'https://signcheck.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/check`;
export const PRICE = '$0.015';
export const DISCLAIMER = 'Informational pre-sign check from public data and static rules, not a security guarantee or financial advice. A SAFE verdict means no known-bad pattern was found.';
export const FULL_DETAILS = `Reasons, decoded arguments, on-chain facts (is the spender a wallet or a contract? token symbol/decimals), OFAC SDN details and an eth_call simulation: paid API POST ${PAID_URL} (${PRICE} USDC on Base per check over x402).`;
const KEYS = ['chain', 'tx', 'typed_data', 'authorization', 'payment_required', 'payment_payload'];

/** Validate the tool arguments locally (no network). Returns { body } or { error }. */
export function toBody(args = {}) {
  if (!args || typeof args !== 'object') return { error: 'arguments must be an object' };
  const body = {};
  for (const k of KEYS) if (args[k] !== undefined && args[k] !== null && args[k] !== '') body[k] = args[k];
  if (!['tx', 'typed_data', 'authorization', 'payment_required'].some((k) => body[k] !== undefined)) return { error: 'send one of "tx" ({to, data, value, from}), "typed_data" (EIP-712), "authorization" (EIP-7702) or "payment_required" (+ "payment_payload") for an x402 payment' };
  const s = JSON.stringify(body);
  if (s.length > 120000) return { error: 'input larger than 120 KB' };
  return { body };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(body, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 15000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'signcheck-npm' }, body: JSON.stringify(body) }), ms, 'SignCheck preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `SignCheck preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
