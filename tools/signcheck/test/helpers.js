import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://signcheck.example.com';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EOA = '0x1111111111111111111111111111111111111111';
export const ME = '0x2222222222222222222222222222222222222222';
export const ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
export const UNLABELLED = '0x3333333333333333333333333333333333333333';
export const NFT = '0x4444444444444444444444444444444444444444';
export const REVERTER = '0x5555555555555555555555555555555555555555';
export const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const approveData = (spender, amount = 'f'.repeat(64)) => `0x095ea7b3${pad(spender)}${amount.length === 64 ? amount : pad(BigInt(amount).toString(16))}`;
export const transferData = (to, amount) => `0xa9059cbb${pad(to)}${pad(BigInt(amount).toString(16))}`;
const CONTRACTS = new Set([USDC, ROUTER, UNLABELLED, NFT, REVERTER, '0x000000000022d473030f116ddee9f6b43ac78ba3'].map((a) => a.toLowerCase()));
const abiStr = (s) => { const h = Buffer.from(s).toString('hex'); return `0x${pad('20')}${pad(s.length.toString(16))}${h.padEnd(64, '0')}`; };
const ERR = (msg) => `0x08c379a0${pad('20')}${pad(msg.length.toString(16))}${Buffer.from(msg).toString('hex').padEnd(64, '0')}`;

/** Fake JSON-RPC (Base) + openchain 4-byte directory: { fetchImpl, calls }. */
export function fakeNet({ down = false } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input)); calls.push(url.href);
    if (url.hostname === 'api.openchain.xyz') return Response.json({ ok: true, result: { function: Object.fromEntries(url.searchParams.get('function').split(',').map((s) => [s, s === '0xdeadbeef' ? [{ name: 'claimAirdrop()' }] : []])) } });
    if (down) throw new Error('connect ECONNREFUSED');
    const reqs = JSON.parse(init.body);
    const out = (Array.isArray(reqs) ? reqs : [reqs]).map((r) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: r.id, result });
      if (r.method === 'eth_blockNumber') return ok('0x10');
      if (r.method === 'eth_getCode') return ok(CONTRACTS.has(r.params[0].toLowerCase()) ? '0x6080604052' : '0x');
      if (r.method === 'eth_call') {
        const { to, data, from } = r.params[0];
        if (!from && data === '0x95d89b41') return ok(to.toLowerCase() === USDC.toLowerCase() ? abiStr('USDC') : abiStr('TKN'));
        if (!from && data === '0x313ce567') return ok(`0x${pad('6')}`);
        if (!from && data === '0x06fdde03') return ok(abiStr('USD Coin'));
        if (to.toLowerCase() === REVERTER.toLowerCase()) return { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted', data: ERR('Ownable: caller is not the owner') } };
        return ok(`0x${pad('1')}`);
      }
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'nope' } };
    });
    return Response.json(Array.isArray(reqs) ? out : out[0]);
  };
  return { fetchImpl, calls };
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

export const NOW = Date.parse('2026-10-22T12:00:00Z');
export async function makeApp({ limiter, v1FetchImpl, net = fakeNet(), appOpts = {} } = {}) {
  const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const app = createApp({ facilitatorClient: facilitator, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, rpcFetch: net.fetchImpl, now: () => NOW, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, facilitator, stats, net };
}
