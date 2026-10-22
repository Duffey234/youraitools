import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/mcp-stdio.js';
import { createPaidClient, PAY_TO as CLIENT_PAY_TO } from '../src/paid.js';
import { previewAddress as litePreview, previewBatch, LIST as LITE_LIST } from '../src/lite.js';
import { previewAddress as workerPreview, LIST } from '../src/screen.js';
import { SDN } from '../src/data/sdn.js';
import { SDN_LITE } from '../src/data/sdn-lite.js';
import { generatePrivateKey } from 'viem/accounts';
import { LAZARUS_ETH, CLEAN_EVM, PAY_TO, BASE, makeApp } from './helpers.js';

const BIN = fileURLToPath(new URL('../src/mcp-stdio.js', import.meta.url));
function session(messages) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.PAYGUARD_X402_PRIVATE_KEY; delete env.X402_PRIVATE_KEY;
    const p = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'inherit'], env });
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

test('stdio MCP binary: initialize, tools/list, screen_address, unknown method', async () => {
  const [init, list, call, bad] = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_address', arguments: { address: LAZARUS_ETH } } },
    { jsonrpc: '2.0', id: 4, method: 'nope' },
  ]);
  assert.equal(init.result.serverInfo.name, 'payguard');
  assert.deepEqual(list.result.tools.map((t) => t.name), ['screen_address', 'screen_addresses']);
  assert.match(call.result.content[0].text, /SANCTIONED \(1 OFAC SDN match\)/);
  assert.doesNotMatch(call.result.content[0].text, /LAZARUS|DPRK/);
  assert.match(call.result.content[0].text, /https:\/\/api\.youraitools\.co\/payguard\/v1\/address/);
  assert.equal(bad.error.code, -32601);
});

const NOKEY = { env: {} };
test('stdio MCP offline = free-preview fields only (no entity, programs, dates), batch, bad input', async () => {
  const s = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_address', arguments: { address: LAZARUS_ETH } } }, NOKEY);
  const r = s.result.structuredContent;
  assert.equal(r.sanctioned, true); assert.equal(r.match_count, 1); assert.equal(r.chain.guess, 'evm'); assert.equal(r.tier, 'preview');
  assert.equal(r.matches, undefined); assert.equal(r.chain.checksum_valid, undefined);
  assert.doesNotMatch(JSON.stringify(s), /LAZARUS|DPRK|sdn_uid|list_date"/);
  assert.equal(r.full_details, 'https://api.youraitools.co/payguard/v1/address');
  const d = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_address', arguments: { address: CLEAN_EVM } } }, NOKEY);
  assert.match(d.result.content[0].text, /no OFAC SDN match/); assert.equal(d.result.structuredContent.sanctioned, false);
  const b = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_addresses', arguments: { addresses: [LAZARUS_ETH, CLEAN_EVM] } } }, NOKEY);
  assert.match(b.result.content[0].text, /1\/2 sanctioned/); assert.match(b.result.content[0].text, /\/payguard\/v1\/batch/);
  assert.doesNotMatch(JSON.stringify(b), /LAZARUS|DPRK/);
  const e = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_address', arguments: {} } }, NOKEY);
  assert.equal(e.result.isError, true);
});

test('npm lite snapshot: same verdicts as the Worker preview, no entity data, in sync with sdn.js', () => {
  assert.equal(SDN_LITE.publish_date, SDN.publish_date); assert.equal(SDN_LITE.address_count, SDN.address_count);
  assert.deepEqual(Object.keys(SDN_LITE.addresses).sort(), Object.keys(SDN.addresses).sort());
  for (const [k, v] of Object.entries(SDN.addresses)) assert.equal(SDN_LITE.addresses[k], v.length);
  assert.equal(SDN_LITE.entities, undefined);
  assert.equal(LITE_LIST.list_updated_at, LIST.list_updated_at);
  for (const a of [LAZARUS_ETH, CLEAN_EVM, ...Object.keys(SDN.addresses).slice(0, 200)]) {
    const l = litePreview(a), w = workerPreview(a);
    for (const f of ['address', 'sanctioned', 'match_count', 'list_updated_at', 'engine']) assert.deepEqual(l[f], w[f], `${a} ${f}`);
    assert.deepEqual(l.chain, w.chain);
  }
  assert.equal(previewBatch([LAZARUS_ETH, CLEAN_EVM]).sanctioned_count, 1);
});

test('package.json ships only the lite data and paid client', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('src/data/sdn-lite.js')); assert.ok(!pkg.files.includes('src/data/sdn.js')); assert.ok(!pkg.files.includes('src/screen.js'));
  assert.equal(pkg.exports['.'], './src/lite.js');
  for (const d of ['@x402/fetch', '@x402/evm', 'viem']) assert.equal(pkg.peerDependenciesMeta[d].optional, true);
});

test('paid mode: key set -> pays the hosted API over x402 (local fake facilitator) and returns full details', async () => {
  const { fetchApp, facilitator } = await makeApp();
  assert.equal(CLIENT_PAY_TO, PAY_TO);
  const env = { PAYGUARD_X402_PRIVATE_KEY: generatePrivateKey() };
  const client = await createPaidClient({ env, fetchImpl: fetchApp, apiBase: BASE });
  const s = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_address', arguments: { address: LAZARUS_ETH } } }, { paidClient: client });
  assert.match(s.result.content[0].text, /SANCTIONED - LAZARUS GROUP \[DPRK3\]/);
  assert.equal(s.result.structuredContent.tier, 'paid'); assert.equal(s.result.structuredContent.matches[0].entity, 'LAZARUS GROUP');
  assert.equal(facilitator.settled.length, 1); assert.equal(facilitator.settled[0].amount, '1000');
  const b = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_addresses', arguments: { addresses: [LAZARUS_ETH, CLEAN_EVM] } } }, { paidClient: client });
  assert.match(b.result.content[0].text, /1\/2 sanctioned/); assert.match(b.result.content[0].text, /LAZARUS GROUP/);
  assert.equal(facilitator.settled.length, 2); assert.equal(facilitator.settled[1].amount, '10000');
  // invalid input is rejected locally, before any payment
  const e = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_address', arguments: { address: 'x' } } }, { paidClient: client });
  assert.equal(e.result.isError, true); assert.equal(facilitator.settled.length, 2);
});

test('paid mode guards: other pay-to is refused (falls back to preview), bad key is reported without echoing it', async () => {
  const { fetchApp, facilitator } = await makeApp();
  const client = await createPaidClient({ env: { X402_PRIVATE_KEY: generatePrivateKey() }, fetchImpl: fetchApp, apiBase: BASE, payTo: '0x0000000000000000000000000000000000000001' });
  const s = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_address', arguments: { address: LAZARUS_ETH } } }, { paidClient: client });
  assert.equal(s.result.structuredContent.tier, 'preview'); assert.match(s.result.content[0].text, /Paid call failed/); assert.equal(facilitator.settled.length, 0);
  const bad = await createPaidClient({ env: { PAYGUARD_X402_PRIVATE_KEY: 'not-a-key-123' } });
  assert.match(bad.error, /not a 32-byte hex private key/); assert.doesNotMatch(bad.error, /not-a-key-123/);
  assert.equal(await createPaidClient({ env: {} }), null);
});
