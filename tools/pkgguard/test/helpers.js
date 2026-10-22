import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://pkgguard.example.com';

// Fixture OSV.dev (shapes copied from the live API, trimmed)
export const VULNS = {
  'GHSA-35jh-r3h4-6jhm': { id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', aliases: ['CVE-2021-23337'], published: '2021-05-06T16:05:51Z', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }], database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }, { package: { name: 'lodash-es', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.99' }] }] }] },
  'GHSA-29mw-wpgm-hmr9': { id: 'GHSA-29mw-wpgm-hmr9', summary: 'ReDoS in lodash', aliases: ['CVE-2020-28500'], severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }], database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }] }] },
  'MAL-2025-20690': { id: 'MAL-2025-20690', summary: 'Malicious code in flatmap-stream (npm)', affected: [{ package: { name: 'flatmap-stream', ecosystem: 'npm' } }] },
  'PYSEC-2018-28': { id: 'PYSEC-2018-28', summary: 'requests sends credentials over HTTP on redirect', aliases: ['CVE-2018-18074'], severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }], affected: [{ package: { name: 'requests', ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.20.0' }] }] }] },
};
const HITS = { 'npm/lodash/4.17.15': ['GHSA-29mw-wpgm-hmr9', 'GHSA-35jh-r3h4-6jhm'], 'npm/flatmap-stream/0.1.1': ['MAL-2025-20690'], 'PyPI/requests/2.19.0': ['PYSEC-2018-28'] };

/** Fake OSV fetch: { fetchImpl, calls }. mode 'down' throws, 'http500' answers 500, 'slow' never answers. */
export function fakeOsv(mode = 'ok') {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input); calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    if (mode === 'down') throw new Error('connect ECONNREFUSED');
    if (mode === 'http500') return new Response('oops', { status: 500 });
    if (mode === 'slow') return new Promise(() => {});
    if (url.endsWith('/v1/querybatch')) {
      const { queries } = JSON.parse(init.body);
      return Response.json({ results: queries.map((q) => { const ids = HITS[`${q.package.ecosystem}/${q.package.name}/${q.version}`]; return ids ? { vulns: ids.map((id) => ({ id, modified: '2026-10-17T00:00:00Z' })) } : {}; }) });
    }
    const m = url.match(/\/v1\/vulns\/(.+)$/);
    if (m && VULNS[decodeURIComponent(m[1])]) return Response.json(VULNS[decodeURIComponent(m[1])]);
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

export function fakeFacilitator() {
  const f = { verified: [], settled: [],
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); const a = payload?.payload?.authorization; return a && a.to.toLowerCase() === req.payTo.toLowerCase() && String(a.value) === String(req.amount) ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'fake_invalid' }; },
    async settle(payload, req) { f.settled.push(req); return { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from }; },
  };
  return f;
}
export function memKv() { const m = new Map(); return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; }

export async function makeApp({ limiter, v1FetchImpl, osv = fakeOsv(), appOpts = {} } = {}) {
  const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, osvFetch: osv.fetchImpl, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, osv };
}
