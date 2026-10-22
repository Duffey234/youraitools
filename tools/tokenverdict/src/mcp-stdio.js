#!/usr/bin/env node
// TokenVerdict MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted free preview (verdict, score, flag counts; 10/min per IP).
// Reasons and evidence: set TOKENVERDICT_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC,
// and this server pays the hosted quick report per call over x402 ($0.015): https://api.youraitools.co/tokenverdict/v1/quick
//   npx -y @agentgate-builder/tokenverdict   (bin: tokenverdict)
import { createInterface } from 'node:readline';
import { toToken, preview, DISCLAIMER, PAID_URL, FULL_DETAILS, API_BASE, PRICES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free preview by default (verdict, score, flag counts). With TOKENVERDICT_X402_PRIVATE_KEY set, returns the paid quick report (reasons, sell simulation and taxes, owner powers, proxy, liquidity/LP, holders, age) from ${PAID_URL}, paying ${PRICES.quick} USDC on Base per check over x402.`;
export const TOOLS = [
  { name: 'check_token', title: 'Base ERC-20 token safety check', description: `Safety verdict for a Base (chain 8453) ERC-20 token: SAFE / CAUTION / DANGER with a 0-100 score, from a simulated buy-transfer-sell (honeypot and tax detection), owner powers, proxy, liquidity, holders, verification and age. ${PAID_NOTE} ${DISCLAIMER}`, inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Base ERC-20 contract address, e.g. 0x532f27101965dd16442E59d40670FaF5eBB142E4' } }, required: ['token'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const summarizePreview = (r, note) => `${note ? note + '\n' : ''}TokenVerdict ${r.symbol || r.token} (${r.token}, Base): ${r.verdict} ${r.score}/100, confidence ${r.confidence}. Red flags: ${r.flags?.danger ?? '?'}, warnings: ${r.flags?.warn ?? '?'}. Sellable: ${r.sellable == null ? 'not simulated' : r.sellable ? 'yes' : 'NO'}. Liquidity: $${r.liquidity_usd}.\n${FULL_DETAILS} Set TOKENVERDICT_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r) => `TokenVerdict ${r.symbol || r.token} (${r.token}, Base): ${r.verdict} ${r.score}/100, confidence ${r.confidence}.\n${(r.reasons || []).map((x) => `- ${x.severity.toUpperCase()}: ${x.text}`).join('\n')}\n${DISCLAIMER}`;

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
      const mode = client && !client.error ? `Paid mode: quick reports from ${client.apiBase} over x402.` : `Free preview mode; reasons and evidence at ${PAID_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tokenverdict', title: 'TokenVerdict', version: VERSION }, instructions: `Call check_token with a Base ERC-20 contract address before an agent or app interacts with or accepts a token. ${mode}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const t = toToken(m.params?.arguments || {});
      if (t.error) return err(`bad_request: ${t.error}`);
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.check(t.token, 'quick');
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.token, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.TOKENVERDICT_API_URL || API_BASE });
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
if (import.meta.url === `file://${self}` || /tokenverdict(-mcp)?$/.test(self)) serve();
