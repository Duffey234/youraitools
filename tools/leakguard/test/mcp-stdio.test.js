import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, TOOLS } from '../src/mcp-stdio.js';
import { HARDHAT0 } from './helpers.js';

test('stdio MCP: local scan + redact (offline), no paid tool without a key', async () => {
  const env = {};
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { env });
  assert.equal(init.result.serverInfo.name, 'leakguard');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { env });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  const s = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scan_for_leaks', arguments: { text: `PRIVATE_KEY=${HARDHAT0}` } } }, { env });
  assert.equal(s.result.structuredContent.verdict, 'WALLET_KEY_EXPOSED'); assert.equal(s.result.structuredContent.redacted, undefined);
  assert.ok(!JSON.stringify(s).includes('ac0974bec39a'));
  const r = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'redact_text', arguments: { text: `PRIVATE_KEY=${HARDHAT0}` } } }, { env });
  assert.equal(r.result.structuredContent.redacted, 'PRIVATE_KEY=[REDACTED:evm_private_key]');
  const p = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_leaked_wallets', arguments: { text: 'x' } } }, { env });
  assert.equal(p.result.isError, true);
});
