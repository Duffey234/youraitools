#!/usr/bin/env node
// SolVerdict MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted free preview (verdict, score, flag counts; 10/min per IP).
// Reasons and evidence: set SOLVERDICT_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC,
// and this server pays the hosted full check per call over x402 ($0.02): https://api.youraitools.co/solverdict/v1/check
//   npx -y @agentgate-builder/solverdict   (bin: solverdict)
import { createInterface } from 'node:readline';
import { toToken, preview, DISCLAIMER, PAID_URL, FULL_DETAILS, API_BASE, PRICES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free preview by default (verdict, score, flag counts). With SOLVERDICT_X402_PRIVATE_KEY set, returns the paid full check (reasons, mint / freeze authority, Token-2022 extensions, metadata, pools, liquidity and sells, holders, age) from ${PAID_URL}, paying ${PRICES.check} USDC on Base per check over x402.`;
export const TOOLS = [
  { name: 'check_solana_token', title: 'Solana token safety check', description: `Safety check for any Solana SPL or Token-2022 mint before an agent or app interacts with it. SAFE / CAUTION / DANGER with a 0-100 score, from mint and freeze authority, Token-2022 extensions that can tax, freeze or seize tokens, liquidity and recent sells, holder concentration and age. ${PAID_NOTE} SAFE is not a guarantee and not financial advice. ${DISCLAIMER}`, inputSchema: { type: 'object', properties: { mint: { type: 'string', description: 'Solana token mint address (base58), e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' } }, required: ['mint'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const summarizePreview = (r, note) => `${note ? note + '\n' : ''}SolVerdict ${r.symbol || r.mint} (${r.mint}, Solana): ${r.verdict} ${r.score}/100, confidence ${r.confidence}. Red flags: ${r.flags?.danger ?? '?'}, warnings: ${r.flags?.warn ?? '?'}. Liquidity: $${r.liquidity_usd ?? 'n/a'}.\n${FULL_DETAILS} Set SOLVERDICT_X402_PRIVATE_KEY to get them here.\nSAFE is not a guarantee and not financial advice. ${DISCLAIMER}`;
const summarizeFull = (r) => `SolVerdict ${r.symbol || r.mint} (${r.mint}, Solana): ${r.verdict} ${r.score}/100, confidence ${r.confidence}.\n${(r.reasons || []).map((x) => `- ${x.severity.toUpperCase()}: ${x.text}`).join('\n')}\nSAFE is not a guarantee and not financial advice. ${DISCLAIMER}`;

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
      const mode = client && !client.error ? `Paid mode: full checks from ${client.apiBase} over x402.` : `Free preview mode; reasons and evidence at ${PAID_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'solverdict', title: 'SolVerdict', version: VERSION }, instructions: `Call check_solana_token with a Solana token mint address before an agent or app interacts with or accepts a token. ${mode}` });
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
          const r = await client.check(t.token, 'check');
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.token, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.SOLVERDICT_API_URL || API_BASE });
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
if (import.meta.url === `file://${self}` || /solverdict(-mcp)?$/.test(self)) serve();
