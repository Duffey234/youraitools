import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../mcp/server.js';
import { MockProvider } from '../src/registry.js';

async function connect() {
  const server = buildServer({ provider: new MockProvider() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('MCP server lists check_agent', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['check_agent']);
  assert.ok(tools[0].inputSchema.properties.id);
});

test('check_agent returns VERIFIED / NOT VERIFIED with structured result', async () => {
  const c = await connect();
  const ok = await c.callTool({ name: 'check_agent', arguments: { id: 'MockVerifiedAgent1111', network: 'testnet' } });
  assert.match(ok.content[0].text, /^VERIFIED/);
  assert.match(ok.content[0].text, /\[MOCK DATA\]/);
  assert.equal(ok.structuredContent.verified, true);
  const bad = await c.callTool({ name: 'check_agent', arguments: { id: 'MockRevokedAgent22222', network: 'testnet' } });
  assert.match(bad.content[0].text, /^NOT VERIFIED: agent status is Revoked/);
});
