import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
import { InputError } from '../src/sol.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://solverdict.example.com';
export const BRETT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK (recorded real run)
export const AYB = 'HxxZZHoRuvNT2GHhQcoSNFVKuBM19TmoAgkmktoV6YDV'; // Token-2022 trap (permanent delegate, hook, fee; mocked chain data)
export const EOA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // a wallet, not a mint
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
export const FIX = { [BRETT]: { check: fx('bonk-check') }, [AYB]: { check: fx('trap-check') } };

/** Offline stub of analyzeMint, replaying reports from test/fixtures. */
export function stubEngine() {
  const calls = [];
  const analyze = async (token, o) => {
    calls.push([token, o.tier]);
    if (token === EOA) throw new InputError('This address is not an SPL token mint. Not charged.', 422, 'not_a_mint');
    const f = FIX[token]; if (!f) throw new InputError('Solana RPC unavailable (test). Not charged; retry shortly.', 503, 'rpc_unavailable');
    return structuredClone(f.check);
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
