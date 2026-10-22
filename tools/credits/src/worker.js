// Cloudflare Workers entry. Default export: the HTTP app (packs, balance, docs). Named entrypoint CreditsGate: the RPC
// the tool Workers call over a service binding to debit/refund credits (see src/credits-gate.js in any tool).
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApp } from './app.js';
import { DEFAULT_ENABLED } from './networks.js';
import { configFromEnv } from './config.js';
import { watchdog } from './deadline.js';
import { Stats } from './stats.js';
import { publicBaseHandler } from './publicbase.js';
import { x402TrustResponse } from './x402trust.js';
import { gateOps } from './gate.js';
export { StatsCounter } from './counter-do.js';
export { CreditAccount } from './account-do.js';

let handler; let stats;
const statsFor = (env) => (stats ||= new Stats(undefined, { counter: env.COUNTER }));

export default {
  fetch: watchdog((request, env, ctx) => {
    const trust = x402TrustResponse(request, env);
    if (trust) return trust;
    if (!handler) handler = publicBaseHandler(env, (publicUrl) => createApp({ ...configFromEnv(env), enabledNetworks: env.ENABLED_NETWORKS ?? DEFAULT_ENABLED, solanaPayTo: env.SOLANA_PAY_TO || undefined, stats: statsFor(env), publicUrl }));
    if (request.method === 'HEAD') {
      // HEAD = the GET response without a body; payment and key headers are dropped so a HEAD can never pay or debit.
      const h = new Headers(request.headers);
      for (const k of ['payment-signature', 'x-payment', 'authorization', 'x-credits-key', 'x-credit-token']) h.delete(k);
      return Promise.resolve(handler(new Request(request.url, { method: 'GET', headers: h }), env, ctx))
        .then((res) => new Response(null, { status: res.status, headers: res.headers }));
    }
    return handler(request, env, ctx);
  }),
};

export class CreditsGate extends WorkerEntrypoint {
  ops() { return gateOps(this.env.ACCOUNTS, statsFor(this.env), (p) => this.ctx.waitUntil(p)); }
  debit(arg) { return this.ops().debit(arg); }
  refund(arg) { return this.ops().refund(arg); }
}
