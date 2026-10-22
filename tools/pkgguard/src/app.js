// PkgGuard: dependency vulnerability + malicious package scan for AI agents and CI, paid per call over x402 (USDC on Base).
//   POST     /v1/scan {manifest | packages}  PAID $0.003  up to 500 packages: advisories (CVE/GHSA/...), severity, CVSS, fixed-in, malicious
//   GET|POST /v1/package?ecosystem=&name=&version=  PAID $0.001  one package
//   GET|POST /v1/preview                    free  verdict + counts only (no advisory ids), up to 25 packages, 10/min per IP
//   POST /mcp                               free  remote MCP (Streamable HTTP, stateless JSON): scan_dependencies, check_package (preview tier)
//   GET  /v1/ecosystems  /v1/stats  /health  /  /openapi.json  /.well-known/x402   free
// Data: OSV.dev (free public API). Inputs are validated before the 402, so malformed input is never charged;
// an OSV outage answers 503, which is never settled.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { x402ResourceServer } from '@x402/hono';
import { paymentMiddleware } from './credits-gate.js'; // @x402/hono paymentMiddleware + prepaid credits keys (no key: unchanged x402)
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { multiNetworkRoutes, registerNetworks, supportedKinds, discoveryNetworks, networkStats } from './networks.js';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { ROUTE_META } from './service-meta.js';
import { ResilientFacilitatorClient } from './facilitator.js';
import { selectFacilitator } from './facilitator-select.js';
import { DEFAULTS } from './config.js';
import { Stats, paidRouteStats, isSmoke, waitUntilOf } from './stats.js';
import { x402v1 } from './x402v1.js';
import { prefersHtml, landingHtml } from './landing.js';
import { openapiDoc, wellKnownX402, LOGO_SVG } from './discovery.js';
import { scanPackages, UpstreamError, DISCLAIMER, SOURCE, MAX_PACKAGES, PREVIEW_MAX_PACKAGES, ENGINE_VERSION } from './scan.js';
import { parseManifest, readPackageList, normalizeEcosystem, ManifestError, ECOSYSTEMS, MANIFEST_TYPES } from './manifest.js';
import { withDeadline, BUDGET } from './deadline.js';
import { EXAMPLE_PACKAGES, EXAMPLE_MANIFEST, PACKAGE_EXAMPLE, SCAN_EXAMPLE } from './examples.js';
import { VERSION_STR } from './version.js';

export const SCAN_PATH = '/v1/scan';
export const SCAN_USAGE = { method: 'POST', message: 'GET only shows the price. To scan, POST a JSON body {"manifest": "<file contents>", "filename": "package.json"} or {"packages": [{"ecosystem": "npm", "name": "lodash", "version": "4.17.15"}]} with an x402 payment.', single_package: 'GET /v1/package?ecosystem=npm&name=lodash&version=4.17.15 ($0.001)' };
export const PACKAGE_PATH = '/v1/package';
export const PREVIEW_PATH = '/v1/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const ECOSYSTEMS_PATH = '/v1/ecosystems';
export const VERSION = VERSION_STR;
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-pkgguard/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/pkgguard';
export const ALL_TOOLS_URL = 'https://youraitools.co/built-by-us';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const SCAN_DESCRIPTION = `Dependency security scan for agents and CI: send a package.json, lockfile, requirements.txt, go.mod, Cargo.lock, poetry.lock or composer.lock (or a package list, up to ${MAX_PACKAGES}). Returns known vulnerabilities (CVE/GHSA ids, severity, CVSS, fixed-in versions) and confirmed-malicious packages per dependency, from OSV.dev.`;
export const PACKAGE_DESCRIPTION = 'Is this package version safe to install? Known vulnerabilities (CVE/GHSA ids, severity, CVSS score, fixed-in versions) and malicious-package flags for one npm, PyPI, Go, crates.io, Packagist, RubyGems, Maven or NuGet package version, from OSV.dev.';
const SCAN_Q = { properties: { manifest: { type: 'string', description: `Manifest or lockfile contents (${MANIFEST_TYPES.join(', ')})` }, filename: { type: 'string', description: 'Optional file name, helps type detection' }, packages: { type: 'array', items: { type: 'object' }, description: `Alternative to manifest: [{ecosystem, name, version}], up to ${MAX_PACKAGES}` }, include_dev: { type: 'boolean', description: 'Include devDependencies (default true)' } } };
const PKG_Q = { properties: { ecosystem: { type: 'string', description: `One of ${ECOSYSTEMS.join(', ')} (default npm)` }, name: { type: 'string', description: 'Package name, e.g. lodash' }, version: { type: 'string', description: 'Exact version, e.g. 4.17.15' } }, required: ['name', 'version'] };

