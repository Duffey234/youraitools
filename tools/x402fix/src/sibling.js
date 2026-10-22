// Cloudflare does not let a Worker fetch another workers.dev Worker on the same account (nor itself), so probes of our own
// tools go through service bindings (the URL is unchanged, so `resource` still matches) and self-probes stay in-process.
// Generic: <name>.agentgate.workers.dev and api.youraitools.co/<name>/... map to the binding named after the tool
// (upper-case, non-alphanumerics dropped: solverdict -> SOLVERDICT, x402-template -> X402TEMPLATE) unless listed below.
// A new tool only needs its [[services]] binding in wrangler.toml (and a redeploy), no code change.
// If one of our own targets has no binding, we try a plain fetch once; a loopback / Cloudflare refusal becomes an
// OwnProbeUnavailable error (message starts with SELF_PROBE_UNAVAILABLE) and the engine reports 'incomplete', never F.
export const SELF_PROBE_UNAVAILABLE = 'self_probe_unavailable';
const SELF_HOST = 'x402fix.agentgate.workers.dev';
const OWN_SUFFIX = '.agentgate.workers.dev';
// exceptions to the naming convention (host name / proxy prefix -> binding)
const SIBLINGS = { 'counterparty.agentgate.workers.dev': 'COUNTERPARTY' };
// api.youraitools.co/<prefix>/... is the Pages proxy in front of the same Workers. When x402fix itself was reached through
// that proxy, Cloudflare refuses the subrequest back into the zone, so these go to the binding with the proxy's own
// X-Forwarded-* headers (allowlisted by each Worker's publicbase.js): same bytes as through the proxy.
const PUBLIC_HOST = 'api.youraitools.co';
const PREFIXES = { counterpartycheck: 'COUNTERPARTY', x402fix: 'SELF' };
const PREFIX_WORKER = { counterpartycheck: 'counterparty' }; // proxy prefix -> Worker name when they differ
const conv = (name) => String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
const bound = (env, b) => (b && env[b] && typeof env[b].fetch === 'function' ? env[b] : null);
export function isOwnUrl(url) {
  try { const h = new URL(url).host.toLowerCase(); return h === PUBLIC_HOST || h.endsWith(OWN_SUFFIX); } catch { return false; }
}
// A Cloudflare refusal of a same-account / same-zone subrequest (error 1042 / 1014 / 1000-range page, or a thrown fetch)
const CF_ERROR = /error code:\s*1\d{3}/i;
async function ownFallback(input, init) {
  let r;
  try { r = await globalThis.fetch(input, init); } catch (e) { throw new Error(`${SELF_PROBE_UNAVAILABLE}: own tool not reachable from this Worker (${String(e?.message || e).slice(0, 80)}); add its service binding to x402fix`); }
  if (r.status !== 402 && (r.status >= 500 || r.status === 403 || r.status === 404 || r.status === 409)) {
    const text = await r.clone().text().catch(() => '');
    if (r.status >= 520 || CF_ERROR.test(text.slice(0, 2000)) || /^1\d{3}$/.test(r.headers.get('cf-error-code') || '')) throw new Error(`${SELF_PROBE_UNAVAILABLE}: own tool not reachable from this Worker (HTTP ${r.status} loopback refusal); add its service binding to x402fix`);
  }
  return r;
}
export function siblingFetch(env, self) {
  return (input, init) => {
    let host = '', u;
    try { u = new URL(typeof input === 'string' ? input : input.url); host = u.host.toLowerCase(); } catch { /* let fetch fail */ }
    if (host === PUBLIC_HOST) {
      const m = u.pathname.match(/^\/([a-z0-9-]+)(\/.*)?$/);
      if (m) {
        const b = PREFIXES[m[1]] || conv(m[1]);
        const target = b === 'SELF' ? self : bound(env, b) ? (r) => env[b].fetch(r) : null;
        if (target) {
          const origin = b === 'SELF' ? `https://${SELF_HOST}` : `https://${PREFIX_WORKER[m[1]] || m[1]}${OWN_SUFFIX}`;
          const req = new Request(`${origin}${m[2] || '/'}${u.search}`, init);
          const headers = new Headers(req.headers);
          headers.set('x-forwarded-host', PUBLIC_HOST); headers.set('x-forwarded-prefix', `/${m[1]}`); headers.set('x-forwarded-proto', 'https');
          return target(new Request(req, { headers }));
        }
      }
      return ownFallback(input, init); // ours (or the proxy root) without a binding: fail closed on loopback refusal
    }
    if (host === SELF_HOST && self) return self(new Request(input, init));
    if (host.endsWith(OWN_SUFFIX)) {
      const b = bound(env, SIBLINGS[host] || conv(host.slice(0, -OWN_SUFFIX.length)));
      if (b) return b.fetch(new Request(input, init));
      return ownFallback(input, init);
    }
    return globalThis.fetch(input, init);
  };
}
