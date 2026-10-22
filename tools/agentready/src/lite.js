// AgentReady client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (score, grade, category scores, counts; 10/min per IP). Full audits: paid API over x402 (see paid.js).
import { withDeadline } from './deadline.js';

export const API_BASE = 'https://api.youraitools.co/agentready';
export const FALLBACK_API_BASE = 'https://agentready.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/audit`;
export const PRICES = { lite: '$0.005', audit: '$0.03' };
export const DISCLAIMER = 'Automated checks of public URLs at the time of the audit; informational, no guarantee that a given AI product will crawl, cite or use the site.';
export const FULL_DETAILS = `Findings, prioritized fixes and ready-to-paste snippets (llms.txt draft, robots.txt lines, JSON-LD, meta tags): paid API ${API_BASE}/v1/lite|audit?url=<site> (${PRICES.lite} / ${PRICES.audit} USDC over x402, or a prepaid credits key).`;

/** Validate the url argument locally (no network). Returns { url } or { error }. */
export function toUrl(args = {}) {
  const v = args.url ?? args.domain ?? args.site;
  if (typeof v !== 'string' || !v.trim()) return { error: '"url" is required: a website URL or domain, e.g. example.com' };
  let s = v.trim();
  if (s.length > 2048 || /[\s<>"`\\]/.test(s)) return { error: '"url" is not a valid URL' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u; try { u = new URL(s); } catch { return { error: '"url" is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'only http:// and https:// URLs can be audited' };
  return { url: u.href };
}

/** Free hosted preview. Returns the preview JSON or { error, message }. */
export async function preview(url, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 30000 } = {}) {
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview?url=${encodeURIComponent(url)}`, { headers: { accept: 'application/json', 'user-agent': 'agentready-npm' } }), ms, 'AgentReady preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `AgentReady preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
