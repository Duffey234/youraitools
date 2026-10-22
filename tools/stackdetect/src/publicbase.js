// Public base URL for reverse-proxied requests (api.youraitools.co/<prefix>).
// Shared verbatim by AgentGate, WebRead, InjectScan, DomainCheck, PayGuard, PkgGuard, StackDetect and TokenVerdict (src/publicbase.js).
//
// The youraitools-api Pages proxy forwards /<prefix>/* to this Worker and adds
//   X-Forwarded-Host: api.youraitools.co   X-Forwarded-Prefix: /<prefix>
// When (and only when) the host is on the allowlist (PROXY_HOSTS) and the prefix equals this Worker's
// PROXY_PREFIX, the request is served by an app instance whose publicUrl is https://<host><prefix>.
// Every URL the app emits then uses that base: the x402 v2 `resource`, the v1 `accepts[].resource`,
// openapi `servers`, /.well-known/x402, MCP and preview hints, the landing page.
// One app per base (at most 2 per isolate) means the 402 a client signs and the verify/settle of its
// paid retry are built from the same route config, so `resource` always matches.
// Requests without (valid) forwarded headers get the unchanged workers.dev app.
export const DEFAULT_PROXY_HOSTS = ['api.youraitools.co'];
const PREFIX_RE = /^\/[a-z0-9][a-z0-9-]{0,31}$/;
const HOST_RE = /^[a-z0-9.-]+$/;

/** Sister services, rewritten to their proxied URLs in proxied HTML pages. */
export const TOOL_ORIGINS = {
  'https://agentgate.agentgate.workers.dev': '/agentgate',
  'https://webread.agentgate.workers.dev': '/webread',
  'https://injectscan.agentgate.workers.dev': '/injectscan',
  'https://domaincheck.agentgate.workers.dev': '/domaincheck',
  'https://payguard.agentgate.workers.dev': '/payguard',
  'https://pkgguard.agentgate.workers.dev': '/pkgguard',
  'https://stackdetect.agentgate.workers.dev': '/stackdetect',
  'https://tokenverdict.agentgate.workers.dev': '/tokenverdict',
  'https://signcheck.agentgate.workers.dev': '/signcheck',
};

const list = (v, dflt) => (v ? String(v).split(',') : dflt).map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * @param {Request} request
 * @param {{PROXY_HOSTS?:string, PROXY_PREFIX?:string}} env
 * @returns {{host:string, prefix:string, base:string} | null} null = not proxied (use the default app)
 */
export function forwardedBase(request, env = {}) {
  const host = (request.headers.get('x-forwarded-host') || '').split(',')[0].trim().toLowerCase();
  if (!host || !HOST_RE.test(host)) return null;
  if (!list(env.PROXY_HOSTS, DEFAULT_PROXY_HOSTS).includes(host)) return null;
  const prefix = (request.headers.get('x-forwarded-prefix') || '').split(',')[0].trim().replace(/\/+$/, '');
  if (!PREFIX_RE.test(prefix)) return null;
  if (!env.PROXY_PREFIX || prefix !== env.PROXY_PREFIX) return null;
  return { host, prefix, base: `https://${host}${prefix}` };
}

/** Rewrites root-relative links (href="/x", fetch('/x')) and sister-tool links in a proxied HTML page. */
export function rewriteHtml(html, { host, prefix }) {
  let out = html
    .replace(/(\s(?:href|src|action)=)(["'])\/(?!\/)/g, `$1$2${prefix}/`)
    .replace(/(fetch\(\s*)(["'`])\/(?!\/)/g, `$1$2${prefix}/`);
  for (const [origin, p] of Object.entries(TOOL_ORIGINS)) out = out.split(origin).join(`https://${host}${p}`);
  return out;
}

/**
 * Builds the Worker fetch handler.
 * @param {object} env Worker env (PUBLIC_URL, PROXY_HOSTS, PROXY_PREFIX)
 * @param {(publicUrl: string|undefined) => {fetch: Function}} makeApp creates one app for a public base URL
 */
export function publicBaseHandler(env, makeApp) {
  const apps = new Map();
  const appFor = (base) => {
    let a = apps.get(base);
    if (!a) { a = makeApp(base); apps.set(base, a); }
    return a;
  };
  return async (request, env2 = env, ctx) => {
    const fwd = forwardedBase(request, env2);
    if (!fwd) return appFor(env2.PUBLIC_URL || undefined).fetch(request, env2, ctx);
    const res = await appFor(fwd.base).fetch(request, env2, ctx);
    const loc = res.headers.get('location');
    const type = res.headers.get('content-type') || '';
    if (!/text\/html/.test(type) && !(loc && loc.startsWith('/'))) return res;
    const headers = new Headers(res.headers);
    if (loc && loc.startsWith('/') && !loc.startsWith('//')) headers.set('location', fwd.prefix + loc);
    if (!/text\/html/.test(type)) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    headers.delete('content-length');
    return new Response(rewriteHtml(await res.text(), fwd), { status: res.status, statusText: res.statusText, headers });
  };
}
