#!/usr/bin/env node
// StackDetect MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted free preview (technology names + categories, 10/min per IP).
// Full results (versions, confidence, evidence, email / DNS / hosting providers, verified SaaS): set
// STACKDETECT_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this server pays the
// hosted API per call over x402 ($0.003/lookup): https://api.youraitools.co/stackdetect/v1/detect
//   npx -y @agentgate-builder/stackdetect   (bin: stackdetect)
import { createInterface } from 'node:readline';
import { toTarget, preview, DISCLAIMER, PAID_URL, FULL_DETAILS, API_BASE, PRICE } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free preview by default (technology names and categories). With STACKDETECT_X402_PRIVATE_KEY set, returns the full paid result (versions, confidence, evidence, email / DNS / hosting providers, verified SaaS) from ${PAID_URL}, paying ${PRICE} USDC on Base per lookup over x402.`;
export const TOOLS = [
  { name: 'detect_stack', title: 'What is this website built with?', description: `Detects the technologies a website uses: CMS, ecommerce platform, JS framework, web server, CDN/hosting, analytics, ad pixels, chat, payments, consent tools. ${PAID_NOTE} ${DISCLAIMER}`, inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL or domain, e.g. https://laravel.com or shopify.com' } }, required: ['url'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const catLines = (cats = {}) => Object.entries(cats).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n');
const summarizePreview = (r, note) => `${note ? note + '\n' : ''}StackDetect ${r.final_url} (HTTP ${r.http_status}): ${r.technology_count} technologies.\n${catLines(r.categories) || 'Nothing detected from the page alone.'}\n${FULL_DETAILS} Set STACKDETECT_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r) => {
  const lines = (r.technologies || []).slice(0, 60).map((t) => `- ${t.name}${t.version ? ` ${t.version}` : ''} [${t.categories.join(', ')}] ${t.confidence}% (${t.evidence.map((e) => e.type).join(', ')})`);
  const p = r.providers || {};
  return `StackDetect ${r.final_url} (HTTP ${r.http_status}): ${r.technology_count} technologies.\n${lines.join('\n')}\nEmail: ${(p.email || []).join(', ') || 'n/a'}; sending: ${(p.email_delivery || []).join(', ') || 'n/a'}; DNS: ${(p.dns || []).join(', ') || 'n/a'}; hosting/CDN: ${(p.hosting || []).join(', ') || 'n/a'}; verified SaaS: ${(p.verified_saas || []).join(', ') || 'n/a'}.\n${DISCLAIMER}`;
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
      const mode = client && !client.error ? `Paid mode: full results from ${client.apiBase} over x402.` : `Free preview mode; full details at ${PAID_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'stackdetect', title: 'StackDetect', version: VERSION }, instructions: `Call detect_stack with a URL or domain to see what the site is built with. ${mode}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const t = toTarget(m.params?.arguments || {});
      if (t.error) return err(`bad_request: ${t.error}`);
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.detect(t.url);
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.url, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.STACKDETECT_API_URL || API_BASE });
      if (r.error) return err(`${r.error}: ${r.message}${fallbackNote ? ` (${fallbackNote})` : ''}`);
      delete r.full;
      return ok({ content: [{ type: 'text', text: summarizePreview(r, fallbackNote) }], structuredContent: fallbackNote ? { ...r, paid_error: fallbackNote } : r, isError: false });
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
if (import.meta.url === `file://${self}` || /stackdetect(-mcp)?$/.test(self)) serve();
