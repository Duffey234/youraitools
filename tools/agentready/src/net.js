// SSRF-safe fetching for AgentReady. Every URL we fetch is checked first:
//   - http(s) only, no userinfo, port 80/443 (or none), a public multi-label hostname (no localhost / .local / .internal ...)
//   - IP literals and every A / AAAA answer (DNS over HTTPS, two resolvers) must be public unicast addresses
//   - redirects are followed by hand (at most MAX_REDIRECTS), re-checking every hop
//   - each response body is read up to a byte cap, each request has its own timeout
//   - one honest user agent that names this service
// Workers cannot reach private networks anyway; these checks are the second layer and also keep tests honest.
export const USER_AGENT = 'AgentReadyBot/0.1 (+https://api.youraitools.co/agentready; website agent-readiness audit; one-off check requested by a user; hello@youraitools.co)';
export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

export class InputError extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; }
}
export class FetchFailure extends Error {
  constructor(message, kind = 'network') { super(message); this.kind = kind; }
}

const BAD_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private|test|invalid|example|onion|home\.arpa|localdomain)$/i;

export function ipv4ToInt(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKS = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .map(([a, bits]) => [ipv4ToInt(a), bits]);
export function isPrivateIPv4(s) {
  const n = ipv4ToInt(s);
  if (n === null) return false;
  return V4_BLOCKS.some(([base, bits]) => (bits === 0 ? true : (n >>> (32 - bits)) === (base >>> (32 - bits))));
}
function expandIPv6(s) {
  let x = s.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (v4) { const n = ipv4ToInt(v4[1]); if (n === null) return null; x = `${x.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const parts = x.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let all;
  if (parts.length === 1) all = head;
  else { const fill = 8 - head.length - rest.length; if (fill < 1) return null; all = [...head, ...Array(fill).fill('0'), ...rest]; }
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}
export function isPrivateIPv6(s) {
  const w = expandIPv6(s);
  if (!w) return true; // unparsable IPv6 literal: refuse
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x64 && w[1] === 0xff9b) return true; // NAT64 (may map to private v4)
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) { // IPv4-mapped / compatible
    const v4 = `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
    return isPrivateIPv4(v4) || w[5] === 0;
  }
  if (w[0] === 0x2002) { const v4 = `${w[1] >> 8}.${w[1] & 255}.${w[2] >> 8}.${w[2] & 255}`; return isPrivateIPv4(v4); } // 6to4
  return false;
}
export const isIpLiteral = (h) => ipv4ToInt(h) !== null || h.includes(':') || /^\[.*\]$/.test(h);
export const isPrivateIp = (h) => (ipv4ToInt(h) !== null ? isPrivateIPv4(h) : isPrivateIPv6(h));

/** Syntax-level checks (no network). Throws InputError(400). Returns a URL. */
export function checkUrlShape(raw) {
  let u;
  try { u = raw instanceof URL ? new URL(raw.href) : new URL(raw); } catch { throw new InputError('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InputError('only http:// and https:// URLs can be audited');
  if (u.username || u.password) throw new InputError('URLs with a username or password are not allowed');
  if (u.port && u.port !== '80' && u.port !== '443') throw new InputError('only the default ports (80, 443) can be audited');
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host) throw new InputError('URL has no host');
  if (isIpLiteral(host)) { if (isPrivateIp(host)) throw new InputError('private, loopback and reserved IP addresses are not allowed', 400, 'ssrf_blocked'); }
  else {
    if (!host.includes('.')) throw new InputError('use a public domain name (e.g. example.org)', 400, 'ssrf_blocked');
    if (BAD_SUFFIX.test(host)) throw new InputError('internal, reserved and example domains are not allowed', 400, 'ssrf_blocked');
    if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) throw new InputError('invalid hostname');
  }
  u.hash = '';
  return u;
}

/** Normalize user input ("example.com", "https://example.com/page") to a URL. Throws InputError(400). */
export function normalizeTarget(raw) {
  if (typeof raw !== 'string') throw new InputError('"url" must be a string');
  let s = raw.trim();
  if (!s) throw new InputError('"url" is required');
  if (s.length > 2048) throw new InputError('URL too long (max 2048 characters)');
  if (/[\s<>"`\\]/.test(s)) throw new InputError('URL contains invalid characters');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  else if (!/^https?:\/\//i.test(s)) throw new InputError('only http:// and https:// URLs can be audited');
  return checkUrlShape(s);
}

/** Resolve A + AAAA over DoH (two resolvers). Returns { ips, nxdomain }. Throws FetchFailure('dns') when no resolver answers. */
export async function resolveHost(host, { fetchImpl, timeoutMs = 3000 } = {}) {
  const ask = async (base, type) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: ctl.signal });
      if (!r.ok) throw new Error(`doh http ${r.status}`);
      const j = await r.json();
      if (typeof j?.Status !== 'number') throw new Error('doh bad answer');
      return j;
    } finally { clearTimeout(t); }
  };
  let lastErr;
  for (const base of DOH) {
    try {
      const [a, aaaa] = await Promise.all([ask(base, 'A'), ask(base, 'AAAA')]);
      if (a.Status === 2 || aaaa.Status === 2) throw new Error('SERVFAIL');
      const ips = [...(a.Answer || []).filter((x) => x.type === 1), ...(aaaa.Answer || []).filter((x) => x.type === 28)].map((x) => String(x.data).trim());
      return { ips, nxdomain: a.Status === 3 && aaaa.Status === 3 && !ips.length };
    } catch (e) { lastErr = e; }
  }
  throw new FetchFailure(`DNS lookup failed: ${lastErr?.message || lastErr}`, 'dns');
}

