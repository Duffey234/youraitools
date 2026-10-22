#!/usr/bin/env node
// SignCheck MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted offline preview (verdict, summary, flag codes; 10/min per IP).
// Full check (reasons, decoded args, on-chain facts, OFAC SDN details, eth_call simulation): set SIGNCHECK_X402_PRIVATE_KEY
// (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this server pays the hosted API per call over x402
// ($0.015/check): https://api.youraitools.co/signcheck/v1/check
//   npx -y @agentgate-builder/signcheck   (bin: signcheck)
import { createInterface } from 'node:readline';
import { toBody, preview, DISCLAIMER, PAID_URL, FULL_DETAILS, API_BASE, PRICE } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free offline preview by default (verdict, summary, flag codes). With SIGNCHECK_X402_PRIVATE_KEY set, returns the full paid check (reasons, on-chain facts, simulation) from ${PAID_URL}, paying ${PRICE} USDC on Base per check over x402.`;
const PROPS = {
  chain: { type: 'string', description: 'base (default), ethereum, base-sepolia or a chain id' },
  tx: { type: 'object', description: 'Transaction about to be sent: {"to":"0x…","data":"0x…","value":"0","from":"0x…"}' },
  typed_data: { type: 'object', description: 'EIP-712 request {domain, types, primaryType, message} (eth_signTypedData_v4)' },
  authorization: { type: 'object', description: 'EIP-7702 authorization {address, chainId, nonce}' },
  payment_required: { type: ['object', 'string'], description: 'x402 402 terms: PAYMENT-REQUIRED header (base64) or {accepts:[…]}' },
  payment_payload: { type: ['object', 'string'], description: 'x402 payment about to be sent: PAYMENT-SIGNATURE / X-PAYMENT (base64) or JSON' },
};
export const TOOLS = [
  { name: 'check_signature', title: 'Is it safe to sign this?', description: `Call BEFORE a wallet signs or sends anything. Decodes a transaction, EIP-712 request (Permit, Permit2, EIP-3009, Seaport), EIP-7702 delegation or x402 payment into plain English and returns SAFE / CAUTION / DANGER with risk flags (unlimited or EOA approvals, setApprovalForAll, fake USDC domains, x402 overpay / wrong payTo, OFAC SDN). ${PAID_NOTE} ${DISCLAIMER}`, inputSchema: { type: 'object', properties: PROPS }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const summarizePreview = (r, note) => `${note ? note + '\n' : ''}SignCheck ${r.verdict} (risk ${r.risk_score}/100): ${r.summary}.\n${r.flags?.length ? 'Flags: ' + r.flags.map((f) => `${f.code} [${f.severity}]`).join(', ') : 'No risk flags from the offline check.'}\n${FULL_DETAILS} Set SIGNCHECK_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r) => `SignCheck ${r.verdict} (risk ${r.risk_score}/100) on ${r.chain?.name}: ${r.summary}.\n${(r.flags || []).map((f) => `- [${f.severity}] ${f.code}: ${f.message}`).join('\n') || 'No risk flags.'}\n${r.onchain?.simulation ? `Simulation: ${r.onchain.simulation.success ? 'succeeds' : `REVERTS (${r.onchain.simulation.revert_reason})`}\n` : ''}Counterparties: ${(r.counterparties || []).map((p) => `${p.address} ${p.type || ''}${p.label ? ` (${p.label})` : ''} [${p.roles.join(', ')}]`).join('; ')}\n${DISCLAIMER}`;

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
      const mode = client && !client.error ? `Paid mode: full checks from ${client.apiBase} over x402.` : `Free preview mode; full checks at ${PAID_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'signcheck', title: 'SignCheck', version: VERSION }, instructions: `Before signing or sending anything from a wallet, call check_signature. Do not sign on DANGER; ask a human on CAUTION. ${mode}` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const t = toBody(m.params?.arguments || {});
      if (t.error) return err(`bad_request: ${t.error}`);
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.check(t.body);
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.body, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.SIGNCHECK_API_URL || API_BASE });
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
if (import.meta.url === `file://${self}` || /signcheck(-mcp)?$/.test(self)) serve();
