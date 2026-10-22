// Pay $0.005 USDC on Base for the full record, from any x402 v2 client.
// npm i concordium-agentgate @x402/fetch @x402/evm viem   (KEY = a funded Base key; keep it in env, never in code)
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { createAgentGateClient } from 'concordium-agentgate/client';

const paidFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.KEY)) }] });
const agentgate = createAgentGateClient({ paidFetch });
console.log(await agentgate.check(process.argv[2] || 'Mf22soLh1NuZYFgBK8iSs'));
