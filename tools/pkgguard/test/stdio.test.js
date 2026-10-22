import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve as honoServe } from '@hono/node-server';
import { handle } from '../src/mcp-stdio.js';
import { createPaidClient, PAY_TO as CLIENT_PAY_TO } from '../src/paid.js';
import { toPackages, preview } from '../src/lite.js';
import { generatePrivateKey } from 'viem/accounts';
import { PAY_TO, makeApp } from './helpers.js';

const BIN = fileURLToPath(new URL('../src/mcp-stdio.js', import.meta.url));
const MANIFEST = JSON.stringify({ dependencies: { lodash: '4.17.15', 'flatmap-stream': '0.1.1' } });

async function localApi() {
  const { app } = await makeApp();
  return new Promise((resolve) => { const s = honoServe({ fetch: app.fetch, port: 0 }, (info) => resolve({ url: `http://127.0.0.1:${info.port}`, close: () => s.close() })); });
}
function session(messages, env) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...env }; delete e.PKGGUARD_X402_PRIVATE_KEY; delete e.X402_PRIVATE_KEY;
    const p = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'inherit'], env: e });
    const out = []; let buf = '';
    const want = messages.filter((m) => m.id !== undefined).length;
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout: ' + buf)); }, 10000);
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      if (out.length >= want) { clearTimeout(timer); p.kill(); resolve(out.sort((a, b) => a.id - b.id)); }
    });
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('stdio MCP binary against a local API: initialize, tools/list, scan_dependencies (path + contents), check_package, unknown method', async () => {
  const api = await localApi();
  const dir = mkdtempSync(join(tmpdir(), 'pkgg-')); const file = join(dir, 'package.json'); writeFileSync(file, MANIFEST);
  try {
    const [init, list, byPath, byText, one, bad] = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scan_dependencies', arguments: { path: file } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scan_dependencies', arguments: { manifest: 'requests==2.19.0' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_package', arguments: { name: 'left-pad', version: '1.3.0' } } },
      { jsonrpc: '2.0', id: 6, method: 'nope' },
    ], { PKGGUARD_API_URL: api.url });
    assert.equal(init.result.serverInfo.name, 'pkgguard');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['scan_dependencies', 'check_package']);
    assert.match(byPath.result.content[0].text, /MALICIOUS/); assert.equal(byPath.result.structuredContent.malicious_count, 1);
    assert.match(byText.result.content[0].text, /VULNERABLE/);
    assert.match(one.result.content[0].text, /CLEAN/);
    assert.equal(bad.error.code, -32601);
  } finally { api.close(); }
});

test('toPackages: manifest / packages / single, errors; preview caps at 25 locally (no request)', async () => {
  assert.equal(toPackages({ manifest: MANIFEST }).packages.length, 2);
  assert.equal(toPackages({ name: 'lodash', version: '4.17.15' }).single, true);
  assert.match(toPackages({ name: 'lodash' }).error, /version/);
  assert.match(toPackages({}).error, /provide/);
  let called = false;
  const r = await preview(Array(26).fill({ ecosystem: 'npm', name: 'a', version: '1.0.0' }), { fetchImpl: async () => { called = true; } });
  assert.equal(r.error, 'too_many'); assert.equal(called, false);
});

test('paid client: no key -> null; bad key -> error (key never echoed); pay-to pinned to PkgGuard', async () => {
  assert.equal(await createPaidClient({ env: {} }), null);
  const bad = await createPaidClient({ env: { PKGGUARD_X402_PRIVATE_KEY: 'not-a-key-secret123' } });
  assert.match(bad.error, /not a 32-byte hex/); assert.doesNotMatch(bad.error, /secret123/);
  assert.equal(CLIENT_PAY_TO, PAY_TO);
  const c = await createPaidClient({ env: { PKGGUARD_X402_PRIVATE_KEY: generatePrivateKey() } });
  assert.match(c.payer, /^0x[0-9a-fA-F]{40}$/); assert.equal(c.apiBase, 'https://api.youraitools.co/pkgguard');
});

test('paid mode end to end against the local app (fake facilitator): full advisories over x402', async () => {
  const { app, facilitator } = await makeApp();
  const fetchImpl = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  const env = { PKGGUARD_X402_PRIVATE_KEY: generatePrivateKey(), PKGGUARD_API_URL: 'https://pkgguard.example.com' };
  const client = await createPaidClient({ env, fetchImpl, apiBase: 'https://pkgguard.example.com' });
  const r = await client.scan(toPackages({ manifest: MANIFEST }).packages);
  assert.equal(r.result.verdict, 'malicious'); assert.equal(r.result.packages[0].name, 'flatmap-stream');
  const out = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_package', arguments: { name: 'lodash', version: '4.17.15' } } }, { env, fetchImpl });
  assert.equal(out.result.isError, false); assert.equal(out.result.structuredContent.verdict, 'vulnerable'); assert.ok(out.result.structuredContent.payer);
  assert.deepEqual(facilitator.settled.map((x) => x.amount), ['3000', '1000']);
});
