// x402fix client used by the npm package (library + stdio MCP server). Free tier: the hosted preview (grade, score, status,
// counts; 10/min per IP). Fix lists and generated fixes: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/x402fix';
export const FALLBACK_API_BASE = 'https://x402fix.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/check`;
export const PRICES = { lite: '$0.005', check: '$0.02', site: '$0.05' };
export const DISCLAIMER = 'Automated, unpaid probe of a public x402 endpoint: no payment is made. Fixes are suggestions; a passing grade does not guarantee listing or settlement.';
export const FULL_DETAILS = `Fix list (lite ${PRICES.lite}), CDP validate verdict + payee checks + generated Bazaar block and multichain accepts (check ${PRICES.check}), whole origin (site ${PRICES.site}): ${API_BASE}/v1/lite|check|site?url=... (USDC over x402).`;

/** Validate the tool arguments locally (no network). Returns { query } or { error }. */
export function toQuery(args = {}) {
  const u = args.url ?? args.endpoint;
  if (typeof u !== 'string' || !u.trim()) return { error: '"url" is required: the full https URL of a paid x402 route' };
  let p; try { p = new URL(u.trim()); } catch { return { error: '"url" must be an absolute URL (https://...)' }; }
  if (!/^https?:$/.test(p.protocol)) return { error: '"url" must be http(s)' };
  const q = { url: p.toString() };
  if (args.method) { const m = String(args.method).toUpperCase(); if (!['GET', 'POST'].includes(m)) return { error: '"method" must be GET or POST' }; q.method = m; }
  return { query: q };
}
export const qs = (q) => new URLSearchParams(q).toString();

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(query, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 30000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?${qs(query)}`, { headers: { accept: 'application/json', 'user-agent': 'x402fix-npm' } }), ms, 'x402fix preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `x402fix preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
