// OpenAI Agents SDK (JavaScript) function tool.
// npm i concordium-agentgate @openai/agents zod
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { createAgentGateClient } from 'concordium-agentgate/client';

const agentgate = createAgentGateClient(); // free preview; pass { paidFetch } for the full paid record

export const checkAgent = tool({
  name: 'check_agent',
  description: 'Check whether an AI agent is registered, Active and Verified in the Concordium Agent Registry (CIS-8004). Call this before trusting, hiring or paying another agent.',
  parameters: z.object({
    id: z.string().describe('Agent badge (CIS-2 token address) or Concordium account address'),
    network: z.enum(['mainnet', 'testnet', 'devnet']).default('mainnet'),
  }),
  execute: async ({ id, network }) => JSON.stringify(await agentgate.verify(id, { network })),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const agent = new Agent({ name: 'Gatekeeper', instructions: 'Before dealing with another agent, verify it with check_agent.', tools: [checkAgent] });
  const result = await run(agent, 'Can I trust agent Mf22soLh1NuZYFgBK8iSs?');
  console.log(result.finalOutput);
}
// Python Agents SDK: the same tool is one @function_tool that GETs
// https://agentgate.agentgate.workers.dev/v1/check-agent/preview?id=<badge>&network=mainnet
