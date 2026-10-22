import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://leakguard.example.com';
// Public test vectors only: AWS documentation example key, BIP39 spec mnemonic, Hardhat account #0.
export const AWS_EXAMPLE = 'AKIAIOSFODNN7EXAMPLE';
export const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const HARDHAT0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const AYB = encodeURIComponent(`deploy log: aws ${AWS_EXAMPLE}`); // text query value used by the shared publicbase / cdp tests

export function fakeNet() { const calls = []; return { calls, fetchImpl: async (u) => { calls.push(String(u)); return new Response('no network in tests', { status: 599 }); } }; }
/** Fake JSON-RPC: EVM batches return balance/nonce/usdc per address from `evm`, Solana getMultipleAccounts from `sol`. `down`: chains (by rpc host substring) that fail. */
export function fakeRpc({ evm = {}, sol = {}, down = [] } = {}) {
  const calls = [];
  const fetchImpl = async (u, init) => {
    const url = String(u); calls.push(url);
    if (down.some((d) => url.includes(d))) throw new TypeError('network error (mock)');
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      return Response.json(body.map((c) => {
        const a = (c.method === 'eth_call' ? '0x' + c.params[0].data.slice(-40) : c.params[0]).toLowerCase();
        const e = evm[a] || {};
        const v = c.method === 'eth_getBalance' ? e.wei || 0n : c.method === 'eth_getTransactionCount' ? e.nonce || 0 : e.usdc || 0n;
        return { jsonrpc: '2.0', id: c.id, result: '0x' + BigInt(v).toString(16) };
      }));
    }
    if (body.method === 'getMultipleAccounts') {
      const keys = body.params[0]; const n = keys.length / 2;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { value: keys.map((k, i) => (i < n ? (sol[k] ? { lamports: sol[k].lamports || 0 } : null) : (sol[keys[i - n]]?.usdc ? { data: { parsed: { info: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: keys[i - n], tokenAmount: { amount: String(sol[keys[i - n]].usdc) } } } } } : null))) } });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1' });
  };
  return { calls, fetchImpl };
}

export function fakeFacilitator() {
  const f = { verified: [], settled: [],
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); const a = payload?.payload?.authorization; return a && a.to.toLowerCase() === req.payTo.toLowerCase() && String(a.value) === String(req.amount) ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'fake_invalid' }; },
    async settle(payload, req) { f.settled.push(req); return { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from }; },
  };
  return f;
}
export function memKv() { const m = new Map(); return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; }

export async function makeApp({ limiter, v1FetchImpl, net = fakeNet(), appOpts = {} } = {}) {
  const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, dataFetch: net.fetchImpl, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, net };
}
