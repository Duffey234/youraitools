// Cloudflare Workers entry (wrangler deploy). Vars come from wrangler.toml [vars].
// publicBaseHandler: requests from the api.youraitools.co proxy (allowlisted X-Forwarded-Host + this Worker's
// X-Forwarded-Prefix) get an app whose public URLs are https://api.youraitools.co/<prefix>; all other requests get
// the unchanged workers.dev app. See publicbase.js.
import { createApp } from './app.js';
import { DEFAULT_ENABLED } from './networks.js';
import { configFromEnv } from './config.js';
import { watchdog } from './deadline.js';
import { Stats } from './stats.js';
import { publicBaseHandler } from './publicbase.js';
import { x402TrustResponse } from './x402trust.js';
export { StatsCounter } from './counter-do.js'; // usage counters (SQLite Durable Object, no KV writes)
let handler;
export default {
  // watchdog: a last-resort 503 (never charged) instead of a hung request; see deadline.js for the budgets.
  fetch: watchdog((request, env, ctx) => {
    const trust = x402TrustResponse(request, env); // x402-trust.com domain proof (public key)
    if (trust) return trust;
    if (!handler) {
      const stats = new Stats(env.STATS, { counter: env.COUNTER }); // one counter batch shared by both app instances
      handler = publicBaseHandler(env, (publicUrl) => createApp({ ...configFromEnv(env), enabledNetworks: env.ENABLED_NETWORKS ?? DEFAULT_ENABLED, solanaPayTo: env.SOLANA_PAY_TO || undefined, stats, publicUrl }));
    }
    if (request.method === 'HEAD') {
      // HEAD = the GET response (incl. the 402 PAYMENT-REQUIRED challenge) without a body (402 Index probes with HEAD).
      // Payment headers are dropped so a HEAD can never pay.
      const h = new Headers(request.headers);
      for (const k of ['payment-signature', 'x-payment', 'authorization', 'x-credits-key', 'x-credit-token']) h.delete(k); // HEAD never pays or spends credits
      return Promise.resolve(handler(new Request(request.url, { method: 'GET', headers: h }), env, ctx))
        .then((res) => new Response(null, { status: res.status, headers: res.headers }));
    }
    return handler(request, env, ctx);
  }),
};
