#!/usr/bin/env node
// AgentReady MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted free preview (score, grade, category scores; 10/min per IP).
// Findings, fixes and snippets: set AGENTREADY_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little
// USDC, and this server pays the hosted full audit per call over x402 ($0.03): https://api.youraitools.co/agentready/v1/audit
//   npx -y @agentgate-builder/agentready   (bin: agentready)
import { createInterface } from 'node:readline';
import { toUrl, preview, DISCLAIMER, PAID_URL, FULL_DETAILS, API_BASE, PRICES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free preview by default (score, grade, category scores). With AGENTREADY_X402_PRIVATE_KEY set, returns the paid full audit (23 checks with evidence, robots.txt matrix for 17 AI bots, prioritized fixes, ready-to-paste llms.txt / robots.txt / JSON-LD / meta snippets) from ${PAID_URL}, paying ${PRICES.audit} USDC on Base per audit over x402.`;
export const TOOLS = [
  { name: 'audit_website', title: 'Is this website ready for AI agents?', description: `AI-agent readiness audit of a website: score 0-100 and grade A-F across agent access (robots.txt rules for AI bots like GPTBot, ClaudeBot, ChatGPT-User; bot challenges), readable content (raw HTML without JavaScript, markdown), discovery (llms.txt, sitemap, JSON-LD, Open Graph), agent interfaces (OpenAPI, MCP, A2A agent card, x402) and speed/HTTPS. ${PAID_NOTE} ${DISCLAIMER}`, inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Website URL or domain, e.g. https://example.com or stripe.com' } }, required: ['url'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const cats = (r) => Object.entries(r.categories || {}).map(([k, v]) => `${k} ${v.score}/${v.max}`).join(', ');
const summarizePreview = (r, note) => `${note ? note + '\n' : ''}AgentReady ${r.host}: ${r.score}/100 (grade ${r.grade}, ${r.verdict}), confidence ${r.confidence}. ${cats(r)}. ${r.counts?.fail ?? '?'} failing, ${r.counts?.warn ?? '?'} weak checks.\n${FULL_DETAILS} Set AGENTREADY_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r) => `AgentReady ${r.host}: ${r.score}/100 (grade ${r.grade}, ${r.verdict}), confidence ${r.confidence}. ${cats(r)}.\nFixes:\n${(r.fixes || r.top_issues || []).map((f) => `- ${String(f.priority).toUpperCase()} (+${f.points_gain}): ${f.title}. ${f.how || ''}`).join('\n')}${r.snippets ? `\nSnippets: ${Object.keys(r.snippets).join(', ')} (see structuredContent.snippets)` : ''}\n${DISCLAIMER}`;

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
      const mode = client && !client.error ? `Paid mode: full audits from ${client.apiBase} over x402.` : `Free preview mode; findings and fixes at ${PAID_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agentready', title: 'AgentReady', version: VERSION }, instructions: `Call audit_website with a URL or domain to see how ready the site is for AI agents. ${mode}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const t = toUrl(m.params?.arguments || {});
      if (t.error) return err(`bad_request: ${t.error}`);
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.audit(t.url, 'audit');
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.url, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.AGENTREADY_API_URL || API_BASE });
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
if (import.meta.url === `file://${self}` || /agentready(-mcp)?$/.test(self)) serve();
