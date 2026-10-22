import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
for (const base of ['https://payguard.agentgate.workers.dev', ...(process.argv[2] ? [process.argv[2]] : [])]) {
  const u = `${base}/v1/address?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
  const r = await fetch(u, { headers: { 'x-payguard-smoke': '1' } });
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString());
  const a = pr.accepts[0];
  console.log(base, r.status, pr.x402Version, pr.resource.url, a.amount, a.network, a.payTo, a.asset, !!pr.extensions?.bazaar);
  // Unfunded throwaway payer: the facilitator must reject at /verify (no funds can move).
  const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
  try { const p = await pay(u, { headers: { 'x-payguard-smoke': '1' } }); const h = p.headers.get('payment-required'); console.log(' unfunded payer ->', p.status, h ? JSON.parse(Buffer.from(h, 'base64').toString()).error : (await p.text()).slice(0, 200)); } catch (e) { console.log(' unfunded payer -> client error:', e.message.slice(0, 300)); }
}
