#!/usr/bin/env node
// LeakGuard MCP server over stdio (newline-delimited JSON-RPC 2.0). Runs the detection engine LOCALLY and offline:
//   scan_for_leaks  verdict, findings (type, severity, offsets, masked preview), counts
//   redact_text     the same plus the redacted text
// Optional paid tool (only when LEAKGUARD_X402_PRIVATE_KEY or X402_PRIVATE_KEY is set):
//   check_leaked_wallets  hosted deep scan: which wallets do leaked seed phrases / private keys control and do they hold
//                         funds right now (Base, Ethereum, Polygon, Arbitrum One, Solana); pays $0.02 USDC on Base over x402
//   npx -y @agentgate-builder/leakguard   (bin: leakguard)
import { createInterface } from 'node:readline';
import { scan, redact } from './engine.js';
import { toText, DISCLAIMER, HOSTED, PRICES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const OPTS = { style: { type: 'string', enum: ['label', 'mask'], description: 'label: [REDACTED:type] (default); mask: keep last 4 digits / email domain for PII' }, types: { type: 'array', items: { type: 'string' }, description: 'Only these finding types or categories (wallet_key, secret, pii, email, ...)' }, min_severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } };
const TEXT = { type: 'string', description: 'Text your agent is about to send to an LLM, tool, log or webhook' };
const RO = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };
export const TOOLS = [
  { name: 'scan_for_leaks', title: 'Check text for leaked secrets before sending it', description: `Runs locally and offline. Finds crypto wallet keys (BIP39 seed phrases with checksum, EVM and Solana private keys, WIF, xprv), API secrets (GitHub, AWS, Stripe, OpenAI, Anthropic, Slack, Telegram, npm, JWT, PEM, credentialed URLs, password= assignments) and PII (cards, IBAN, SSN, email, phone, IP). Returns verdict (WALLET_KEY_EXPOSED / SECRETS_FOUND / PII_FOUND / CLEAN), safe_to_send and findings with masked previews (never the secret). ${DISCLAIMER}`, inputSchema: { type: 'object', properties: { text: TEXT, ...OPTS }, required: ['text'] }, annotations: RO },
  { name: 'redact_text', title: 'Redact secrets, wallet keys and PII from text', description: 'Runs locally and offline. Same detection as scan_for_leaks, plus the redacted text ([REDACTED:type], or masked PII with style=mask) to send instead of the original.', inputSchema: { type: 'object', properties: { text: TEXT, ...OPTS }, required: ['text'] }, annotations: RO },
];
const PAID_TOOL = { name: 'check_leaked_wallets', title: 'Do leaked wallet keys control funds right now?', description: `Paid (${PRICES.scan} USDC on Base per call over x402, from your LEAKGUARD_X402_PRIVATE_KEY wallet). Sends the text to the hosted LeakGuard deep scan (processed in memory, never stored): for each leaked seed phrase or private key it derives the public addresses and reports native + USDC balances on Base, Ethereum, Polygon, Arbitrum One and Solana (funds_at_risk / used_empty / no_funds_found / unknown), plus redacted text and ordered actions. Also accepts "json" (a JSON payload) instead of "text".`, inputSchema: { type: 'object', properties: { text: TEXT, json: { description: 'Alternative to text: a JSON payload (tool-call arguments, webhook body)' } } }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

let paidClient;
const paid = async (opts) => { if (paidClient === undefined) paidClient = await createPaidClient(opts); return paidClient; };
const summary = (r) => `LeakGuard (local): ${r.verdict}, safe_to_send ${r.safe_to_send}, max severity ${r.max_severity}.${r.findings.length ? `\n${r.findings.map((f) => `- ${f.severity.toUpperCase()} ${f.type} at ${f.start}-${f.end}: ${f.preview}`).join('\n')}` : ''}`;

export async function handle(m, opts = {}) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  const note = m.id === undefined || m.id === null;
  const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
  const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
  switch (m.method) {
    case 'initialize': {
      const client = await paid(opts);
      const mode = client && !client.error ? ` Paid tool check_leaked_wallets is enabled (payer ${client.payer}).` : '';
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'leakguard', title: 'LeakGuard', version: VERSION }, instructions: `Before sending text to an LLM, tool, log or webhook, call scan_for_leaks (or redact_text and send the redacted text). Runs locally.${mode} ${HOSTED}` });
    }
    case 'ping': return ok({});
    case 'tools/list': { const client = await paid(opts); return ok({ tools: client && !client.error ? [...TOOLS, PAID_TOOL] : TOOLS }); }
    case 'tools/call': {
      const name = m.params?.name; const a = m.params?.arguments || {};
      if (name === PAID_TOOL.name) {
        const client = await paid(opts);
        if (!client) return err(`check_leaked_wallets needs LEAKGUARD_X402_PRIVATE_KEY (a Base wallet with a little USDC). ${HOSTED}`);
        if (client.error) return err(client.error);
        if (a.json === undefined && (typeof a.text !== 'string' || !a.text)) return err('bad_request: "text" or "json" is required');
        try {
          const r = await client.scan(a.json !== undefined ? { json: a.json } : { text: a.text });
          if (r.error) return err(`${r.error}${r.detail ? `: ${r.detail}` : ''}`);
          const x = r.result;
          const lines = (x.exposure?.addresses || []).map((w) => `- ${w.address} (${w.family}${w.path ? ` ${w.path}` : ''}): ${w.status}${Object.entries(w.balances || {}).filter(([, b]) => b.funded).map(([k, b]) => ` ${k} native ${b.native} USDC ${b.usdc}`).join(';')}`);
          return ok({ content: [{ type: 'text', text: `LeakGuard deep scan: ${x.verdict}, exposure ${x.exposure?.status}, confidence ${x.confidence}.\n${lines.join('\n')}\nActions:\n${(x.actions || []).map((s) => `- ${s}`).join('\n')}` }], structuredContent: { ...x, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
        } catch (e) { return err(`paid call failed: ${String(e?.message || e).slice(0, 200)}`); }
      }
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const t = toText(a); if (t.error) return err(`bad_request: ${t.error}`);
      const o = { style: a.style, types: Array.isArray(a.types) && a.types.length ? a.types : undefined, minSeverity: a.min_severity };
      try {
        const r = await redact(t.text, o);
        const counts = r.counts;
        const res = { verdict: r.verdict, safe_to_send: r.safe_to_send, max_severity: r.max_severity, counts, findings: r.findings, engine: r.engine, ...(name === 'redact_text' ? { redacted: r.redacted } : {}) };
        return ok({ content: [{ type: 'text', text: summary(r) + (name === 'redact_text' ? `\n\nRedacted:\n${r.redacted}` : '') }], structuredContent: res, isError: false });
      } catch (e) { return err(`error: ${String(e?.message || e).slice(0, 200)}`); }
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
if (import.meta.url === `file://${self}` || /leakguard(-mcp)?$/.test(self)) serve();
