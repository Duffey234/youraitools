import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, floorVersion, detectType, readPackageList, ManifestError } from '../src/manifest.js';
import { cvss3Score, ratingFromScore } from '../src/cvss.js';
import { scanPackages, UpstreamError } from '../src/scan.js';
import { queryBatch } from '../src/osv.js';
import { fakeOsv } from './helpers.js';

test('floorVersion: npm / pip ranges -> lowest allowed version, unresolvable -> null', () => {
  assert.equal(floorVersion('^4.17.0'), '4.17.0'); assert.equal(floorVersion('~1.2'), '1.2.0'); assert.equal(floorVersion('>=2 <3'), '2.0.0');
  assert.equal(floorVersion('1.x'), '1.0.0'); assert.equal(floorVersion('=1.2.3'), '1.2.3'); assert.equal(floorVersion('1.0.0-beta.1'), '1.0.0-beta.1');
  for (const s of ['*', 'latest', 'git+https://x/y.git', 'github:a/b', 'file:../x', '<2', '', 'workspace:*']) assert.equal(floorVersion(s), null, s);
});

test('package.json: deps + dev deps, exact = pinned, ranges = floor, unresolvable = unpinned; include_dev=false', () => {
  const m = JSON.stringify({ dependencies: { lodash: '^4.17.15', a: '1.2.3', x: 'latest' }, devDependencies: { jest: '29.0.0' } });
  const { type, packages } = parseManifest(m);
  assert.equal(type, 'package.json');
  assert.deepEqual(packages.map((p) => [p.name, p.version, p.pinned, !!p.dev]), [['lodash', '4.17.15', false, false], ['a', '1.2.3', true, false], ['x', null, false, false], ['jest', '29.0.0', true, true]]);
  assert.equal(parseManifest(m, { includeDev: false }).packages.length, 3);
});

test('package-lock.json v3 and v1', () => {
  const v3 = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.15' }, 'node_modules/a/node_modules/lodash': { version: '4.17.21' }, 'node_modules/jest': { version: '29.0.0', dev: true }, 'node_modules/l': { link: true } } });
  assert.deepEqual(parseManifest(v3).packages.map((p) => `${p.name}@${p.version}`), ['lodash@4.17.15', 'lodash@4.17.21', 'jest@29.0.0']);
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } });
  assert.deepEqual(parseManifest(v1).packages.map((p) => `${p.name}@${p.version}`), ['a@1.0.0', 'b@2.0.0']);
});

