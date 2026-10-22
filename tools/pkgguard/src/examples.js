// Example inputs/outputs used in the Bazaar discovery declaration, OpenAPI and landing page.
export const EXAMPLE_PACKAGES = [{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }, { ecosystem: 'npm', name: 'flatmap-stream', version: '0.1.1' }, { ecosystem: 'PyPI', name: 'requests', version: '2.31.0' }];
export const EXAMPLE_MANIFEST = JSON.stringify({ name: 'demo', dependencies: { lodash: '4.17.15', 'flatmap-stream': '0.1.1', express: '^4.18.2' } });
export const PACKAGE_EXAMPLE = {
  tier: 'full', package_count: 1, scanned_count: 1, unpinned_count: 0, vulnerable_count: 1, malicious_count: 0, advisory_count: 6, verdict: 'vulnerable', highest_severity: 'HIGH',
  packages: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.15', version_source: 'exact', malicious: false, highest_severity: 'HIGH', vuln_count: 6,
    vulns: [{ id: 'GHSA-35jh-r3h4-6jhm', malicious: false, severity: 'HIGH', cvss_score: 7.2, summary: 'Command Injection in lodash', aliases: ['CVE-2021-23337'], fixed_in: ['4.17.21'], url: 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm' }] }],
  source: { name: 'OSV.dev' }, disclaimer: 'Informational: lists published advisories from OSV.dev for the versions given.',
};
export const SCAN_EXAMPLE = {
  tier: 'full', manifest_type: 'package.json', package_count: 3, scanned_count: 3, unpinned_count: 0, vulnerable_count: 2, malicious_count: 1, advisory_count: 9, verdict: 'malicious', highest_severity: 'CRITICAL',
  by_severity: { CRITICAL: 3, HIGH: 3, MEDIUM: 3, LOW: 0, UNKNOWN: 0 },
  packages: [{ ecosystem: 'npm', name: 'flatmap-stream', version: '0.1.1', version_source: 'exact', malicious: true, highest_severity: 'CRITICAL', vuln_count: 3,
    vulns: [{ id: 'MAL-2025-20690', malicious: true, severity: 'CRITICAL', summary: 'Malicious code in flatmap-stream (npm)', fixed_in: [], url: 'https://osv.dev/vulnerability/MAL-2025-20690' }] }],
  range_note: 'For version ranges (e.g. ^4.17.0) the lowest allowed version was scanned.', source: { name: 'OSV.dev' },
};
