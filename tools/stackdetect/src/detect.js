// StackDetect engine: one GET of the page (SSRF-safe, size/time capped) + optional public DNS lookups (paid tier),
// matched against the in-house signature set in signatures.js. Pure matching (matchStack) is separated from I/O
// (detectStack) so it can be unit-tested offline.
import { SIGNATURES, CATEGORIES } from './signatures.js';
import { safeFetch, checkUrl, FetchError } from './safefetch.js';
import { DohResolver, unquoteTxt } from './dns.js';

export { FetchError, CATEGORIES };
export const ENGINE_VERSION = 'stackdetect-0.1';
export const SIGNATURE_COUNT = SIGNATURES.length;
export const HTML_SCAN_BYTES = 120_000; // head of the document
export const HTML_TAIL_BYTES = 30_000; // + its tail (hydration data, late tags)
export const MAX_FETCH_BYTES = 1_500_000;
export const USER_AGENT = 'Mozilla/5.0 (compatible; StackDetectBot/0.1; +https://api.youraitools.co/stackdetect)';
export const DISCLAIMER = 'Informational: technologies inferred from public signals of one page load and public DNS. Detection can miss tools loaded later by JavaScript or hidden by the site; confidence is a heuristic.';
// Cloudflare's published edge ranges (cloudflare.com/ips). On Workers every subrequest response passes Cloudflare's edge, which
// sets server: cloudflare / cf-ray / cf-cache-status on ANY origin, so there those headers are ignored and Cloudflare is detected
// from the site's A/AAAA records instead.
const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF_V6 = ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2a06:98c', '2a06:98d', '2a06:98e', '2a06:98f', '2c0f:f248:'];
const v4int = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
export function isCloudflareIp(ip = '') {
  if (ip.includes(':')) return CF_V6.some((p) => ip.toLowerCase().startsWith(p));
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = v4int(ip);
  return CF_V4.some((c) => { const [b, bits] = c.split('/'); const size = 2 ** (32 - Number(bits)); return Math.floor(n / size) === Math.floor(v4int(b) / size); });
}
export const EDGE_HEADERS = ['cf-ray', 'cf-cache-status'];
const CONF = { ip: 95, header: 100, meta: 100, cookie: 85, script: 90, link: 85, html: 70, mx: 95, ns: 95, txt: 90, implied: 50 };

function compile(m) {
  if (m instanceof RegExp) return m;
  if (m === '' || m === undefined) return null; // presence only
  return String(m).toLowerCase();
}
const PREPARED = SIGNATURES.map((s) => ({
  ...s,
  headers: s.headers && Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), compile(v)]),
  cookies: s.cookies && Object.keys(s.cookies).map((k) => (k.includes('*') ? new RegExp('^' + k.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i') : k.toLowerCase())),
  meta: s.meta && Object.entries(s.meta).map(([k, v]) => [k.toLowerCase(), compile(v)]),
  scripts: s.scripts?.map(compile), links: s.links?.map(compile), html: s.html?.map(compile),
  mx: s.mx?.map(compile), ns: s.ns?.map(compile), txt: s.txt?.map(compile),
}));

/** Test a matcher against a string. Returns null (no match) or { version }. */
function test(m, value, lower) {
  if (value === undefined || value === null) return null;
  if (m === null) return { version: null };
  if (typeof m === 'string') return (lower ?? String(value).toLowerCase()).includes(m) ? { version: null } : null;
  m.lastIndex = 0;
  const r = m.exec(String(value));
  return r ? { version: r[1] && /\d/.test(r[1]) ? r[1] : null } : null;
}

const CI = new WeakMap();
const ciOf = (m) => { let r = CI.get(m); if (!r) { r = m.flags.includes('i') ? m : new RegExp(m.source, m.flags + 'i'); CI.set(m, r); } return r; };
/** Fast path: test the matcher once on the newline-joined lowercase list, then find the item for evidence/version. */
function findIn(m, items, joinedLower) {
  if (!items.length) return null;
  if (typeof m === 'string') { if (!joinedLower.includes(m)) return null; }
  else { const ci = ciOf(m); ci.lastIndex = 0; if (!ci.test(joinedLower)) return null; }
  for (const [v, lv] of items) { const r = test(m, v, lv); if (r) return { value: v, version: r.version, qsVersion: v.match(/[?&]ver(?:sion)?=(\d+\.\d+(?:\.\d+)?)\b/)?.[1] || null }; }
  return null;
}
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((x) => x !== undefined);

