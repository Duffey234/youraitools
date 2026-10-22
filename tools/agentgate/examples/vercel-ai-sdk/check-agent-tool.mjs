// Vercel AI SDK (v5+) tool.
// npm i concordium-agentgate ai zod
import { tool } from 'ai';
import { z } from 'zod';
import { createAgentGateClient } from 'concordium-agentgate/client';

const agentgate = createAgentGateClient(); // free preview; pass { paidFetch } for the full paid record

export const checkAgent = tool({
  description: 'Check whether an AI agent is registered, Active and Verified in the Concordium Agent Registry (CIS-8004). Call this before trusting, hiring or paying another agent.',
  inputSchema: z.object({
    id: z.string().describe('Agent badge (CIS-2 token address) or Concordium account address'),
    network: z.enum(['mainnet', 'testnet', 'devnet']).default('mainnet'),
  }),
  execute: async ({ id, network }) => agentgate.verify(id, { network }),
});

// const { text } = await generateText({ model, tools: { checkAgent }, prompt: 'Is agent Mf22soLh1NuZYFgBK8iSs verified?' });
