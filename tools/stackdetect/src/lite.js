// StackDetect client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (technology names + categories, 10/min per IP). Full results: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/stackdetect';
export const FALLBACK_API_BASE = 'https://stackdetect.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/detect`;
export const PRICE = '$0.003';
export const DISCLAIMER = 'Informational: technologies inferred from public signals of one page load and public DNS. Detection can miss tools loaded later by JavaScript or hidden by the site; confidence is a heuristic.';
export const FULL_DETAILS = `Versions, confidence, evidence and email / DNS / hosting providers + verified SaaS: paid API ${PAID_URL}?url=<site> (${PRICE} USDC on Base per lookup over x402).`;

/** Validate the url argument locally (no network). Returns { url } or { error }. */
export function toTarget(args = {}) {
  const v = args.url ?? args.domain;
  if (typeof v !== 'string' || !v.trim()) return { error: '"url" is required, e.g. https://example.com or example.com' };
  if (v.length > 2048) return { error: 'url is longer than 2048 characters' };
  const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`;
  try { const u = new URL(s); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return { error: 'url must be a public http(s) URL or domain' }; } catch { return { error: 'url must be a public http(s) URL or domain' }; }
  return { url: s };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(url, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 15000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?url=${encodeURIComponent(url)}`, { headers: { accept: 'application/json', 'user-agent': 'stackdetect-npm' } }), ms, 'StackDetect preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `StackDetect preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
