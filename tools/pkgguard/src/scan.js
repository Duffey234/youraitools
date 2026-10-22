// PkgGuard scan engine: known vulnerabilities (CVE/GHSA/PYSEC/GO/RUSTSEC...) and confirmed-malicious packages (OpenSSF
// MAL-*) for a dependency list, from OSV.dev. Inputs are never stored.
import { queryBatch, vulnDetails, OSV_LIMITS, UpstreamError } from './osv.js';
import { cvss3Score, ratingFromScore, RANK } from './cvss.js';
import { VERSION_STR } from './version.js';

export const ENGINE_VERSION = `pkgguard-${VERSION_STR}`;
export const MAX_PACKAGES = 500;
export const PREVIEW_MAX_PACKAGES = 25;
export const SOURCE = { name: 'OSV.dev', url: 'https://osv.dev', license: 'CC-BY 4.0 (OSV.dev); per-advisory sources: GitHub Advisory Database, PyPA, Go, RustSec, OpenSSF Malicious Packages and others' };
export const DISCLAIMER = 'Informational: lists published advisories from OSV.dev for the versions given. Not a security audit; a clean result does not prove a package is safe.';
export { UpstreamError };

export const isMalicious = (id) => /^MAL-/.test(id);
const maliciousAdvisory = (id, v) => isMalicious(id) || (!!v && (/^malicious (package|code)\b/i.test(String(v.summary || '')) || (v.database_specific?.cwe_ids || []).includes('CWE-506')));
const sevOf = (v) => {
  if (!v) return { severity: 'UNKNOWN', cvss_score: null, cvss_vector: null };
  if (isMalicious(v.id)) return { severity: 'CRITICAL', cvss_score: null, cvss_vector: null };
  const vec = (v.severity || []).find((s) => s.type === 'CVSS_V3')?.score || null;
  const v4 = (v.severity || []).find((s) => s.type === 'CVSS_V4')?.score || null;
  const score = cvss3Score(vec);
  let rating = String(v.database_specific?.severity || '').toUpperCase().replace('MODERATE', 'MEDIUM');
  if (!RANK[rating] || rating === 'UNKNOWN') rating = score != null ? ratingFromScore(score) : 'UNKNOWN';
  return { severity: rating, cvss_score: score, cvss_vector: vec || v4 };
};
const fixedFor = (v, p) => {
  const fixed = new Set();
  for (const a of v?.affected || []) {
    if (a?.package?.ecosystem !== p.ecosystem) continue;
    const n = a.package.name; if (!(n === p.name || (p.ecosystem === 'PyPI' && n.toLowerCase().replace(/[-_.]+/g, '-') === p.name.toLowerCase().replace(/[-_.]+/g, '-')))) continue;
    for (const r of a.ranges || []) for (const e of r.events || []) if (e.fixed) fixed.add(e.fixed);
  }
  return [...fixed].slice(0, 6);
};
const worst = (list) => list.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'NONE');

/**
 * Scan packages ([{ecosystem,name,version,pinned,spec}]). tier 'full' fetches advisory details; 'preview' only counts.
 * Throws UpstreamError when OSV is unreachable (callers answer 502/503, which is never settled).
 */
export async function scanPackages(pkgs, { tier = 'full', fetchImpl, now = Date.now(), manifestType = null } = {}) {
  const queryable = pkgs.filter((p) => p.version);
  const unpinned = pkgs.filter((p) => !p.version);
  const hits = await queryBatch(queryable, { fetchImpl });
  const flagged = queryable.map((p, i) => ({ p, ...hits[i] })).filter((x) => x.ids.length);
  const allIds = [...new Set(flagged.flatMap((x) => x.ids))];
  const malicious = flagged.filter((x) => x.ids.some(isMalicious));
  const base = {
    tier, ...(manifestType ? { manifest_type: manifestType } : {}),
    package_count: pkgs.length, scanned_count: queryable.length, unpinned_count: unpinned.length,
    vulnerable_count: flagged.length, malicious_count: malicious.length, advisory_count: allIds.length,
  };
  if (tier === 'preview') {
    return { ...base, verdict: malicious.length ? 'malicious' : flagged.length ? 'vulnerable' : 'clean', source: SOURCE.name, scanned_at: new Date(now).toISOString(), disclaimer: DISCLAIMER, engine: ENGINE_VERSION };
  }
  // full: details for malicious first, then the rest, capped
  const ordered = [...allIds.filter(isMalicious), ...allIds.filter((id) => !isMalicious(id))];
  const details = await vulnDetails(ordered, { fetchImpl });
  const packages = flagged.map(({ p, ids, more }) => {
    const vulns = ids.map((id) => {
      const v = details.get(id);
      return {
        id, malicious: maliciousAdvisory(id, v), ...sevOf(v ?? (isMalicious(id) ? { id } : null)),
        summary: v ? String(v.summary || v.details || '').split('\n')[0].slice(0, 200) || null : null,
        aliases: v?.aliases?.slice(0, 6) || [], fixed_in: v ? fixedFor(v, p) : [],
        published: v?.published || null, url: `https://osv.dev/vulnerability/${id}`,
        ...(v || isMalicious(id) ? {} : { details_truncated: true }),
      };
    }).sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));
    return {
      ecosystem: p.ecosystem, name: p.name, version: p.version, version_source: p.pinned ? 'exact' : 'range_floor', ...(p.spec && !p.pinned ? { spec: p.spec } : {}), ...(p.dev ? { dev: true } : {}),
      malicious: vulns.some((v) => v.malicious), highest_severity: worst(vulns.map((v) => v.severity)), vuln_count: vulns.length, ...(more ? { more_advisories: true } : {}), vulns,
    };
  }).sort((a, b) => Number(b.malicious) - Number(a.malicious) || RANK[b.highest_severity] - RANK[a.highest_severity] || a.name.localeCompare(b.name));
  const malCount = packages.filter((p) => p.malicious).length;
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const id of allIds) { const s = sevOf(details.get(id) ?? (isMalicious(id) ? { id } : null)).severity; if (s in sevCounts) sevCounts[s]++; }
  return {
    ...base, malicious_count: malCount, verdict: malCount ? 'malicious' : flagged.length ? 'vulnerable' : 'clean',
    highest_severity: worst(packages.map((p) => p.highest_severity)), by_severity: sevCounts, packages,
    ...(unpinned.length ? { unpinned: unpinned.slice(0, 100).map((p) => ({ ecosystem: p.ecosystem, name: p.name, spec: p.spec })), unpinned_note: 'Not scanned: no exact or minimum version. Scan a lockfile for exact results.' } : {}),
    ...(pkgs.some((p) => p.version && !p.pinned) ? { range_note: 'For version ranges (e.g. ^4.17.0) the lowest allowed version was scanned; your installed version may be newer. Scan the lockfile for exact results.' } : {}),
    ...(allIds.length > OSV_LIMITS.maxDetails ? { details_truncated: true, details_note: `Advisory details are included for the first ${OSV_LIMITS.maxDetails} advisories (malicious first); the rest list id and link only.` } : {}),
    source: SOURCE, scanned_at: new Date(now).toISOString(), disclaimer: DISCLAIMER, engine: ENGINE_VERSION,
  };
}
