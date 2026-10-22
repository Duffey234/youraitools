#!/usr/bin/env node
// DomainCheck MCP server over stdio (newline-delimited JSON-RPC 2.0). Runs the full checks locally from your machine
// using public DNS-over-HTTPS (1.1.1.1, Google fallback) and RDAP. Free; no keys.
// Hosted x402 API (same engine): https://domaincheck.agentgate.workers.dev
//   npx -y @agentgate-builder/domaincheck      (bin: domaincheck)
import { createInterface } from 'node:readline';
import { checkDomain, checkEmail } from './check.js';

export const VERSION = '0.1.3';
export const TOOLS = [
  { name: 'check_domain', title: 'Check a domain', description: 'Full domain trust report before your agent trusts a link, sender or counterparty: exists?, DNS, MX + mail provider, SPF / DMARC / DKIM / MTA-STS / BIMI, DNSSEC, RDAP registration age + registrar + status, parking and disposable detection, risk flags, 0-100 score and verdict.', inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain, URL or email address' } }, required: ['domain'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
  { name: 'check_email', title: 'Check an email address', description: 'Check an email address before storing, emailing or trusting it: syntax, disposable / role / free provider, MX and null MX, SPF / DMARC of its domain, domain age, verdict (valid | risky | undeliverable | invalid) and 0-100 score. No SMTP mailbox probing.', inputSchema: { type: 'object', properties: { email: { type: 'string', description: 'Email address' } }, required: ['email'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function summarize(name, r) {
  const flags = (r.flags || []).map((f) => `- ${f.id} (${f.severity})${f.detail ? `: ${f.detail}` : ''}`).join('\n');
  if (name === 'check_domain') return `DomainCheck ${r.domain}: ${String(r.verdict).toUpperCase()} (score ${r.score}/100); ${r.exists ? 'exists' : 'DOES NOT EXIST'}; age ${r.registration?.age_days ?? '?'} days; registrar ${r.registration?.registrar || '?'}; mail ${r.email?.accepts_mail ? `accepts (${r.email.mx_provider})` : 'none'}; mail grade ${r.email?.grade || '?'}${flags ? `\nFlags:\n${flags}` : ''}`;
  return `DomainCheck ${r.input}: ${String(r.verdict).toUpperCase()} (score ${r.score}/100)${r.domain ? `; disposable ${r.disposable ? 'YES' : 'no'}; role ${r.role ? 'yes' : 'no'}; free provider ${r.free_provider ? 'yes' : 'no'}` : ''}${flags ? `\nFlags:\n${flags}` : ''}`;
}

export async function handle(m, engine = {}) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  const note = m.id === undefined || m.id === null;
  const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
  const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'domaincheck', title: 'DomainCheck', version: VERSION }, instructions: 'check_domain reports whether a domain exists, how old it is and how its email is configured; check_email reports whether an address is valid, disposable or undeliverable.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (name !== 'check_domain' && name !== 'check_email') return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const key = name === 'check_domain' ? 'domain' : 'email';
      const v = m.params?.arguments?.[key];
      if (typeof v !== 'string' || !v.trim()) return err(`bad_request: "${key}" (string) is required`);
      try {
        const r = key === 'domain' ? await checkDomain(v.trim(), engine) : await checkEmail(v.trim(), engine);
        if (r.error) return err(`${r.error}: ${r.message}`);
        return ok({ content: [{ type: 'text', text: summarize(name, r) }], structuredContent: r, isError: false });
      } catch (e) { return err(`lookup_failed: ${e.message}`); }
    }
    default:
      return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

export function serve({ input = process.stdin, output = process.stdout, engine } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (o) => output.write(JSON.stringify(o) + '\n');
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map((x) => handle(x, engine)))).filter(Boolean);
    if (replies.length) write(batch ? replies : replies[0]);
  });
  return rl;
}

const self = process.argv[1] || '';
if (import.meta.url === `file://${self}` || /domaincheck(-mcp)?$/.test(self)) serve();
