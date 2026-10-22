// SSRF-safe, size- and time-limited fetch for untrusted URLs.
// - only http: / https:, default ports (80/443) only, no credentials in URLs
// - blocks localhost, private/reserved IPv4/IPv6 literals, internal TLDs, and our own *.workers.dev zone
// - resolves the hostname over DNS-over-HTTPS and rejects names that point at private/reserved addresses
// - follows at most 5 redirects manually, re-validating every hop
// - caps body bytes and total time
export class FetchError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.arpa', '.test', '.invalid', '.example', '.onion'];

function ipv4ToInt(ip) {
  const p = ip.split('.'); if (p.length !== 4) return null;
  let n = 0; for (const x of p) { if (!/^\d{1,3}$/.test(x) || +x > 255) return null; n = n * 256 + +x; } return n;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
].map(([a, b]) => [ipv4ToInt(a), b]);
export function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip); if (n === null) return false;
  return V4_BLOCKS.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}
export function isPrivateIPv6(ip) {
  let h = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes('%')) return true; // zone ids
  const v4 = h.match(/(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped / compatible
  if (v4) return true; // any IPv4 embedded in IPv6 (mapped/compatible/NAT64): refuse
  // expand
  const [a, b = ''] = h.split('::');
  const A = a ? a.split(':') : []; const B = b ? b.split(':') : [];
  const full = h.includes('::') ? [...A, ...Array(8 - A.length - B.length).fill('0'), ...B] : A;
  if (full.length !== 8) return true; // unparseable: treat as unsafe
  const w = full.map((x) => parseInt(x || '0', 16));
  if (w.every((x) => x === 0)) return true;                       // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true;                    // fe80::/10 link local
  if ((w[0] & 0xffc0) === 0xfec0) return true;                    // fec0::/10 site local
  if ((w[0] & 0xff00) === 0xff00) return true;                    // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;            // documentation
  if (w[0] === 0x0064 && w[1] === 0xff9b) return true;            // NAT64 (could map to private v4)
  if (w[0] === 0x2002) return true;                               // 6to4 (embeds v4)
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) return true; // mapped
  return false;
}
const isIPv4Literal = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
const isIPv6Literal = (h) => h.startsWith('[') || h.includes(':');

/** Validate a URL string; returns a URL object or throws FetchError. Does not do DNS. */
export function checkUrl(input, { blockedHosts = [] } = {}) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new FetchError('invalid_url', 'url must be an absolute http(s) URL', 400); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('blocked_scheme', 'only http and https URLs are allowed', 400);
  if (u.username || u.password) throw new FetchError('blocked_credentials', 'URLs with embedded credentials are not allowed', 400);
  if (u.port && !['80', '443'].includes(u.port)) throw new FetchError('blocked_port', 'only the default ports 80 and 443 are allowed', 400);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || !host.includes('.') && !isIPv6Literal(host)) throw new FetchError('blocked_host', 'local or single-label hostnames are not allowed', 400);
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new FetchError('blocked_host', 'internal hostnames are not allowed', 400);
  if (blockedHosts.some((b) => host === b || host.endsWith('.' + b))) throw new FetchError('blocked_host', 'this host cannot be fetched', 400);
  if (isIPv4Literal(host) && isPrivateIPv4(host)) throw new FetchError('blocked_ip', 'private or reserved IP addresses are not allowed', 400);
  if (isIPv6Literal(host) && isPrivateIPv6(host)) throw new FetchError('blocked_ip', 'private or reserved IP addresses are not allowed', 400);
  u.hash = '';
  return u;
}

/** Resolve A/AAAA over DoH and reject if any answer is private. Literal IPs are already checked. */
export async function checkDns(host, { fetchImpl, dohUrl = 'https://cloudflare-dns.com/dns-query', timeoutMs = 3000 } = {}) {
  if (isIPv4Literal(host) || isIPv6Literal(host)) return;
  const f = fetchImpl || ((u, i) => globalThis.fetch(u, i));
  const answers = [];
  await Promise.all(['A', 'AAAA'].map(async (type) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await f(`${dohUrl}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
      if (!r.ok) return;
      const j = await r.json();
      for (const a of j.Answer || []) if (a.type === 1 || a.type === 28) answers.push(a.data);
    } catch { /* treated below */ } finally { clearTimeout(t); }
  }));
  if (!answers.length) throw new FetchError('dns_failed', `could not resolve ${host}`, 422);
  if (answers.some((ip) => (ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip)))) throw new FetchError('blocked_ip', 'hostname resolves to a private or reserved address', 400);
  return answers;
}

async function readCapped(res, maxBytes) {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader(); const chunks = []; let total = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) { chunks.push(value.slice(0, maxBytes - total)); total = maxBytes; truncated = true; try { await reader.cancel(); } catch {} break; }
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return { bytes: out, truncated };
}

function decode(bytes, contentType) {
  let cs = (contentType || '').match(/charset=["']?([\w-]+)/i)?.[1];
  if (!cs) { const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048)); cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]; }
  try { return new TextDecoder(cs || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/**
 * Fetch an untrusted URL safely.
 * @returns {Promise<{url:string, finalUrl:string, status:number, contentType:string, text:string, bytes:number, truncated:boolean, redirects:number}>}
 */
export async function safeFetch(input, { fetchImpl, userAgent, maxBytes = 2_000_000, timeoutMs = 10000, maxRedirects = 5, blockedHosts = [], dns = true, accept = 'text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,*/*;q=0.1', beforeRequest } = {}) {
  const f = fetchImpl || ((u, i) => globalThis.fetch(u, i));
  const started = Date.now();
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url = checkUrl(input, { blockedHosts }); const first = url.href; let ips = [];
    for (let hop = 0; ; hop++) {
      if (dns) ips = (await checkDns(url.hostname, { fetchImpl: f })) || [];
      if (beforeRequest) await beforeRequest(url);
      let res;
      try {
        res = await f(url.href, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': userAgent, accept, 'accept-language': 'en;q=1, *;q=0.5' } });
      } catch (e) {
        if (ctrl.signal.aborted) throw new FetchError('timeout', `fetch timed out after ${timeoutMs} ms`, 504);
        throw new FetchError('fetch_failed', `could not fetch: ${String(e.message || e).slice(0, 120)}`, 502);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        try { await res.body?.cancel(); } catch {}
        if (!loc) throw new FetchError('bad_redirect', 'redirect without Location', 502);
        if (hop >= maxRedirects) throw new FetchError('too_many_redirects', `more than ${maxRedirects} redirects`, 502);
        url = checkUrl(new URL(loc, url).href, { blockedHosts });
        continue;
      }
      const contentType = res.headers.get('content-type') || '';
      const len = +res.headers.get('content-length');
      if (len && len > maxBytes * 4) { try { await res.body?.cancel(); } catch {} throw new FetchError('too_large', `document is larger than ${maxBytes * 4} bytes`, 413); }
      const { bytes, truncated } = await readCapped(res, maxBytes);
      return { url: first, finalUrl: url.href, status: res.status, contentType, headers: res.headers, ips, text: decode(bytes, contentType), bytes: bytes.length, truncated, redirects: hop, ms: Date.now() - started };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (ctrl.signal.aborted) throw new FetchError('timeout', `fetch timed out after ${timeoutMs} ms`, 504);
    throw new FetchError('fetch_failed', String(e.message || e).slice(0, 160), 502);
  } finally { clearTimeout(timer); }
}
