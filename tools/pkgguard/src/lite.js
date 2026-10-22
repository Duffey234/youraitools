// PkgGuard client used by the npm package (library + stdio MCP server). Free tier: the hosted preview
// (verdict + counts, up to 25 packages, 10/min per IP). Full results: paid API over x402 (see paid.js).
// Manifests are parsed locally; only {ecosystem, name, version} triples are sent.
import { parseManifest, readPackageList, ECOSYSTEMS, MANIFEST_TYPES, ManifestError } from './manifest.js';
import { withDeadline } from './deadline.js';

export { parseManifest, ECOSYSTEMS, MANIFEST_TYPES };
export const API_BASE = 'https://api.youraitools.co/pkgguard';
export const FALLBACK_API_BASE = 'https://pkgguard.agentgate.workers.dev';
export const PAID_SCAN_URL = `${API_BASE}/v1/scan`;
export const PAID_PACKAGE_URL = `${API_BASE}/v1/package`;
export const PREVIEW_MAX = 25;
export const MAX_PACKAGES = 500;
export const DISCLAIMER = 'Informational: lists published advisories from OSV.dev for the versions given. Not a security audit; a clean result does not prove a package is safe.';
export const FULL_DETAILS = `Which packages, advisory ids (CVE/GHSA/MAL), severity, CVSS and fixed-in versions: paid API ${PAID_SCAN_URL} ($0.003 USDC on Base per scan over x402) or ${PAID_PACKAGE_URL} ($0.001 per package).`;

/** Turn tool/library arguments into a package list: {manifest, filename, type, include_dev} | {packages} | {ecosystem,name,version}. */
export function toPackages(args = {}, max = MAX_PACKAGES) {
  try {
    if (args.packages !== undefined) { const r = readPackageList(args.packages, max); return r.error ? { error: r.error } : { packages: r.packages }; }
    if (args.manifest !== undefined) {
      const r = parseManifest(args.manifest, { filename: args.filename, type: args.type, includeDev: args.include_dev !== false });
      if (!r.packages.length) return { error: `no dependencies found in the ${r.type}` };
      if (r.packages.length > max) return { error: `${r.packages.length} packages found; at most ${max} per call` };
      return { packages: r.packages, type: r.type };
    }
    if (args.name !== undefined) {
      if (!args.version) return { error: '"version" (exact version) is required' };
      const r = readPackageList([{ ecosystem: args.ecosystem || 'npm', name: args.name, version: args.version }], 1);
      return r.error ? { error: r.error.replace('packages[0].', '') } : { packages: r.packages, single: true };
    }
    return { error: 'provide "manifest" (file contents), "packages" ([{ecosystem,name,version}]) or "name" + "version"' };
  } catch (e) { if (e instanceof ManifestError) return { error: e.message }; throw e; }
}

/** Free hosted preview for a package list (<= 25). Returns the preview JSON or { error }. */
export async function preview(packages, { fetchImpl = globalThis.fetch, apiBase = API_BASE, ms = 15000 } = {}) {
  if (packages.length > PREVIEW_MAX) return { error: 'too_many', message: `The free preview takes at most ${PREVIEW_MAX} packages (got ${packages.length}). Use paid mode (PKGGUARD_X402_PRIVATE_KEY) for up to ${MAX_PACKAGES}.` };
  try {
    const res = await withDeadline(fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'pkgguard-npm' }, body: JSON.stringify({ packages: packages.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })) }) }), ms, 'PkgGuard preview');
    const j = await res.json().catch(() => null);
    if (!res.ok) return { error: j?.error || `http_${res.status}`, message: j?.message || `PkgGuard preview answered HTTP ${res.status}` };
    return j;
  } catch (e) { return { error: 'network', message: String(e?.message || e).slice(0, 200) }; }
}
