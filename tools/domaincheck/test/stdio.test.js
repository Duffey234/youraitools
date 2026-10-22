import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/mcp-stdio.js';
import { fakeNet, NOW } from './helpers.js';
import { DohResolver } from '../src/dns.js';
import { Rdap } from '../src/rdap.js';

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

test('stdio MCP binary: initialize, tools/list, unknown method', async () => {
  const [init, list, bad] = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'nope' },
  ]);
  assert.equal(init.result.serverInfo.name, 'domaincheck');
  assert.deepEqual(list.result.tools.map((t) => t.name), ['check_domain', 'check_email']);
  assert.equal(bad.error.code, -32601);
});

test('stdio MCP: full check_domain and check_email locally (fake network)', async () => {
  const n = fakeNet();
  const engine = { resolver: new DohResolver({ fetchImpl: n.fetchImpl }), rdap: new Rdap({ fetchImpl: n.fetchImpl, now: () => NOW, cache: { at: 0, map: {} } }) };
  const d = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_domain', arguments: { domain: 'fresh.example' } } }, engine);
  assert.match(d.result.content[0].text, /HIGH_RISK/); assert.equal(d.result.structuredContent.registration.age_days, 3);
  const e = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_email', arguments: { email: 'x@mailinator.com' } } }, engine);
  assert.match(e.result.content[0].text, /RISKY/);
});
