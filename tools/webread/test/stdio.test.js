import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../src/mcp-stdio.js', import.meta.url));

function session(messages) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'inherit'] });
    const out = []; let buf = '';
    const want = messages.filter((m) => m.id !== undefined).length;
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout: ' + buf)); }, 10000);
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      if (out.length >= want) { clearTimeout(timer); p.kill(); resolve(out); }
    });
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('stdio MCP: initialize, tools/list (read_url), unknown method', async () => {
  const [init, list, bad] = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'nope' },
  ]);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['read_url']);
  assert.equal(bad.error.code, -32601);
});

test('stdio handler: read_url returns Markdown via the reader; errors are tool errors', async () => {
  const { createHandler } = await import('../src/mcp-stdio.js');
  const reader = { read: async (url, { maxChars }) => ({ url, finalUrl: url, title: 'T', markdown: 'Hello'.slice(0, maxChars), truncated: false }) };
  const h = createHandler({ reader });
  const r = await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_url', arguments: { url: 'https://site.example.org/' } } });
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0].text, /^# T\nSource: https:\/\/site.example.org\/\n\nHello$/);
  const e = await createHandler({ reader: { read: async () => { throw new Error('boom'); } } })({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_url', arguments: { url: 'https://x.example/' } } });
  assert.equal(e.result.isError, true);
  assert.equal((await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_url', arguments: {} } })).result.isError, true);
});
