#!/usr/bin/env node
// PerpRadar MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted free preview (positioning label, venues, confidence; 10/min per IP).
// Full data: set PERPRADAR_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this
// server pays the hosted API per call over x402 (full $0.03, scan $0.02): https://api.youraitools.co/perpradar
//   npx -y @agentgate-builder/perpradar   (bin: perpradar)
import { createInterface } from 'node:readline';
import { toSymbol, preview, DISCLAIMER, FULL_DETAILS, API_BASE, PRICES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const SYM = { type: 'string', description: 'Asset ticker, e.g. BTC, ETH, SOL, HYPE' };
const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: false };
export const TOOLS = [
  { name: 'perp_funding', title: 'Perp funding, OI and positioning for an asset', description: `Perpetual futures funding read for one asset across Hyperliquid, dYdX v4, Paradex and Aevo. Free by default: cross-venue positioning label (crowded long ... crowded short), venues and confidence. With PERPRADAR_X402_PRIVATE_KEY set, returns the paid full tier (${PRICES.full} USDC on Base per call over x402): per-venue funding (8h %, APR), open interest, premium, 7-day funding history with z-score, regime and carry. Read-only; not financial advice.`, inputSchema: { type: 'object', properties: { symbol: SYM }, required: ['symbol'] }, annotations: RO },
  { name: 'perp_funding_scan', title: 'Scan perp funding extremes and spreads', description: `Paid only (needs PERPRADAR_X402_PRIVATE_KEY, ${PRICES.scan} USDC on Base per call): highest and lowest funding, widest cross-venue spreads and market-wide OI-weighted funding across Hyperliquid, dYdX and Paradex; pass symbols (comma list) for a watchlist or leave empty for the whole universe. Read-only; not financial advice.`, inputSchema: { type: 'object', properties: { symbols: { type: 'string', description: 'Optional comma-separated tickers (max 25); empty = whole universe' }, limit: { type: 'integer', description: '1-25, default 10' } } }, annotations: RO },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const summarizePreview = (r, note) => `${note ? note + '\n' : ''}PerpRadar ${r.symbol}: ${String(r.positioning).replace(/_/g, ' ')}. ${r.positioning_note || ''} Venues: ${(r.venues_listed || []).join(', ')}; confidence ${r.confidence}.\n${FULL_DETAILS} Set PERPRADAR_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizeFull = (r) => `PerpRadar ${r.symbol}: ${String(r.positioning).replace(/_/g, ' ')}; median funding ${r.funding?.median_apr_pct}% APR (spread ${r.funding?.cross_venue_spread_apr_pct}%), OI $${r.open_interest_usd_total}. Regime: ${r.regime?.vs_recent}.\n${(r.venues || []).map((v) => `- ${v.venue}: ${v.funding_8h_pct}%/8h (${v.funding_apr_pct}% APR), OI $${v.open_interest_usd}, premium ${v.premium_pct}%`).join('\n')}\n${DISCLAIMER}`;
const summarizeScan = (r) => `PerpRadar scan (${r.mode}, ${r.assets} assets): market OI-weighted funding ${r.market?.oi_weighted_funding_apr_pct}% APR (${r.market?.read}).\nHighest: ${(r.highest_funding || []).map((x) => `${x.symbol} ${x.median_apr_pct}%`).join(', ')}\nLowest: ${(r.lowest_funding || []).map((x) => `${x.symbol} ${x.median_apr_pct}%`).join(', ')}\nWidest spreads: ${(r.widest_spreads || []).map((x) => `${x.symbol} ${x.spread_apr_pct}%`).join(', ')}\n${DISCLAIMER}`;

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
      const mode = client && !client.error ? `Paid mode: full data from ${client.apiBase} over x402.` : `Free preview mode; rates and scans at ${API_BASE} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'perpradar', title: 'PerpRadar', version: VERSION }, instructions: `Call perp_funding with an asset ticker for the cross-venue perp funding read. ${mode} Not financial advice.` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const args = m.params?.arguments || {};
      const client = await paid(opts);
      if (name === 'perp_funding_scan') {
        if (!client || client.error) return err(`perp_funding_scan is paid only: set PERPRADAR_X402_PRIVATE_KEY (Base USDC) or call ${API_BASE}/v1/scan?universe=all with any x402 client (${PRICES.scan}).${client?.error ? ` (${client.error})` : ''}`);
        const lim = args.limit === undefined ? 10 : Number(args.limit);
        const input = args.symbols ? { symbols: String(args.symbols), limit: lim } : { universe: 'all', limit: lim };
        try {
          const r = await client.call('scan', input);
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeScan(r.result) }], structuredContent: { ...r.result, payer: client.payer }, isError: false });
          return err(`${r.error}${r.detail ? `: ${r.detail}` : ''}`);
        } catch (e) { return err(`paid call failed: ${String(e?.message || e).slice(0, 200)}`); }
      }
      const t = toSymbol(args);
      if (t.error) return err(`bad_request: ${t.error}`);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.call('full', { symbol: t.symbol });
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizeFull(r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t.symbol, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.PERPRADAR_API_URL || API_BASE });
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
if (import.meta.url === `file://${self}` || /perpradar(-mcp)?$/.test(self)) serve();
