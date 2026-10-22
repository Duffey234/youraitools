import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve as honoServe } from '@hono/node-server';
import { createPaidClient, PAY_TO as CLIENT_PAY_TO } from '../src/paid.js';
import { toBody } from '../src/lite.js';
import { generatePrivateKey } from 'viem/accounts';
import { PAY_TO, makeApp } from './helpers.js';

const BIN = fileURLToPath(new URL('../src/mcp-stdio.js', import.meta.url));
async function localApi() {
  const { app, facilitator } = await makeApp();
  return new Promise((resolve) => { const s = honoServe({ fetch: app.fetch, port: 0 }, (info) => resolve({ url: `http://127.0.0.1:${info.port}`, facilitator, close: () => s.close() })); });
}
function session(messages, env) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...env }; if (!env.SIGNCHECK_X402_PRIVATE_KEY) delete e.SIGNCHECK_X402_PRIVATE_KEY; delete e.X402_PRIVATE_KEY;
    const p = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'inherit'], env: e });
    const out = []; let buf = '';
    const want = messages.filter((m) => m.id !== undefined).length;
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout: ' + buf)); }, 15000);
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      if (out.length >= want) { clearTimeout(timer); p.kill(); resolve(out.sort((a, b) => a.id - b.id)); }
    });
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('stdio MCP binary against a local API: initialize, tools/list, check_signature (preview), bad input, unknown method', async () => {
  const api = await localApi();
  try {
    const [init, list, call, bad, unk] = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_signature', arguments: { tx: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' } } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_signature', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'nope' },
    ], { SIGNCHECK_API_URL: api.url });
    assert.equal(init.result.serverInfo.name, 'signcheck');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['check_signature']);
    assert.match(call.result.content[0].text, /CAUTION/); assert.equal(call.result.structuredContent.tier, 'preview');
    assert.equal(bad.result.isError, true);
    assert.equal(unk.error.code, -32601);
  } finally { api.close(); }
});

test('toBody validates locally', () => {
  assert.ok(toBody({ tx: { to: '0x1' } }).body); assert.ok(toBody({}).error); assert.ok(toBody({ chain: 'base' }).error);
});

test('paid client: no key -> null; bad key -> error (key never echoed); pay-to pinned', async () => {
  assert.equal(await createPaidClient({ env: {} }), null);
  const bad = await createPaidClient({ env: { SIGNCHECK_X402_PRIVATE_KEY: 'not-a-key-12345' } });
  assert.ok(bad.error && !bad.error.includes('not-a-key-12345'));
  assert.equal(CLIENT_PAY_TO, PAY_TO);
});

test('paid mode end to end through the stdio binary against the local app (fake facilitator): full result over x402', async () => {
  const api = await localApi();
  try {
    const [, call] = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_signature', arguments: { tx: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', from: '0x2222222222222222222222222222222222222222' } } } },
    ], { SIGNCHECK_API_URL: api.url, SIGNCHECK_X402_PRIVATE_KEY: generatePrivateKey() });
    assert.equal(call.result.isError, false, JSON.stringify(call));
    assert.equal(call.result.structuredContent.tier, 'full'); assert.match(call.result.content[0].text, /SPENDER_IS_EOA/);
    assert.equal(api.facilitator.settled.length, 1);
  } finally { api.close(); }
});