async function readCapped(res, maxBytes) {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader(); const chunks = []; let bytes = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) { chunks.push(value.slice(0, value.byteLength - (bytes - maxBytes))); truncated = true; try { await reader.cancel(); } catch { /* ignore */ } bytes = maxBytes; break; }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(all), bytes, truncated };
}

/**
 * A fetcher bound to one audit: caches DNS checks per host and counts requests.
 * get(url, {accept, method, body, headers, timeoutMs, maxBytes, follow}) resolves to
 *   { ok, status, url (final), headers (lowercased object), text, bytes, truncated, ms, redirects: [..] }
 * and rejects with FetchFailure (network / timeout / dns / ssrf / too_many_redirects) or InputError (target host blocked).
 */
export function createSafeFetcher({ fetchImpl, maxRequests = 40, skipDns = false } = {}) {
  const hostOk = new Map();
  let count = 0;
  const checkHost = (host) => {
    if (skipDns || isIpLiteral(host)) return Promise.resolve();
    if (!hostOk.has(host)) {
      hostOk.set(host, resolveHost(host, { fetchImpl }).then(({ ips, nxdomain }) => {
        if (nxdomain) throw new InputError(`${host} does not resolve (NXDOMAIN)`, 422, 'not_found');
        if (!ips.length) throw new InputError(`${host} has no A or AAAA record`, 422, 'not_found');
        if (ips.some((ip) => isPrivateIp(ip))) throw new InputError(`${host} resolves to a private or reserved address`, 422, 'ssrf_blocked');
      }));
    }
    return hostOk.get(host);
  };
  async function get(target, o = {}) {
    let u = checkUrlShape(target);
    const redirects = [];
    const t0 = Date.now();
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        try { await checkHost(u.hostname.replace(/\.$/, '').toLowerCase()); } catch (e) { if (hop === 0) throw e; throw new FetchFailure(`redirect target blocked: ${e.message}`, 'ssrf'); }
        if (++count > maxRequests) throw new FetchFailure('request budget for this audit exhausted', 'budget');
        let res;
        const method = hop === 0 ? (o.method || 'GET') : 'GET';
        try {
          res = await fetchImpl(u.href, { method, redirect: 'manual', signal: ctl.signal, body: hop === 0 ? o.body : undefined,
            headers: { 'user-agent': USER_AGENT, accept: o.accept || '*/*', 'accept-language': 'en', ...(hop === 0 ? o.headers || {} : {}) } });
        } catch (e) { throw new FetchFailure(ctl.signal.aborted ? `timed out after ${timeoutMs} ms` : `network error: ${String(e?.message || e).slice(0, 120)}`, ctl.signal.aborted ? 'timeout' : 'network'); }
        const ms = Date.now() - t0;
        if (res.status >= 300 && res.status < 400 && res.headers.get('location') && o.follow !== false) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          if (hop >= MAX_REDIRECTS) throw new FetchFailure(`more than ${MAX_REDIRECTS} redirects`, 'too_many_redirects');
          let next; try { next = new URL(res.headers.get('location'), u); } catch { throw new FetchFailure('invalid redirect Location', 'network'); }
          try { next = checkUrlShape(next); } catch (e) { throw new FetchFailure(`redirect blocked: ${e.message}`, 'ssrf'); }
          redirects.push({ status: res.status, to: next.href });
          u = next;
          continue;
        }
        const headers = {}; res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const body = o.method === 'HEAD' ? { text: '', bytes: 0, truncated: false } : await readCapped(res, o.maxBytes ?? DEFAULT_MAX_BYTES);
        return { ok: res.status >= 200 && res.status < 300, status: res.status, url: u.href, headers, ...body, ms, total_ms: Date.now() - t0, redirects };
      }
    } catch (e) {
      if (e instanceof FetchFailure || e instanceof InputError) throw e;
      throw new FetchFailure(ctl.signal.aborted ? `timed out after ${timeoutMs} ms` : String(e?.message || e).slice(0, 160), ctl.signal.aborted ? 'timeout' : 'network');
    } finally { clearTimeout(timer); }
  }
  return { get, checkHost, get requests() { return count; } };
}
