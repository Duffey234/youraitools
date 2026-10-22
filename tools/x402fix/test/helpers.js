import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
import { UpstreamError } from '../src/doctor.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://x402fix.example.com';
export const TARGET = 'https://api.example.com/v1/data';
export const BROKEN = 'https://broken.example.com/v1/data';
export const DOWN = 'https://down.example.com/v1/data';
export const AYB = encodeURIComponent(TARGET); // name kept for the shared cdp / publicbase tests: any valid ?url= value

/** Stub engine for app-level tests (the engine itself is tested offline against a fake target in engine.test.js). */
export function stubEngine() {
  const calls = [];
  const report = (input, tier) => {
    const broken = input.url === BROKEN;
    const fixes = broken ? [{ n: 1, severity: 'error', id: 'get_200', problem: 'Unpaid GET answers 200', fix: 'Mount the middleware.' }] : [];
    return { url: input.url, tier, method: input.method || 'GET', grade: broken ? 'F' : 'A', score: broken ? 30 : 100, status: broken ? 'broken' : 'pass', summary: broken ? 'BROKEN: Unpaid GET answers 200.' : 'A (100/100): x402 v2+v1, Base. No problems found.', counts: { errors: broken ? 1 : 0, warnings: 0, info: 0, passed: 10 }, x402: { v2: !broken, v1: !broken, networks: broken ? [] : ['Base'], price_usd: 0.01, bazaar: !broken }, probes: { get: broken ? 200 : 402 }, fixes, checks: [{ severity: broken ? 'error' : 'pass', id: 'get', area: 'transport', title: 't' }], missing_data: [], disclaimer: 'test', engine: 'test', checked_at: new Date(0).toISOString() };
  };
  const check = async (input, o) => { calls.push([input.url, o.tier]); if (input.url === DOWN) throw new UpstreamError('target probe crashed'); return report(input, o.tier); };
  const site = async (input) => { calls.push([input.url, 'site']); return { ...report(input, 'site'), routes: [{ url: `${input.url}/v1/a`, grade: 'A' }] }; };
  return { check, site, calls };
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
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, dataFetch: net.fetchImpl, check: engine.check, site: engine.site, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, net, engine };
}
