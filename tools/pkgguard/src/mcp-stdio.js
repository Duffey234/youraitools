#!/usr/bin/env node
// PkgGuard MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Manifests and lockfiles are parsed locally; only {ecosystem, name, version} go out.
// Free by default: the hosted free preview (verdict + counts, up to 25 packages, 10/min per IP).
// Full results (which packages, advisory ids, severity, CVSS, fixed-in versions; up to 500 packages): set
// PKGGUARD_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this server pays the
// hosted API per call over x402 ($0.003/scan, $0.001/package): https://api.youraitools.co/pkgguard/v1/scan
//   npx -y @agentgate-builder/pkgguard   (bin: pkgguard)
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { toPackages, preview, DISCLAIMER, PAID_SCAN_URL, PAID_PACKAGE_URL, FULL_DETAILS, MANIFEST_TYPES, ECOSYSTEMS, PREVIEW_MAX, MAX_PACKAGES, API_BASE } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free preview by default (verdict and counts, up to ${PREVIEW_MAX} packages). With PKGGUARD_X402_PRIVATE_KEY set, returns the full paid result (affected packages, advisory ids, severity, CVSS, fixed-in versions; up to ${MAX_PACKAGES} packages) from ${PAID_SCAN_URL}, paying $0.003 USDC on Base per scan over x402.`;
const SCAN_PROPS = { manifest: { type: 'string', description: `File contents (${MANIFEST_TYPES.join(', ')})` }, path: { type: 'string', description: 'Or a local file path to read (e.g. ./package-lock.json)' }, filename: { type: 'string' }, packages: { type: 'array', items: { type: 'object' }, description: '[{ecosystem, name, version}]' }, include_dev: { type: 'boolean' } };
export const TOOLS = [
  { name: 'scan_dependencies', title: 'Scan a dependency manifest for vulnerable and malicious packages', description: `Checks a package.json, lockfile, requirements.txt, go.mod, Cargo.lock, poetry.lock or composer.lock (contents or a local path) or a package list against OSV.dev for known vulnerabilities and confirmed-malicious packages. ${PAID_NOTE} ${DISCLAIMER}`, inputSchema: { type: 'object', properties: SCAN_PROPS }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
  { name: 'check_package', title: 'Is this package version vulnerable or malicious?', description: `Checks one package version (${ECOSYSTEMS.join(', ')}) against OSV.dev. Paid mode uses ${PAID_PACKAGE_URL} ($0.001).`, inputSchema: { type: 'object', properties: { ecosystem: { type: 'string', description: 'default npm' }, name: { type: 'string' }, version: { type: 'string' } }, required: ['name', 'version'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const summarizePreview = (r, what, note) => `${note ? note + '\n' : ''}PkgGuard ${what}: ${String(r.verdict).toUpperCase()}. ${r.vulnerable_count} vulnerable package(s), ${r.malicious_count} malicious, ${r.advisory_count} advisories${r.unpinned_count ? `, ${r.unpinned_count} unpinned (not scanned)` : ''}.\n${FULL_DETAILS} Set PKGGUARD_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r, what) => {
  const lines = (r.packages || []).slice(0, 30).map((p) => `- ${p.malicious ? 'MALICIOUS ' : ''}${p.ecosystem} ${p.name}@${p.version} [${p.highest_severity}] ${p.vulns.slice(0, 5).map((v) => `${v.id}${v.aliases?.[0] ? ` (${v.aliases[0]})` : ''}${v.fixed_in?.length ? ` fixed in ${v.fixed_in.join('/')}` : ''}`).join('; ')}${p.vulns.length > 5 ? ` +${p.vulns.length - 5} more` : ''}`);
  return `PkgGuard ${what}: ${String(r.verdict).toUpperCase()} (highest ${r.highest_severity}). ${r.vulnerable_count} vulnerable, ${r.malicious_count} malicious, ${r.advisory_count} advisories.\n${lines.join('\n')}${r.range_note ? `\n${r.range_note}` : ''}\n${DISCLAIMER}`;
};

let paidClient;
const paid = async (opts) => { if (paidClient === undefined) paidClient = await createPaidClient(opts); return paidClient; };

export async function handle(m, opts = {}) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  const note = m.id === undefined || m.id === null;
  const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
  const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
  switch (m.method) {
    case 'initialize': {
      const client = await paid(opts);
      const mode = client && !client.error ? `Paid mode: full results from ${client.apiBase} over x402.` : `Free preview mode; full details at ${PAID_SCAN_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pkgguard', title: 'PkgGuard', version: VERSION }, instructions: `Before installing or running code, call check_package or scan_dependencies to see whether a dependency has known vulnerabilities or is a confirmed-malicious package (OSV.dev). ${mode}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const args = { ...(m.params?.arguments || {}) };
      if (name === 'scan_dependencies' && args.manifest === undefined && args.packages === undefined && typeof args.path === 'string') {
        try { args.manifest = await readFile(args.path, 'utf8'); args.filename ??= args.path; } catch (e) { return err(`bad_request: could not read ${args.path}: ${e.code || e.message}`); }
      }
      const p = name === 'check_package' ? toPackages({ ecosystem: args.ecosystem, name: args.name, version: args.version ?? '' }) : toPackages(args);
      if (p.error) return err(`bad_request: ${p.error}`);
      const what = name === 'check_package' ? `${p.packages[0].ecosystem} ${p.packages[0].name}@${p.packages[0].version}` : `${p.packages.length} packages${p.type ? ` (${p.type})` : ''}`;
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = name === 'check_package' ? await client.package(p.packages[0]) : await client.scan(p.packages);
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result, what) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(p.packages, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.PKGGUARD_API_URL || API_BASE });
      if (r.error) return err(`${r.error}: ${r.message}${fallbackNote ? ` (${fallbackNote})` : ''}`);
      delete r.full;
      return ok({ content: [{ type: 'text', text: summarizePreview(r, what, fallbackNote) }], structuredContent: fallbackNote ? { ...r, paid_error: fallbackNote } : r, isError: false });
    }
    default:
      return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

export function serve({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (o) => output.write(JSON.stringify(o) + '\n');
  rl.on('line', async (l) => {
    if (!l.trim()) return;
    let msg; try { msg = JSON.parse(l); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map((x) => handle(x)))).filter(Boolean);
    if (replies.length) write(batch ? replies : replies[0]);
  });
  return rl;
}

const self = process.argv[1] || '';
if (import.meta.url === `file://${self}` || /pkgguard(-mcp)?$/.test(self)) serve();
