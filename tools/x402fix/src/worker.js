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
import { headAsGet } from './head.js';
import { siblingFetch } from './sibling.js';
export { StatsCounter } from './counter-do.js'; // usage counters (SQLite Durable Object, no KV writes)
let handler;
// CounterpartyCheck (service binding COUNTERPARTY): free preview verdict on each payTo in the check tier; best effort.
const counterpartyOf = (env) => (env.COUNTERPARTY ? async (address, chain) => {
  const r = await env.COUNTERPARTY.fetch(`https://counterparty.agentgate.workers.dev/v1/preview?address=${encodeURIComponent(address)}&chain=${chain}&intent=pay`, { headers: { accept: 'application/json', 'x-forwarded-for': 'x402fix' } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.verdict ? { verdict: j.verdict, confidence: j.confidence, kind: j.kind } : null;
} : undefined);
export default {
  // watchdog: a last-resort 503 (never charged) instead of a hung request; see deadline.js for the budgets.
  fetch: watchdog((request, env, ctx) => {
    const trust = x402TrustResponse(request, env); // x402-trust.com domain proof (public key)
    if (trust) return trust;
    if (!handler) {
      const stats = new Stats(undefined, { counter: env.COUNTER }); // no KV at all; one counter batch shared by both app instances
      handler = publicBaseHandler(env, (publicUrl) => createApp({ ...configFromEnv(env), enabledNetworks: env.ENABLED_NETWORKS ?? DEFAULT_ENABLED, solanaPayTo: env.SOLANA_PAY_TO || undefined, counterparty: counterpartyOf(env), dataFetch: siblingFetch(env, (req) => headAsGet(handler)(req, env, { waitUntil() {}, passThroughOnException() {} })), stats, publicUrl }));
    }
    return headAsGet(handler)(request, env, ctx); // HEAD = GET without body (see head.js)
  }),
};
