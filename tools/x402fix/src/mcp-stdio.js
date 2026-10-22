#!/usr/bin/env node
// x402fix MCP server over stdio (newline-delimited JSON-RPC 2.0), for coding agents building x402 servers.
// Free by default: the hosted free preview (grade, score, status, counts; 10/min per IP).
// Fix list + CDP verdict + generated fixes: set X402FIX_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a
// little USDC, and this server pays the hosted check report per call over x402 ($0.02): https://api.youraitools.co/x402fix/v1/check
//   npx -y @agentgate-builder/x402fix   (bin: x402fix)
import { createInterface } from 'node:readline';
import { toQuery, preview, DISCLAIMER, PAID_URL, FULL_DETAILS, API_BASE, PRICES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free preview by default (grade, score, status, counts). With X402FIX_X402_PRIVATE_KEY set, returns the paid check report (numbered fix list, CDP facilitator validate verdict, payee checks, generated extensions.bazaar block and multichain accepts) from ${PAID_URL}, paying ${PRICES.check} USDC on Base per check over x402.`;
export const TOOLS = [
  { name: 'check_x402_endpoint', title: 'Is my x402 endpoint correct?', description: `x402 endpoint doctor: probes a paid x402 URL unpaid (GET, HEAD, empty POST, CORS; never pays) and grades it A-F: 402 behavior, v2 PAYMENT-REQUIRED header and v1 body, accepts (USDC asset, EIP-712 domain, Solana feePayer, amounts, payTo), multichain consistency and the Bazaar declaration. Use it after deploying or changing a paid route. ${PAID_NOTE} ${DISCLAIMER}`, inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full https URL of the paid x402 route' }, method: { type: 'string', enum: ['GET', 'POST'], description: 'Method the route uses (default: from its Bazaar declaration)' } }, required: ['url'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const summarizePreview = (r, note) => `${note ? note + '\n' : ''}x402fix ${r.url}: grade ${r.grade} (${r.score}/100), ${String(r.status).replace(/_/g, ' ')}. Errors: ${r.counts?.errors ?? '?'}, warnings: ${r.counts?.warnings ?? '?'}. x402 ${[r.x402?.v2 && 'v2', r.x402?.v1 && 'v1'].filter(Boolean).join('+') || 'not detected'}${r.x402?.networks?.length ? ` on ${r.x402.networks.join(', ')}` : ''}.\n${FULL_DETAILS} Set X402FIX_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r) => `x402fix ${r.url}: ${r.summary}\n${(r.fixes || []).map((x) => `${x.n}. ${x.severity.toUpperCase()}: ${x.problem}\n   Fix: ${x.fix}`).join('\n') || 'No fixes needed.'}\n${DISCLAIMER}`;

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
      const mode = client && !client.error ? `Paid mode: check reports from ${client.apiBase} over x402.` : `Free preview mode; fix lists at ${PAID_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'x402fix', title: 'x402fix', version: VERSION }, instructions: `Call check_x402_endpoint with the URL of a paid x402 route after you deploy or change it. ${mode}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const t = toQuery(m.params?.arguments || {});
      if (t.error) return err(`bad_request: ${t.error}`);
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.check(t.query, 'check');
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.query, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.X402FIX_API_URL || API_BASE });
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
if (import.meta.url === `file://${self}` || /x402fix(-mcp)?$/.test(self)) serve();