export function routesConfig({ priceScan, pricePackage, network, payTo, publicUrl }) {
  const pub = (path) => (publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${path}` } : {});
  const acc = (price) => ({ scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 });
  const s = { ...pub(SCAN_PATH), accepts: acc(priceScan), description: SCAN_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  const p = { ...pub(PACKAGE_PATH), accepts: acc(pricePackage), description: PACKAGE_DESCRIPTION, mimeType: 'application/json', ...ROUTE_META };
  const pkgIn = { ecosystem: 'npm', name: 'lodash', version: '4.17.15' };
  return {
    [`POST ${SCAN_PATH}`]: { ...s, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: { manifest: EXAMPLE_MANIFEST, filename: 'package.json' }, inputSchema: SCAN_Q, output: { example: SCAN_EXAMPLE } }) } },
    // GET /v1/scan only advertises the price (directory checkers probe with GET); a paid GET gets a 400 and is never settled.
    [`GET ${SCAN_PATH}`]: { ...s },
    [`GET ${PACKAGE_PATH}`]: { ...p, extensions: { ...declareDiscoveryExtension({ input: pkgIn, inputSchema: PKG_Q, output: { example: PACKAGE_EXAMPLE } }) } },
    [`POST ${PACKAGE_PATH}`]: { ...p, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: pkgIn, inputSchema: PKG_Q, output: { example: PACKAGE_EXAMPLE } }) } },
  };
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400) => c.json({ error: 'bad_request', message }, status);
const atomic = (price) => String(Math.round(Number(String(price).replace('$', '')) * 1e6));

/** A JSON body that is itself a manifest file (not a {manifest}/{packages}/{name,version} request). */
export function isRawManifest(body) {
  if (body.manifest !== undefined || Array.isArray(body.packages)) return false;
  return ['lockfileVersion', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', '_meta', 'content-hash', 'packages'].some((k) => body[k] !== undefined);
}

/** Parse a scan input object ({manifest, filename, type, include_dev} | {packages}) into a package list. */
export function readScanInput(body, max = MAX_PACKAGES) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object {"manifest": "<file contents>"} or {"packages": [...]}' };
  if (body.packages !== undefined) { const r = readPackageList(body.packages, max); return r.error ? r : { packages: r.packages, type: null }; }
  if (body.manifest === undefined) return { error: '"manifest" (file contents as a string) or "packages" ([{ecosystem, name, version}]) is required' };
  let r;
  try { r = parseManifest(body.manifest, { filename: body.filename, type: body.type, includeDev: body.include_dev !== false }); } catch (e) { if (e instanceof ManifestError) return { error: e.message }; throw e; }
  if (!r.packages.length) return { error: `no dependencies found in the ${r.type}` };
  if (r.packages.length > max) return { error: `${r.packages.length} packages found; at most ${max} per call (split the file, or pass "packages")` };
  return { packages: r.packages, type: r.type };
}
/** Parse a single-package input ({ecosystem, name, version}). */
export function readPackageInput(o) {
  if (!o || typeof o !== 'object') return { error: '{ecosystem, name, version} is required' };
  if (!o.version) return { error: '"version" (exact version, e.g. 4.17.15) is required' };
  const r = readPackageList([{ ecosystem: o.ecosystem || 'npm', name: o.name, version: o.version }], 1);
  return r.error ? { error: r.error.replace('packages[0].', '') } : { packages: r.packages, type: null };
}

/**
 * @param {object} [opts] payTo, priceScan, pricePackage, network, facilitatorUrl, publicUrl, facilitatorClient (tests),
 *   statsKv, stats, freeLimiter, v1FetchImpl, osvFetch (tests), staticSupported, syncFacilitatorOnStart, now (tests), cdpDeps
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const stats = opts.stats || new Stats(opts.statsKv);
  const fac = selectFacilitator(cfg, opts.cdpDeps);
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme); // extra networks from networks.js (Base registered above, unchanged)
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };
  const now = () => (opts.now ? opts.now() : Date.now());
  const osvFetch = opts.osvFetch || ((...a) => globalThis.fetch(...a));
  const run = (pkgs, tier, type) => withDeadline(scanPackages(pkgs, { tier, fetchImpl: osvFetch, now: now(), manifestType: type }), BUDGET.workMs - 1000, 'scan');
  const upstreamFail = (c, e) => { console.warn(`pkgguard: upstream: ${e?.message}`); c.header('Retry-After', '10'); return c.json({ error: 'upstream_unavailable', message: 'The vulnerability database (OSV.dev) did not answer in time. Not charged; please retry.' }, 503); };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'PkgGuard',
    description: 'Dependency security scan for AI agents and CI: known vulnerabilities and confirmed-malicious packages for a manifest, lockfile or single package, from OSV.dev. Paid per call over x402; free preview and remote MCP.',
    paid: [
      { methods: ['POST'], path: SCAN_PATH, param: 'manifest | packages', max: MAX_PACKAGES, price: cfg.priceScan, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
      { methods: ['GET', 'POST'], path: PACKAGE_PATH, param: 'ecosystem, name, version', price: cfg.pricePackage, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url, x402: ['v2', 'v1'] },
    ],
    free: ['/health', PREVIEW_PATH, MCP_PATH, ECOSYSTEMS_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { methods: ['GET', 'POST'], path: PREVIEW_PATH, limit: `10 requests/min per IP, up to ${PREVIEW_MAX_PACKAGES} packages`, returns: 'verdict (clean / vulnerable / malicious) and counts; no advisory ids, severities or fixed-in versions' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['scan_dependencies', 'check_package'], limit: '10 tool calls/min per IP (preview tier)' },
    },
    ecosystems: ECOSYSTEMS, manifests: MANIFEST_TYPES,
    data: { source: SOURCE.name, source_url: SOURCE.url, license: SOURCE.license, freshness: 'live query per call (advisory details edge-cached up to 6 h)', engine: ENGINE_VERSION },
    policy: { storage: 'inputs are not stored or logged', charging: 'only HTTP 200 results are settled; invalid input and upstream outages are free', network: 'package names and versions are sent to OSV.dev; nothing else leaves the Worker' },
    disclaimer: DISCLAIMER,
    source: SOURCE_URL, allTools: ALL_TOOLS_URL, npm: NPM_URL,
    endpoint: origin(c),
  });
  app.get('/', (c) => {
    c.header('Vary', 'Accept');
    if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) }));
    return c.json(info(c));
  });
  app.get('/health', (c) => c.json({ ok: true, engine: ENGINE_VERSION }));
  const disc = (c) => ({ origin: origin(c), priceScan: cfg.priceScan, pricePackage: cfg.pricePackage, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get(STATS_PATH, async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });
  app.get(ECOSYSTEMS_PATH, (c) => { c.header('Cache-Control', 'public, max-age=3600'); return c.json({ ecosystems: ECOSYSTEMS, manifests: MANIFEST_TYPES, max_packages: MAX_PACKAGES, preview_max_packages: PREVIEW_MAX_PACKAGES, source: SOURCE }); });

  // ---- input parsing ----
  async function readBody(c) {
    const len = Number(c.req.header('content-length') || 0);
    if (len > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; scan a smaller file or pass "packages"`, 413] };
    const raw = await c.req.text(); // cached by Hono, safe to read again
    if (raw.length > cfg.maxBodyBytes) return { error: [`body larger than ${cfg.maxBodyBytes} bytes; scan a smaller file or pass "packages"`, 413] };
    if (!raw.trim()) return { empty: true, error: ['a JSON body is required'] };
    let body;
    if ((c.req.header('content-type') || '').includes('application/json') || /^\s*\{\s*"(manifest|packages|filename|type|include_dev|ecosystem|name|version)"/.test(raw)) {
      try { body = JSON.parse(raw); } catch { return { error: ['body must be JSON: {"manifest": "..."} or {"packages": [...]}'] }; }
    } else body = { manifest: raw }; // raw file upload (e.g. --data-binary @package-lock.json)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: ['body must be a JSON object'] };
    if (!Object.keys(body).length) return { empty: true, error: ['a JSON body {"manifest": ...} or {"packages": [...]} is required'] }; // {} = discovery probe: answer with the 402 terms
    if (isRawManifest(body)) body = { manifest: raw }; // raw package.json / package-lock.json / Pipfile.lock / composer.lock upload
    return { body };
  }
  async function readScan(c, max = MAX_PACKAGES) {
    if (c.req.method !== 'POST') return { error: ['POST a JSON body {"manifest": "<file contents>"} or {"packages": [...]}', 405] };
    const p = await readBody(c); if (p.error) return p;
    const r = readScanInput(p.body, max);
    return r.error ? { error: [r.error] } : { value: r };
  }
  async function readPackage(c) {
    let o;
    if (c.req.method === 'POST') { const p = await readBody(c); if (p.error) return p; o = p.body; }
    else {
      const q = c.req.query();
      if (!q.name && !q.version && !q.ecosystem) return { empty: true, error: ['?ecosystem=&name=&version= is required'] };
      o = q;
    }
    const r = readPackageInput(o);
    return r.error ? { error: [r.error] } : { value: r };
  }

  // ---- free preview ----
  const preview = async (c) => {
    if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `The free preview is limited per IP per minute. Unlimited: ${origin(c)}${SCAN_PATH} (x402, USDC on Base)` }, 429); }
    let p;
    if (c.req.method === 'GET') p = await readPackage(c);
    else { const b = await readBody(c); if (b.error) return bad(c, ...b.error); const isPkg = b.body.name !== undefined && b.body.manifest === undefined && b.body.packages === undefined; const r = isPkg ? readPackageInput(b.body) : readScanInput(b.body, PREVIEW_MAX_PACKAGES); p = r.error ? { error: [r.error.replace(`at most ${PREVIEW_MAX_PACKAGES}`, `the free preview takes at most ${PREVIEW_MAX_PACKAGES}`)] } : { value: r }; }
    if (p.error) return bad(c, ...p.error);
    let r; try { r = await run(p.value.packages, 'preview', p.value.type); } catch (e) { return upstreamFail(c, e); }
    count(c, 'free_preview');
    return c.json({ ...r, full: { url: `${origin(c)}${p.value.packages.length === 1 && !p.value.type ? PACKAGE_PATH : SCAN_PATH}`, price: `${p.value.packages.length === 1 && !p.value.type ? cfg.pricePackage : cfg.priceScan} USDC on Base (x402)`, adds: 'which packages are affected, advisory ids (CVE/GHSA/MAL), severity and CVSS, fixed-in versions, malicious-package flags, unpinned list' } });
  };
  app.get(PREVIEW_PATH, preview); app.post(PREVIEW_PATH, preview);

  // ---- remote MCP (stateless JSON-RPC over Streamable HTTP) ----
  const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };
  const TOOLS = [
    { name: 'scan_dependencies', title: 'Scan a dependency manifest for vulnerable and malicious packages', description: `Checks a package.json, lockfile, requirements.txt, go.mod, Cargo.lock, poetry.lock or composer.lock (or a list of packages) against OSV.dev for known vulnerabilities and confirmed-malicious packages. Free preview tier: verdict and counts, up to ${PREVIEW_MAX_PACKAGES} packages. The paid x402 endpoint /v1/scan adds per-package advisory ids, severity, CVSS and fixed-in versions (up to ${MAX_PACKAGES} packages).`, inputSchema: { type: 'object', properties: SCAN_Q.properties }, annotations: RO },
    { name: 'check_package', title: 'Is this package version vulnerable or malicious?', description: 'Checks one package version (npm, PyPI, Go, crates.io, Packagist, RubyGems, Maven, NuGet) against OSV.dev. Free preview tier: verdict and advisory count. The paid x402 endpoint /v1/package adds advisory ids, severity, CVSS and fixed-in versions.', inputSchema: { type: 'object', properties: PKG_Q.properties, required: ['name', 'version'] }, annotations: RO },
  ];
  app.get(MCP_PATH, (c) => c.json({ error: 'method_not_allowed', message: 'POST JSON-RPC (MCP Streamable HTTP, stateless).' }, 405, { Allow: 'POST' }));
  app.post(MCP_PATH, async (c) => {
    let msg; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const batch = Array.isArray(msg); const replies = [];
    for (const m of (batch ? msg : [msg]).slice(0, 10)) { const r = await rpc(m, c); if (r) replies.push(r); }
    if (!replies.length) return c.body(null, 202);
    return c.json(batch ? replies : replies[0]);
  });
  async function rpc(m, c) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const note = m.id === undefined || m.id === null;
    const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
    const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
    switch (m.method) {
      case 'initialize': {
        const v = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
        return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pkgguard', title: 'PkgGuard', version: VERSION }, instructions: 'Before installing or running code, call check_package (one package) or scan_dependencies (a manifest or lockfile) to see whether it has known vulnerabilities or is a confirmed-malicious package. Data from OSV.dev.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        if (await limited(opts.freeLimiter, c)) { count(c, 'free_rate_limited'); return err(`Free tier rate limit reached. Retry in a minute or use the paid endpoint ${origin(c)}${SCAN_PATH}`); }
        const args = m.params?.arguments || {};
        const p = name === 'check_package' ? readPackageInput(args) : readScanInput(args, PREVIEW_MAX_PACKAGES);
        if (p.error) return err(`bad_request: ${p.error}`);
        let r; try { r = await run(p.packages, 'preview', p.type); } catch (e) { return err(`upstream_unavailable: ${e?.message || e}. Not charged; retry shortly.`); }
        count(c, 'free_mcp');
        const paidUrl = `${origin(c)}${name === 'check_package' ? PACKAGE_PATH : SCAN_PATH}`;
        const what = name === 'check_package' ? `${p.packages[0].ecosystem} ${p.packages[0].name}@${p.packages[0].version}` : `${r.scanned_count} of ${r.package_count} packages${r.manifest_type ? ` (${r.manifest_type})` : ''}`;
        const text = `PkgGuard ${what}: ${r.verdict.toUpperCase()}. ${r.vulnerable_count} vulnerable package(s), ${r.malicious_count} malicious, ${r.advisory_count} advisories${r.unpinned_count ? `, ${r.unpinned_count} unpinned (not scanned)` : ''}.\nWhich packages, advisory ids, severity, CVSS and fixed-in versions: ${paidUrl} (${name === 'check_package' ? cfg.pricePackage : cfg.priceScan} USDC, x402).\n${DISCLAIMER}`;
        return ok({ content: [{ type: 'text', text }], structuredContent: r, isError: false });
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid routes ----
  const routes = [
    { path: SCAN_PATH, kind: 'scan', price: cfg.priceScan, description: SCAN_DESCRIPTION, read: (c) => readScan(c),
      outputSchema: { input: { type: 'http', method: 'POST', discoverable: true, bodyType: 'json', bodyFields: { manifest: { type: 'string', required: false, description: SCAN_Q.properties.manifest.description }, packages: { type: 'array', required: false, description: SCAN_Q.properties.packages.description } } }, output: SCAN_EXAMPLE } },
    { path: PACKAGE_PATH, kind: 'package', price: cfg.pricePackage, description: PACKAGE_DESCRIPTION, read: readPackage,
      outputSchema: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: { ecosystem: { type: 'string', required: false, description: PKG_Q.properties.ecosystem.description }, name: { type: 'string', required: true, description: 'Package name' }, version: { type: 'string', required: true, description: 'Exact version' } } }, output: PACKAGE_EXAMPLE } },
  ];
  // GET /v1/scan 402: add a usage note to the JSON body (the real scan is POST).
  app.use(SCAN_PATH, async (c, next) => {
    await next();
    if (c.req.method !== 'GET' || c.res.status !== 402) return;
    let body = {};
    try { body = await c.res.clone().json(); } catch {}
    const headers = new Headers(c.res.headers); headers.set('content-type', 'application/json');
    c.res = new Response(JSON.stringify({ ...(body && typeof body === 'object' ? body : {}), usage: SCAN_USAGE }), { status: 402, headers });
  });
  const v1s = [];
  for (const r of routes) {
    app.use(r.path, paidRouteStats(stats, r.kind));
    v1s.push(x402v1({
      path: r.path, amount: atomic(r.price), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
      description: r.description, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl, outputSchema: r.outputSchema,
    }));
    // Validate before payment: malformed requests get a 400 (never a 402, never charged). A bare URL (discovery probe) gets the 402.
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      if (r.kind === 'scan' && c.req.method === 'GET') {
        // Unpaid GET: answer with the 402 terms (plus SCAN_USAGE) so directory checkers can list it. Paid GET: 400, never settled.
        if (c.req.header('x-payment') || c.req.header('payment-signature')) return bad(c, SCAN_USAGE.message);
        return next();
      }
      const p = await r.read(c);
      if (p.empty) return next(); // bare URL: answer with the 402 terms; the handler 400s (never settled) if paid without input
      if (p.error) return bad(c, ...p.error);
      c.set('scanInput', p.value);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  const handle = async (c) => {
    const v = c.get('scanInput');
    if (!v) return bad(c, c.req.path === SCAN_PATH ? 'provide "manifest" or "packages" (POST JSON)' : 'provide ecosystem, name and version (GET query or POST JSON)');
    try { return c.json(await run(v.packages, 'full', v.type)); } catch (e) { return upstreamFail(c, e); } // >= 400 is never settled
  };
  app.post(SCAN_PATH, handle);
  app.on(['GET', 'POST'], PACKAGE_PATH, handle);
  return app;
}