/** Pull the matchable parts out of an HTML document (one pass per tag type, first HTML_SCAN_BYTES only). */
export function extractPage(html = '') {
  const h = html.length > HTML_SCAN_BYTES + HTML_TAIL_BYTES ? html.slice(0, HTML_SCAN_BYTES) + '\n' + html.slice(-HTML_TAIL_BYTES) : html;
  const scripts = []; const links = []; const meta = {};
  for (const m of h.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) if (scripts.length < 300) scripts.push(m[1]);
  for (const m of h.matchAll(/<link\b[^>]*>/gi)) { const href = attr(m[0], 'href'); if (href && links.length < 300) links.push(href); }
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const k = (attr(m[0], 'name') || attr(m[0], 'property') || attr(m[0], 'http-equiv') || '').toLowerCase();
    const v = attr(m[0], 'content');
    if (k && v !== undefined && !(k in meta)) meta[k] = v;
  }
  const title = h.match(/<title[^>]*>([^<]{0,300})/i)?.[1]?.trim() || null;
  return { html: h, scripts, links, meta, title };
}

/** Cookie names from Set-Cookie headers (values are never kept). */
export function cookieNames(headers) {
  let list = [];
  try { list = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : []; } catch { list = []; }
  if (!list.length) { const raw = headers?.get?.('set-cookie'); if (raw) list = raw.split(/,(?=\s*[^;,=\s]+=)/); }
  return [...new Set(list.map((c) => c.split('=')[0].trim()).filter(Boolean))].slice(0, 60);
}

/**
 * Match signatures. `page` = { headers: Headers|object, cookies: string[], scripts, links, meta, html }, `dns` = { mx:[], ns:[], txt:[] }.
 * Returns technologies sorted by confidence then name: { name, categories, confidence, version, evidence:[{type, value}] }.
 */
