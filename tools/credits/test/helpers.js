import { createApp } from '../src/app.js';
import { AccountCore } from '../src/account.js';
import { DEFAULT_ENABLED, supportedKinds } from '../src/networks.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const BASE = 'https://credits.example.com';
export const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
export const dec = (h) => JSON.parse(Buffer.from(h, 'base64').toString());

/** Fake Durable Object namespace: one AccountCore per name, calls serialised per object (like DO input gates). */
export function fakeNs({ delayMs = 0 } = {}) {
  const objs = new Map(); const mems = new Map();
  const sleep = () => (delayMs ? new Promise((r) => setTimeout(r, Math.random() * delayMs)) : Promise.resolve());
  return {
    mems,
    idFromName: (n) => n,
    get(id) {
      let o = objs.get(id);
      if (!o) {
        const mem = new Map(); mems.set(id, mem);
        const core = new AccountCore({ get: async (k) => { await sleep(); return mem.has(k) ? structuredClone(mem.get(k)) : undefined; }, put: async (k, v) => { await sleep(); mem.set(k, structuredClone(v)); }, delete: async (k) => mem.delete(k), deleteAll: async () => mem.clear() });
        let q = Promise.resolve();
        o = new Proxy({}, { get: (_, m) => m === 'then' ? undefined : (arg) => { const p = q.then(() => core[m](arg || {})); q = p.catch(() => {}); return p; } });
        objs.set(id, o);
      }
      return o;
    },
  };
}
export function fakeFacilitator({ settleOk = true, cfg = {} } = {}) {
  const f = { verified: [], settled: [], settleOk,
    async getSupported() { return { kinds: supportedKinds(cfg), extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); const a = payload?.payload?.authorization; return a && a.to.toLowerCase() === req.payTo.toLowerCase() && String(a.value) === String(req.amount) ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'fake_invalid' }; },
    async settle(payload, req) { f.settled.push(req); return f.settleOk ? { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from } : { success: false, errorReason: 'fake_settle_failed', transaction: '', network: req.network }; },
  };
  return f;
}
export const memStats = () => { const hits = []; return { hits, hit(e) { hits.push(...[].concat(e)); }, async summary() { return { enabled: false }; }, enabled: false }; };
export function build({ settleOk = true, multichain = false, delayMs = 0, rpcFetch } = {}) {
  const cfg = { payTo: PAY_TO, network: 'eip155:8453', ...(multichain ? { enabledNetworks: DEFAULT_ENABLED, solanaPayTo: 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte' } : {}) };
  const facilitator = fakeFacilitator({ settleOk, cfg }); const accounts = fakeNs({ delayMs }); const stats = memStats();
  const app = createApp({ ...cfg, facilitatorClient: facilitator, publicUrl: BASE, accounts, stats, rpcFetch });
  const f = (path, init = {}) => app.fetch(new Request(`${BASE}${path}`, init));
  return { app, f, facilitator, accounts, stats };
}
/** Pay a route: fetch the 402, build a v2 PAYMENT-SIGNATURE for the Base entry (the fake facilitator checks to/value). */
export async function pay(f, path, { method = 'POST', headers = {} } = {}) {
  const r0 = await f(path, { method, headers });
  if (r0.status !== 402) return { r0 };
  const pr = dec(r0.headers.get('payment-required'));
  const accepted = pr.accepts[0];
  const payload = { x402Version: 2, resource: pr.resource, accepted, payload: { signature: '0x' + '11'.repeat(65), authorization: { from: '0x' + '22'.repeat(20), to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + '33'.repeat(32) } } };
  const r = await f(path, { method, headers: { ...headers, 'payment-signature': enc(payload) } });
  return { r0, r, pr };
}
