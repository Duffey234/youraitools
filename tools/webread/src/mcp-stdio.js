#!/usr/bin/env node
// WebRead MCP server over stdio (newline-delimited JSON-RPC 2.0, no dependencies).
// Tool read_url reads the page locally on your machine with the same SSRF-safe, robots.txt-respecting
// reader and HTML-to-Markdown converter the hosted API uses. Free; nothing is sent to WebRead.
// Hosted alternative (no local network access needed): https://webread.agentgate.workers.dev (x402, $0.002/read).
//   npx -y x402-url-to-markdown          (bin: webread-mcp)
import { createInterface } from 'node:readline';
import { Reader, FetchError } from './reader.js';

export const VERSION = '0.1.4';
const MAX = 200000;
export const TOOL = {
  name: 'read_url', title: 'Read a web page as Markdown',
  description: 'Fetch a public web page and return its main content as clean Markdown (no navigation, scripts or ads), with title and description. Respects robots.txt and refuses private/internal addresses. Runs locally; maxChars defaults to 50,000 (max 200,000).',
  inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL' }, maxChars: { type: 'integer', minimum: 100, maximum: MAX, description: 'Maximum Markdown characters to return (default 50000)' } }, required: ['url'] },
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function createHandler({ reader = new Reader({ fetchImpl: (...a) => fetch(...a) }) } = {}) {
  return async function handle(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const note = m.id === undefined || m.id === null;
    const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'webread', title: 'WebRead', version: VERSION }, instructions: 'read_url returns a public web page as clean Markdown (main content, absolute links, title and metadata).' });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: [TOOL] });
      case 'tools/call': {
        if (m.params?.name !== 'read_url') return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } };
        const { url, maxChars } = m.params?.arguments || {};
        if (typeof url !== 'string' || !url) return ok({ isError: true, content: [{ type: 'text', text: 'bad_request: "url" (string) is required' }] });
        const n = Math.min(MAX, Math.max(100, Number.isInteger(maxChars) ? maxChars : 50000));
        try {
          const r = await reader.read(url, { maxChars: n });
          const head = `# ${r.title || r.finalUrl}\nSource: ${r.finalUrl}\n${r.truncated ? `(truncated to ${n} characters)\n` : ''}\n`;
          return ok({ content: [{ type: 'text', text: head + r.markdown }], structuredContent: r, isError: false });
        } catch (e) {
          const msg = e instanceof FetchError ? `${e.code}: ${e.message}` : `read_failed: ${String(e?.message || e).slice(0, 200)}`;
          return ok({ isError: true, content: [{ type: 'text', text: msg }] });
        }
      }
      default:
        return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };
}

export function serve({ input = process.stdin, output = process.stdout, handler = createHandler() } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (o) => output.write(JSON.stringify(o) + '\n');
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map(handler))).filter(Boolean);
    if (replies.length) write(batch ? replies : replies[0]);
  });
  return rl;
}

const self = process.argv[1] || '';
if (import.meta.url === `file://${self}` || /webread-mcp$|x402-url-to-markdown$/.test(self)) serve();
