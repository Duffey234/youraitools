// OSV.dev client (https://google.github.io/osv.dev/api/): free public API, no key. Data: OSV.dev, CC-BY 4.0.
// Hard timeouts on every call; vulnerability details are edge-cached by Cloudflare (cf.cacheTtl) and capped per scan
// so a scan stays inside the Workers free-plan subrequest limit (50).
import { withDeadline } from './deadline.js';

export const OSV_API = 'https://api.osv.dev/v1';
export const OSV_LIMITS = { batchMs: 7000, detailMs: 4500, maxDetails: 40, concurrency: 8, maxQueries: 1000 };
export class UpstreamError extends Error { constructor(m) { super(m); this.name = 'UpstreamError'; this.code = 'upstream_unavailable'; } }

const UA = { 'user-agent': 'PkgGuard/0.1 (+https://api.youraitools.co/pkgguard; hello@youraitools.co)' };

/** POST /v1/querybatch. Returns one array of vuln ids per input package (same order). */
export async function queryBatch(pkgs, { fetchImpl = globalThis.fetch, ms = OSV_LIMITS.batchMs } = {}) {
  if (!pkgs.length) return [];
  const queries = pkgs.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }));
  let res;
  try {
    res = await withDeadline(fetchImpl(`${OSV_API}/querybatch`, { method: 'POST', headers: { ...UA, 'content-type': 'application/json' }, body: JSON.stringify({ queries }) }), ms, 'OSV querybatch');
  } catch (e) { throw new UpstreamError(`OSV query failed: ${e.message}`); }
  if (!res.ok) throw new UpstreamError(`OSV query answered HTTP ${res.status}`);
  let j; try { j = await withDeadline(res.json(), ms, 'OSV querybatch body'); } catch (e) { throw new UpstreamError(`OSV query: ${e.message}`); }
  const results = Array.isArray(j?.results) ? j.results : null;
  if (!results || results.length !== pkgs.length) throw new UpstreamError('OSV query returned an unexpected shape');
  return results.map((r) => ({ ids: (r?.vulns || []).map((v) => v.id).filter((id) => typeof id === 'string'), more: !!r?.next_page_token }));
}

/** GET /v1/vulns/{id} for up to maxDetails ids (concurrency-limited). Missing/failed ids map to null. */
export async function vulnDetails(ids, { fetchImpl = globalThis.fetch, ms = OSV_LIMITS.detailMs, max = OSV_LIMITS.maxDetails, concurrency = OSV_LIMITS.concurrency } = {}) {
  const want = ids.slice(0, max); const out = new Map(); let i = 0;
  const one = async (id) => {
    try {
      const res = await withDeadline(fetchImpl(`${OSV_API}/vulns/${encodeURIComponent(id)}`, { headers: UA, cf: { cacheTtl: 21600, cacheEverything: true } }), ms, `OSV ${id}`);
      if (!res.ok) return null;
      return await withDeadline(res.json(), ms, `OSV ${id} body`);
    } catch { return null; }
  };
  const worker = async () => { while (i < want.length) { const id = want[i++]; out.set(id, await one(id)); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, want.length) }, worker));
  return out;
}
