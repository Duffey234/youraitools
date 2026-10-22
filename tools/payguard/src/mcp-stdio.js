#!/usr/bin/env node
// PayGuard MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free and offline by default: the free-preview verdict (sanctioned true/false, match count, chain guess) from the
// OFAC SDN snapshot bundled in this package. No network, no keys.
// Optional full results (SDN entity, programs, list date, checksum; refreshed daily): set PAYGUARD_X402_PRIVATE_KEY
// (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this server pays the hosted API per call over
// x402 ($0.001/address, $0.01/batch): https://api.youraitools.co/payguard/v1/address
//   npx -y @agentgate-builder/payguard   (bin: payguard)
import { createInterface } from 'node:readline';
import { previewAddress, previewBatch, LIST, DISCLAIMER, MAX_BATCH, PAID_ADDRESS_URL, PAID_BATCH_URL, FULL_DETAILS } from './lite.js';
import { createPaidClient, keyFromEnv } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const PAID_NOTE = `Free offline preview by default (sanctioned true/false, match count, chain guess). With PAYGUARD_X402_PRIVATE_KEY set, returns the full paid result (SDN entity, programs, list date, checksum) from ${PAID_ADDRESS_URL}, paying $0.001 USDC on Base per address over x402.`;
export const TOOLS = [
  { name: 'screen_address', title: 'OFAC SDN screen of a crypto address', description: `Reports whether a crypto address (EVM, BTC, TRX, SOL, LTC, XMR and more) appears in the US Treasury OFAC SDN list of digital currency addresses. ${PAID_NOTE} Informational screening, not legal advice.`, inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'Blockchain address' } }, required: ['address'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: 'screen_addresses', title: 'OFAC SDN screen of several addresses', description: `Same screen for up to ${MAX_BATCH} addresses in one call. Paid mode uses ${PAID_BATCH_URL} ($0.01 USDC per batch).`, inputSchema: { type: 'object', properties: { addresses: { type: 'array', items: { type: 'string' }, maxItems: MAX_BATCH } }, required: ['addresses'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const FULL_DETAILS_BATCH = `Entity, programs, list date and checksum per address: paid API ${PAID_BATCH_URL} ($0.01 USDC on Base per batch of up to ${MAX_BATCH}, over x402), refreshed daily.`;
const HOW_TO_PAY = 'To get them here, set PAYGUARD_X402_PRIVATE_KEY to a Base wallet key holding a little USDC (see the README).';
const chainOf = (r) => `chain ${r.chain.guess}`;
const previewLine = (r) => `${r.address}: ${r.sanctioned ? `SANCTIONED (${r.match_count} OFAC SDN match${r.match_count === 1 ? '' : 'es'})` : 'no OFAC SDN match'} (${chainOf(r)})`;
const fullLine = (r) => `${r.address}: ${r.sanctioned ? `SANCTIONED - ${r.matches.map((m) => `${m.entity} [${(m.programs || []).join(', ')}] listed ${m.list_date || '?'} as ${m.listed_as}`).join('; ')}` : 'no OFAC SDN match'} (${chainOf(r)}, checksum ${r.chain.checksum_valid === null || r.chain.checksum_valid === undefined ? 'n/a' : r.chain.checksum_valid ? 'valid' : 'INVALID'})`;

/** Text for an offline preview result. */
export function summarize(name, r, note = '') {
  const tail = `${note ? `${note}\n` : ''}Offline preview, OFAC SDN snapshot ${r.list_updated_at} (${r.sdn_address_count ?? LIST.address_count} addresses).${r.stale_warning ? ` ${r.stale_warning}` : ''}\n${name === 'screen_address' ? FULL_DETAILS : FULL_DETAILS_BATCH}${note ? '' : ` ${HOW_TO_PAY}`}\n${DISCLAIMER}`;
  if (name === 'screen_address') return `PayGuard ${previewLine(r)}\n${tail}`;
  return `PayGuard batch: ${r.sanctioned_count}/${r.count} sanctioned\n${r.results.map(previewLine).join('\n')}\n${tail}`;
}
/** Text for a full (paid) result. */
export function summarizeFull(name, r) {
  if (name === 'screen_address') return `PayGuard ${fullLine(r)}\nPaid full result, OFAC SDN list ${r.list_updated_at} (${r.sdn_address_count} addresses).\n${DISCLAIMER}`;
  return `PayGuard batch: ${r.sanctioned_count}/${r.count} sanctioned\n${r.results.map(fullLine).join('\n')}\nPaid full result, OFAC SDN list ${r.list_updated_at}.\n${DISCLAIMER}`;
}

let paidClient; // memoized per process: undefined = not tried, null = no key
async function paid(opts) {
  if (opts.paidClient !== undefined) return opts.paidClient;
  if (paidClient === undefined) paidClient = await createPaidClient({ env: opts.env || process.env, fetchImpl: opts.fetchImpl });
  return paidClient;
}

export async function handle(m, opts = {}) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  const note = m.id === undefined || m.id === null;
  const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
  const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
  switch (m.method) {
    case 'initialize': {
      const mode = keyFromEnv(opts.env || process.env) ? `Paid mode: full results from ${PAID_ADDRESS_URL} over x402.` : `Free offline preview; full details at ${PAID_ADDRESS_URL} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'payguard', title: 'PayGuard', version: VERSION }, instructions: `screen_address reports whether a crypto address appears in the OFAC SDN list (bundled snapshot ${LIST.list_updated_at}, ${LIST.address_count} addresses). ${mode} Informational screening, not legal advice.` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const args = m.params?.arguments || {};
      const r = name === 'screen_address' ? previewAddress(args.address, opts) : previewBatch(args.addresses, opts);
      if (r.error) return err(`${r.error}: ${r.message}`); // invalid input: never paid
      const client = await paid(opts);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const p = name === 'screen_address' ? await client.address(String(args.address)) : await client.batch(args.addresses);
          if (p.result && !p.error) return ok({ content: [{ type: 'text', text: summarizeFull(name, p.result) }], structuredContent: { ...p.result, tier: 'paid', payer: client.payer, ...(p.paymentResponse ? { payment_response: p.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${p.error}${p.detail ? `: ${p.detail}` : ''}); showing the free offline preview.`;
        } catch (e) {
          fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free offline preview.`;
        }
      }
      return ok({ content: [{ type: 'text', text: summarize(name, r, fallbackNote) }], structuredContent: fallbackNote ? { ...r, paid_error: fallbackNote } : r, isError: false });
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
if (import.meta.url === `file://${self}` || /payguard(-mcp)?$/.test(self)) serve();
