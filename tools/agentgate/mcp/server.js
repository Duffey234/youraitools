#!/usr/bin/env node
// AgentGate MCP server (stdio). Exposes one tool: check_agent.
//   npx -y -p concordium-agentgate agentgate-mcp -> real Concordium public registry
//   AGENTGATE_MOCK=1 agentgate-mcp -> MOCK fixtures (offline, not real data)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConcordiumPublicProvider, MockProvider, CachedProvider } from '../src/registry.js';

export function buildServer({ provider } = {}) {
  const p = provider || (process.env.AGENTGATE_MOCK === '1' ? new MockProvider() : new CachedProvider(new ConcordiumPublicProvider()));
  const server = new McpServer({ name: 'agentgate', version: '0.2.3' });
  server.tool(
    'check_agent',
    'Check whether an AI agent is registered in the Concordium Agent Registry (CIS-8004), Active, and Verified by Concordium (Agent Card hash matches on-chain). Accepts a badge (CIS-2 token address, e.g. Mf22soLh1NuZYFgBK8iSs) or a Concordium owner account address.',
    {
      id: z.string().min(1).describe('Badge (CIS-2 token address, short or CAIP-19 form) or Concordium account address'),
      network: z.enum(['mainnet', 'testnet', 'devnet']).default('mainnet').describe('Concordium network'),
    },
    async ({ id, network }) => {
      try {
        const r = await p.check(id, { network });
        const line = r.verified ? `VERIFIED: agent ${r.tokenAddress ?? r.id} (token ${r.tokenId}) on ${r.network} is Active and its Agent Card matches on-chain.` : `NOT VERIFIED: ${r.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ') || 'checks failed'}`;
        return { content: [{ type: 'text', text: `${line}${r.mock ? ' [MOCK DATA]' : ''}\n\n${JSON.stringify(r, null, 2)}` }], structuredContent: r };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `registry error: ${e.message}` }] };
      }
    },
  );
  return server;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('agentgate-mcp')) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