export function matchStack(page = {}, dns = null) {
  const hdr = new Map();
  const H = page.headers;
  if (H && typeof H.forEach === 'function') H.forEach((v, k) => hdr.set(k.toLowerCase(), v));
  else if (H) for (const [k, v] of Object.entries(H)) hdr.set(k.toLowerCase(), String(v));
  if (page.cfEdge) { for (const k of EDGE_HEADERS) hdr.delete(k); if (/^cloudflare$/i.test(hdr.get('server') || '')) hdr.delete('server'); }
  const cookies = page.cookies || [];
  const scripts = (page.scripts || []).map((s) => [s, s.toLowerCase()]);
  const links = (page.links || []).map((s) => [s, s.toLowerCase()]);
  const scriptsJoined = scripts.map((x) => x[1]).join('\n'); const linksJoined = links.map((x) => x[1]).join('\n');
  const meta = page.meta || {};
  const html = page.html || ''; const htmlLower = html.toLowerCase();
  const recs = dns ? { mx: dns.mx || [], ns: dns.ns || [], txt: dns.txt || [] } : null;
  const found = new Map();
  const add = (s, type, value, version) => {
    let t = found.get(s.name);
    if (!t) { t = { name: s.name, categories: s.cats, confidence: 0, version: null, evidence: [] }; found.set(s.name, t); }
    t.confidence = Math.max(t.confidence, CONF[type]);
    if (version && !t.version) t.version = version;
    if (t.evidence.length < 4 && !t.evidence.some((e) => e.type === type && e.value === value)) t.evidence.push({ type, value: String(value).slice(0, 160) });
  };
  const host = String(page.host || '').toLowerCase();
  for (const s of PREPARED) {
    if (s.excludeHosts && s.excludeHosts.some((x) => host === x || host.endsWith('.' + x))) continue;
    if (s.headers) for (const [k, m] of s.headers) { if (!hdr.has(k)) continue; const r = test(m, hdr.get(k)); if (r) add(s, 'header', `${k}: ${hdr.get(k)}`, r.version); }
    if (s.cookies) for (const m of s.cookies) for (const c of cookies) { if (typeof m === 'string' ? c.toLowerCase() === m : m.test(c)) add(s, 'cookie', c); }
    if (s.meta) for (const [k, m] of s.meta) { if (!(k in meta)) continue; const r = test(m, meta[k]); if (r) add(s, 'meta', `${k}: ${meta[k]}`, r.version); }
    const lib = s.cats.includes('js-library') || s.cats.includes('ui-library');
    if (s.scripts) for (const m of s.scripts) { const hit = findIn(m, scripts, scriptsJoined); if (hit) { add(s, 'script', hit.value, hit.version || (lib ? hit.qsVersion : null)); break; } }
    if (s.links) for (const m of s.links) { const hit = findIn(m, links, linksJoined); if (hit) { add(s, 'link', hit.value, hit.version || (lib ? hit.qsVersion : null)); break; } }
    if (s.html && html) for (const m of s.html) { const r = test(m, html, htmlLower); if (r) { add(s, 'html', typeof m === 'string' ? m : m.source.slice(0, 80), r.version); break; } }
    if (recs) for (const type of ['mx', 'ns', 'txt']) if (s[type]) for (const m of s[type]) for (const v of recs[type]) { const r = test(m, v); if (r) { add(s, type, v, r.version); break; } }
  }
  const cfIp = (page.ips || []).find(isCloudflareIp);
  if (cfIp) { const s = PREPARED.find((x) => x.name === 'Cloudflare'); add(s, 'ip', `A/AAAA ${cfIp} is in Cloudflare's network`); }
  // implied technologies (lower confidence, never override a direct hit)
  for (let pass = 0; pass < 2; pass++) for (const t of [...found.values()]) {
    const s = SIGNATURES.find((x) => x.name === t.name);
    for (const imp of s?.implies || []) {
      if (found.has(imp)) continue;
      const is = SIGNATURES.find((x) => x.name === imp); if (!is) continue;
      found.set(imp, { name: imp, categories: is.cats, confidence: CONF.implied, version: null, evidence: [{ type: 'implied', value: `implied by ${t.name}` }] });
    }
  }
  return [...found.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}

export function groupByCategory(techs) {
  const out = {};
  for (const t of techs) for (const c of t.categories) (out[c] ||= []).push(t.name);
  return out;
}

// Common multi-label public suffixes (no full PSL in the Worker): registrable domain = one label more than these.
const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'co.in', 'co.za', 'com.ua', 'co.il', 'com.my', 'com.ph', 'com.vn', 'com.pl', 'co.id', 'github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'myshopify.com', 'wixsite.com', 'web.app', 'firebaseapp.com']);
/** Registrable domain for MX / NS / TXT lookups (sub.example.co.uk -> example.co.uk). */
export const dnsName = (host) => {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const n = MULTI_SUFFIX.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-n).join('.');
};

/** Public DNS records used for provider detection. Never throws; failed lookups are reported. */
export async function lookupDns(host, { fetchImpl, timeoutMs = 2500 } = {}) {
  const r = new DohResolver({ fetchImpl, timeoutMs });
  const name = dnsName(host);
  const [mx, ns, txt] = await Promise.all([r.query(name, 'MX'), r.query(name, 'NS'), r.query(name, 'TXT')]);
  const clean = (res, type) => DohResolver.of(res, type).map((a) => (type === 'TXT' ? unquoteTxt(a.data) : String(a.data).replace(/\.$/, '').replace(/^\d+\s+/, '').toLowerCase()));
  const errors = [mx, ns, txt].filter((x) => x.error).map((x) => `${x.type}: ${x.error}`);
  return { name, mx: clean(mx, 'MX'), ns: clean(ns, 'NS'), txt: clean(txt, 'TXT').slice(0, 60), ...(errors.length ? { errors } : {}) };
}

