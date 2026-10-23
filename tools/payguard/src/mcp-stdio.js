#!/usr/bin/env node
// PayGuard MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free and offline by default: the free-preview verdict (sanctioned true/false, match count, chain guess) from the
// OFAC SDN snapshot bundled in this package. No network, no keys.
// Optional full results (SDN entity, programs, list date, checksum; refreshed daily): set PAYGUARD_X402_PRIVATE_KEY
// (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this server pays the hosted API per call over
// x402 ($0.001/address, $0.01/batch): https://api.youraitools.co/payguard/v1/address
//   node src/mcp-stdio.js   (run from a source checkout: https://agentgate-source.pages.dev/x402-payguard/ ; bin: payguard)
import { createInterface } from 'node:readline';
import { previewAddress, previewBatch, LIST, DISCLAIMER, MAX_BATCH, PAID_ADDRESS_URL, PAID_BATCH_URL, FULL_DETAILS } from './lite.js';
import { createPaidClient, keyFromEnv } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const CHAINS = 'Any chain is accepted; the SDN list covers Bitcoin, Ethereum and other EVM chains (Base, Arbitrum, BNB Chain, Polygon...), Tron, Solana, Litecoin, Monero, Bitcoin Cash/SV/Gold, Dash, Dogecoin, Ethereum Classic, XRP, Verge, Zcash and USDT/USDC addresses.';
const ADDRESS_FORMAT = '20-140 letters/digits, optional URI prefix such as "ethereum:" or "bitcoincash:" (stripped); EVM hex and bech32 match case-insensitively, base58 exactly.';
const MODES = (price, unit, url) => `Free mode (default, no key): offline lookup in the OFAC snapshot bundled with this server. Paid mode (PAYGUARD_X402_PRIVATE_KEY set to a Base wallet key holding USDC): ${price} USDC ${unit} over x402 to ${url} for the daily-refreshed full result; falls back to the free result with paid_error if payment fails; invalid input is never paid.`;
export const TOOLS = [
  { name: 'screen_address', title: 'OFAC SDN screen of a crypto address',
    description: `Checks one crypto address against the US Treasury OFAC SDN list of sanctioned digital currency addresses. For 2 or more addresses use screen_addresses (up to ${MAX_BATCH} per call, one charge per batch). Accepts any chain (BTC, ETH and EVM chains, TRX, SOL, LTC, XMR, BCH, XRP, ZEC and more). ${MODES('$0.001', 'per address', PAID_ADDRESS_URL)} Returns sanctioned (true/false), match_count, address (normalized), chain {guess, format}, list_updated_at and tier; paid adds matches[] (entity, entity_type, programs, list_date) and chain checksum_valid. Read-only; informational screening, not legal advice.`,
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: `One blockchain address, e.g. "0x8589427373D6D84E98730D7795D8f6f8731FDA16" or "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh": ${ADDRESS_FORMAT} The chain is detected automatically. ${CHAINS}` } }, required: ['address'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  { name: 'screen_addresses', title: 'OFAC SDN screen of several addresses',
    description: `Checks 1-${MAX_BATCH} crypto addresses against the US Treasury OFAC SDN list in one call. Use it instead of repeated screen_address calls whenever you have several addresses (payee lists, counterparties, transaction inputs/outputs); use screen_address for a single one. Mixed chains allowed; one invalid entry rejects the whole call. ${MODES('$0.01', `per batch of up to ${MAX_BATCH}`, PAID_BATCH_URL)} Returns count, sanctioned_count, any_sanctioned, list_updated_at and results[] in input order, each {input, address, sanctioned, match_count, chain}; paid adds matches[] (entity, programs, list_date) per address. Read-only; informational screening, not legal advice.`,
    inputSchema: { type: 'object', properties: { addresses: { type: 'array', items: { type: 'string', description: `One blockchain address: ${ADDRESS_FORMAT}` }, maxItems: MAX_BATCH, description: `1-${MAX_BATCH} blockchain addresses, one string per element, e.g. ["0x8589427373D6D84E98730D7795D8f6f8731FDA16", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"]. Chains may be mixed (detected per address). ${CHAINS} More than ${MAX_BATCH} entries or any malformed one returns a bad_request error.` } }, required: ['addresses'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
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
