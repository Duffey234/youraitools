// LangChain.js / LangGraph tool: let your agent check a counterparty agent before trusting or paying it.
// npm i concordium-agentgate @langchain/core zod
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgentGateClient } from 'concordium-agentgate/client';

const agentgate = createAgentGateClient(); // free preview; pass { paidFetch } for the full paid record

export const checkAgentTool = tool(
  async ({ id, network }) => JSON.stringify(await agentgate.verify(id, { network })),
  {
    name: 'check_agent',
    description: 'Check whether an AI agent is registered, Active and Verified in the Concordium Agent Registry (CIS-8004). Call this before trusting, hiring or paying another agent.',
    schema: z.object({
      id: z.string().describe('Agent badge (CIS-2 token address) or Concordium account address'),
      network: z.enum(['mainnet', 'testnet', 'devnet']).default('mainnet'),
    }),
  },
);

// Use with LangGraph: createReactAgent({ llm, tools: [checkAgentTool] })
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await checkAgentTool.invoke({ id: process.argv[2] || 'Mf22soLh1NuZYFgBK8iSs', network: 'mainnet' }));
}