/** Validate a target URL (no network). Accepts a bare host like "example.com". */
export function normalizeTarget(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new FetchError('missing_url', '"url" is required, e.g. https://example.com', 400);
  if (s.length > 2048) throw new FetchError('invalid_url', 'url is longer than 2048 characters', 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  return checkUrl(s, { blockedHosts: ['workers.dev', 'youraitools.co', 'agentgate-source.pages.dev'] });
}

/**
 * Detect the stack of a URL. tier 'full' adds versions, evidence, confidence and DNS-based providers; 'preview' = names only.
 * @returns {Promise<object>} the report; throws FetchError (4xx/5xx, never charged) when the page can't be fetched.
 */
export async function detectStack(input, { tier = 'full', fetchImpl, now = Date.now(), dns = true, timeoutMs = 8000, cfEdge = false } = {}) {
  const u = normalizeTarget(input);
  const f = fetchImpl || ((a, b) => globalThis.fetch(a, b));
  const dnsP = tier === 'full' && dns ? lookupDns(u.hostname, { fetchImpl: f }).catch((e) => ({ name: dnsName(u.hostname), mx: [], ns: [], txt: [], errors: [String(e?.message || e)] })) : Promise.resolve(null);
  const res = await safeFetch(u.href, { fetchImpl: f, userAgent: USER_AGENT, maxBytes: MAX_FETCH_BYTES, timeoutMs, blockedHosts: ['workers.dev', 'youraitools.co', 'agentgate-source.pages.dev'], accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' });
  const isHtml = /html|xml/i.test(res.contentType) || /^\s*<(?:!doctype|html)/i.test(res.text.slice(0, 200));
  const page = { ...(isHtml ? extractPage(res.text) : { html: '', scripts: [], links: [], meta: {}, title: null }), headers: res.headers, cookies: cookieNames(res.headers), host: new URL(res.finalUrl).hostname, ips: res.ips || [], cfEdge };
  const dnsRec = await dnsP;
  const all = matchStack(page, dnsRec);
  const base = {
    tier, url: res.url, final_url: res.finalUrl, http_status: res.status, content_type: res.contentType.split(';')[0] || null, title: page.title,
  };
  if (tier !== 'full') {
    const web = all.filter((t) => !t.evidence.every((e) => ['mx', 'ns', 'txt'].includes(e.type)));
    return { ...base, technology_count: web.length, technologies: web.map((t) => t.name), categories: groupByCategory(web),
      fetched: { bytes: res.bytes, truncated: res.truncated, redirects: res.redirects, ms: res.ms }, engine: ENGINE_VERSION, scanned_at: new Date(now).toISOString(), disclaimer: DISCLAIMER };
  }
  return {
    ...base, technology_count: all.length,
    technologies: all.map((t) => ({ name: t.name, categories: t.categories, version: t.version, confidence: t.confidence, evidence: t.evidence })),
    categories: groupByCategory(all),
    providers: {
      email: all.filter((t) => t.categories.includes('email-provider')).map((t) => t.name),
      email_delivery: all.filter((t) => t.categories.includes('email-delivery')).map((t) => t.name),
      dns: all.filter((t) => t.categories.includes('dns-provider')).map((t) => t.name),
      hosting: all.filter((t) => t.categories.some((c) => c === 'hosting' || c === 'cdn')).map((t) => t.name),
      verified_saas: all.filter((t) => t.categories.includes('saas')).map((t) => t.name),
    },
    headers_seen: { server: cfEdge && /^cloudflare$/i.test(page.headers?.get?.('server') || '') ? null : page.headers?.get?.('server') || null, 'x-powered-by': page.headers?.get?.('x-powered-by') || null },
    dns: dnsRec ? { name: dnsRec.name, mx: dnsRec.mx, ns: dnsRec.ns, txt_count: dnsRec.txt.length, ...(dnsRec.errors ? { errors: dnsRec.errors } : {}) } : null,
    fetched: { bytes: res.bytes, truncated: res.truncated, redirects: res.redirects, ms: res.ms },
    engine: ENGINE_VERSION, signatures: SIGNATURE_COUNT, scanned_at: new Date(now).toISOString(), disclaimer: DISCLAIMER,
  };
}