test('requirements.txt, go.mod, Cargo.lock, poetry.lock, composer.lock, Pipfile.lock', () => {
  const req = parseManifest('requests==2.19.0\nflask>=1.0  # web\nnumpy\n-r other.txt\nDjango[argon2]==3.0.0 ; python_version > "3"\ngit+https://x/y.git\n');
  assert.equal(req.type, 'requirements.txt');
  assert.deepEqual(req.packages.map((p) => [p.ecosystem, p.name, p.version, p.pinned]), [['PyPI', 'requests', '2.19.0', true], ['PyPI', 'flask', '1.0.0', false], ['PyPI', 'numpy', null, false], ['PyPI', 'Django', '3.0.0', true]]);
  const go = parseManifest('module example.com/x\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.6.0\n\tgolang.org/x/net v0.17.0 // indirect\n)\nrequire github.com/a/b v1.0.0\n');
  assert.deepEqual(go.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['Go:github.com/gin-gonic/gin@v1.6.0', 'Go:golang.org/x/net@v0.17.0', 'Go:github.com/a/b@v1.0.0']);
  const cargo = parseManifest('version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n');
  assert.equal(cargo.type, 'Cargo.lock'); assert.deepEqual(cargo.packages.map((p) => `${p.name}@${p.version}`), ['serde@1.0.0']);
  const poetry = parseManifest('[[package]]\nname = "requests"\nversion = "2.19.0"\ndescription = "x"\n\n[package.dependencies]\nidna = ">=2"\n\n[[package]]\nname = "idna"\nversion = "2.7"\n', { filename: 'poetry.lock' });
  assert.deepEqual(poetry.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['PyPI:requests@2.19.0', 'PyPI:idna@2.7']);
  const comp = parseManifest(JSON.stringify({ 'content-hash': 'x', packages: [{ name: 'guzzlehttp/guzzle', version: 'v6.0.0' }], 'packages-dev': [] }));
  assert.equal(comp.type, 'composer.lock'); assert.deepEqual(comp.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`), ['Packagist:guzzlehttp/guzzle@6.0.0']);
  const pip = parseManifest(JSON.stringify({ _meta: {}, default: { requests: { version: '==2.19.0' } }, develop: { pytest: { version: '==7.0.0' } } }));
  assert.equal(pip.type, 'Pipfile.lock'); assert.deepEqual(pip.packages.map((p) => `${p.name}@${p.version}`), ['requests@2.19.0', 'pytest@7.0.0']);
});

test('detection and errors', () => {
  assert.equal(detectType('{"name":"x","dependencies":{}}'), 'package.json');
  assert.equal(detectType('anything', 'sub/dir/requirements-dev.txt'), 'requirements.txt');
  assert.throws(() => parseManifest(''), ManifestError);
  assert.throws(() => parseManifest('{not json', { type: 'package.json' }), /not valid JSON/);
  assert.throws(() => parseManifest('{"foo": 1}'), /could not detect/);
});

test('readPackageList validates ecosystem, name, exact version and size', () => {
  assert.deepEqual(readPackageList([{ ecosystem: 'pypi', name: 'requests', version: '2.19.0' }], 5).packages[0], { ecosystem: 'PyPI', name: 'requests', version: '2.19.0', pinned: true, spec: '2.19.0' });
  assert.match(readPackageList([{ ecosystem: 'cobol', name: 'x', version: '1' }], 5).error, /ecosystem/);
  assert.match(readPackageList([{ name: 'x', version: '^1.0' }], 5).error, /exact version/);
  assert.match(readPackageList([{ name: '', version: '1.0.0' }], 5).error, /name/);
  assert.match(readPackageList(Array(6).fill({ name: 'x', version: '1.0.0' }), 5).error, /at most 5/);
  assert.match(readPackageList([], 5).error, /non-empty/);
});

test('CVSS v3.1 base score matches the FIRST calculator', () => {
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H'), 7.2);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N'), 0);
  assert.equal(cvss3Score('CVSS:4.0/AV:N'), null); assert.equal(cvss3Score(undefined), null);
  assert.deepEqual([9.8, 7.2, 5, 2, 0, null].map(ratingFromScore), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE', 'UNKNOWN']);
});

test('scanPackages full: malicious first, severities, fixed-in for this package only, unpinned listed, range note', async () => {
  const osv = fakeOsv();
  const r = await scanPackages([
    { ecosystem: 'npm', name: 'lodash', version: '4.17.15', pinned: false, spec: '^4.17.15' },
    { ecosystem: 'npm', name: 'flatmap-stream', version: '0.1.1', pinned: true },
    { ecosystem: 'npm', name: 'left-pad', version: '1.3.0', pinned: true },
    { ecosystem: 'npm', name: 'x', version: null, pinned: false, spec: 'latest' },
  ], { fetchImpl: osv.fetchImpl, now: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(r.verdict, 'malicious'); assert.equal(r.highest_severity, 'CRITICAL');
  assert.deepEqual([r.package_count, r.scanned_count, r.unpinned_count, r.vulnerable_count, r.malicious_count, r.advisory_count], [4, 3, 1, 2, 1, 3]);
  assert.equal(r.packages[0].name, 'flatmap-stream'); assert.equal(r.packages[0].malicious, true);
  const lo = r.packages[1];
  assert.equal(lo.version_source, 'range_floor'); assert.equal(lo.highest_severity, 'HIGH');
  assert.deepEqual(lo.vulns.map((v) => [v.id, v.severity, v.cvss_score, v.fixed_in.join()]), [['GHSA-35jh-r3h4-6jhm', 'HIGH', 7.2, '4.17.21'], ['GHSA-29mw-wpgm-hmr9', 'MEDIUM', 5.3, '4.17.21']]);
  assert.deepEqual(r.by_severity, { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0, UNKNOWN: 0 });
  assert.equal(r.unpinned[0].name, 'x'); assert.ok(r.range_note && r.unpinned_note);
  assert.equal(r.scanned_at, '2026-10-21T00:00:00.000Z'); assert.equal(r.source.name, 'OSV.dev');
  // one batch query (unpinned not sent) + one detail fetch per unique advisory
  assert.equal(osv.calls[0].body.queries.length, 3);
  assert.equal(osv.calls.filter((c) => c.url.includes('/vulns/')).length, 3);
});

test('scanPackages preview: counts only, no ids or package names, no detail fetches', async () => {
  const osv = fakeOsv();
  const r = await scanPackages([{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }, { ecosystem: 'PyPI', name: 'requests', version: '2.19.0' }], { tier: 'preview', fetchImpl: osv.fetchImpl });
  assert.equal(r.verdict, 'vulnerable'); assert.equal(r.vulnerable_count, 2); assert.equal(r.advisory_count, 3);
  assert.ok(!JSON.stringify(r).includes('GHSA') && !JSON.stringify(r).includes('lodash'));
  assert.equal(osv.calls.length, 1);
});

test('OSV down / 500 -> UpstreamError; clean scan of nothing makes no call', async () => {
  for (const mode of ['down', 'http500']) await assert.rejects(scanPackages([{ ecosystem: 'npm', name: 'a', version: '1.0.0' }], { fetchImpl: fakeOsv(mode).fetchImpl }), UpstreamError);
  await assert.rejects(queryBatch([{ ecosystem: 'npm', name: 'a', version: '1.0.0' }], { fetchImpl: fakeOsv('slow').fetchImpl, ms: 50 }), UpstreamError);
  const osv = fakeOsv(); const r = await scanPackages([{ ecosystem: 'npm', name: 'x', version: null }], { fetchImpl: osv.fetchImpl });
  assert.equal(r.verdict, 'clean'); assert.equal(osv.calls.length, 0);
});
