import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
import { InputError } from '../src/analyze.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://tokenverdict.example.com';
export const BRETT = '0x532f27101965dd16442e59d40670faf5ebb142e4';
export const AYB = '0x826f32fc853553b3b8db8ed6ca41c8409c2adeea';
export const EOA = '0x1111111111111111111111111111111111111111';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
export const FIX = { [BRETT]: { quick: fx('brett-quick'), deep: fx('brett-deep') }, [AYB]: { quick: fx('ayb-quick'), deep: fx('ayb-deep') } };

/** Offline stub of analyzeToken, replaying reports recorded from real Base mainnet runs (test/fixtures). */
export function stubEngine() {
  const calls = [];
  const analyze = async (token, o) => {
    calls.push([token, o.tier]);
    if (token === EOA) throw new InputError('No contract at this address on Base mainnet (EOA or wrong chain). Not charged.', 422, 'not_a_contract');
    const f = FIX[token]; if (!f) throw new InputError('Base RPC unavailable (test). Not charged; retry shortly.', 503, 'rpc_unavailable');
    return structuredClone(o.tier === 'deep' ? f.deep : f.quick);
  };
  return { analyze, calls };
}
export function fakeNet() { const calls = []; return { calls, fetchImpl: async (u) => { calls.push(String(u)); return new Response('no network in tests', { status: 599 }); } }; }

export function fakeFacilitator() {
  const f = { verified: [], settled: [],
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); const a = payload?.payload?.authorization; return a && a.to.toLowerCase() === req.payTo.toLowerCase() && String(a.value) === String(req.amount) ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'fake_invalid' }; },
    async settle(payload, req) { f.settled.push(req); return { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from }; },
  };
  return f;
}
export function memKv() { const m = new Map(); return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; }

export async function makeApp({ limiter, v1FetchImpl, net = fakeNet(), engine = stubEngine(), appOpts = {} } = {}) {
  const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, dataFetch: net.fetchImpl, analyze: engine.analyze, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, net, engine };
}
