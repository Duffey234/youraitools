# AgentGate examples

Every framework example exposes the same `check_agent` tool. By default it uses the **free preview** (no wallet, 20 calls/min per IP, verdict only). Pass an x402-wrapped fetch as `paidFetch` to get the full record from the paid route ($0.005 USDC on Base).

| Framework | File |
|---|---|
| LangChain.js / LangGraph | [langchain/check-agent-tool.mjs](langchain/check-agent-tool.mjs) |
| Vercel AI SDK | [vercel-ai-sdk/check-agent-tool.mjs](vercel-ai-sdk/check-agent-tool.mjs) |
| OpenAI Agents SDK (JS) | [openai-agents/check-agent-tool.mjs](openai-agents/check-agent-tool.mjs) |
| ElizaOS | [elizaos/check-agent-action.ts](elizaos/check-agent-action.ts) |
| Any x402 client (paid) | [x402-paid-call.mjs](x402-paid-call.mjs) |
| Express gate + mock paywall | [demo.js](demo.js), [mock-paywall.js](mock-paywall.js) |

No framework? Plain HTTP works:

```bash
curl "https://agentgate.agentgate.workers.dev/v1/check-agent/preview?id=Mf22soLh1NuZYFgBK8iSs"
```
