import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
import { UpstreamError } from '../src/counterparty.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://counterparty.example.com';
export const LAZARUS = '0x098b716b8aaf21512996dc57eb0615e2383e2f96'; // OFAC SDN (Lazarus Group)
export const AYB = LAZARUS; // name kept for the shared cdp / publicbase tests: any valid address
export const CLEAN = '0x1111111111111111111111111111111111111111';
export const DOWN = '0x2222222222222222222222222222222222222222';

/** Stub engine for app-level tests (the engine itself is tested offline against a fake RPC in engine.test.js). */
export function stubEngine() {
  const calls = [];
  const check = async (input, o) => {
    calls.push([input.address, o.tier, input.chain, input.intent]);
    if (input.address === DOWN) throw new UpstreamError('Base RPC unavailable');
    const blocked = input.address === LAZARUS;
    const reasons = blocked ? [{ severity: 'danger', code: 'ofac_sdn', text: 'Listed on the US Treasury OFAC SDN list (LAZARUS GROUP, DPRK3). Do not pay or interact.' }] : [{ severity: 'good', code: 'active', text: 'Active wallet.' }];
    return { address: input.address, chain: input.chain, chain_id: 'eip155:8453', intent: input.intent, tier: o.tier, verdict: blocked ? 'block' : 'ok', confidence: 'high', summary: blocked ? `BLOCK: ${reasons[0].text}` : 'OK', reasons, facts: { kind: 'eoa' }, checks: { x402_directory: { listed: false } }, sources: { lists: 'ok', rpc: 'ok' }, missing_data: [], disclaimer: 'test', engine: 'test', checked_at: new Date(0).toISOString() };
  };
  return { check, calls };
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
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, dataFetch: net.fetchImpl, check: engine.check, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, net, engine };
}
