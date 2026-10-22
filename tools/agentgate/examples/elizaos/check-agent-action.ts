// ElizaOS action: "CHECK_AGENT". Add it to a plugin's `actions` array.
// npm i concordium-agentgate
import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { createAgentGateClient } from 'concordium-agentgate/client';

const agentgate = createAgentGateClient(); // free preview; pass { paidFetch } for the full paid record
const BADGE = /\b([1-9A-HJ-NP-Za-km-z]{50}|[1-9A-HJ-NP-Za-km-z]{16,30})\b/;

export const checkAgentAction: Action = {
  name: 'CHECK_AGENT',
  similes: ['VERIFY_AGENT', 'IS_AGENT_VERIFIED', 'CONCORDIUM_AGENT_CHECK'],
  description: 'Check whether an AI agent is registered, Active and Verified in the Concordium Agent Registry (CIS-8004).',
  validate: async (_rt: IAgentRuntime, message: Memory) => BADGE.test(message.content?.text ?? ''),
  handler: async (_rt: IAgentRuntime, message: Memory, _state?: State, _opts?: unknown, callback?: HandlerCallback) => {
    const id = (message.content?.text ?? '').match(BADGE)?.[1];
    if (!id) return { success: false, text: 'No agent badge found in the message.' };
    const r = await agentgate.verify(id);
    const text = r.verified
      ? `Agent ${id} is VERIFIED by Concordium (registered, Active, Agent Card matches on-chain).`
      : `Agent ${id} is NOT verified: ${(r.issues || []).filter((i: any) => i.severity === 'error').map((i: any) => i.message).join('; ') || 'checks failed'}.`;
    await callback?.({ text, content: r });
    return { success: true, text, data: r };
  },
  examples: [[
    { name: '{{user1}}', content: { text: 'Is agent Mf22soLh1NuZYFgBK8iSs legit?' } },
    { name: '{{agent}}', content: { text: 'Agent Mf22soLh1NuZYFgBK8iSs is VERIFIED by Concordium.', actions: ['CHECK_AGENT'] } },
  ]],
};
