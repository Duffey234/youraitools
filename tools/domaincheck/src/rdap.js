// RDAP (RFC 9082/9083) domain registration lookup: registrar, creation / expiry dates, status.
// Server per TLD comes from the IANA bootstrap file (cached per isolate for 24 h); rdap.org is the fallback
// for TLDs missing from the bootstrap. No API keys; public registry data only.
export const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
export const RDAP_FALLBACK = 'https://rdap.org/';

let bootCache = null; // { at, map }

export class Rdap {
  /** @param {{fetchImpl?:Function, timeoutMs?:number, now?:()=>number, userAgent?:string}} [o] */
  constructor(o = {}) {
    this.fetch = o.fetchImpl || ((u, i) => globalThis.fetch(u, i));
    this.timeoutMs = o.timeoutMs ?? 6000;
    this.now = o.now || (() => Date.now());
    this.ua = o.userAgent || 'DomainCheck/0.1';
    this.cache = o.cache ?? null; // optional per-instance cache (tests)
  }
  async _get(url, accept = 'application/rdap+json, application/json') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(url, { headers: { accept, 'user-agent': this.ua }, signal: ctrl.signal, redirect: 'follow' });
      return r;
    } finally { clearTimeout(t); }
  }
  async bootstrap() {
    const c = this.cache || bootCache;
    if (c && this.now() - c.at < 86400000) return c.map;
    const r = await this._get(IANA_BOOTSTRAP, 'application/json');
    if (!r.ok) throw new Error(`IANA bootstrap HTTP ${r.status}`);
    const j = await r.json();
    const map = {};
    for (const [tlds, urls] of j.services || []) { const u = urls.find((x) => x.startsWith('https://')) || urls[0]; for (const t of tlds) map[t.toLowerCase()] = u.endsWith('/') ? u : `${u}/`; }
    const entry = { at: this.now(), map };
    if (this.cache !== null) this.cache = entry; else bootCache = entry;
    return map;
  }
  /** Look up a registrable domain (e.g. "example.co.uk"). Never throws. */
  async lookup(domain) {
    const tld = domain.split('.').pop();
    let base = null; let source = 'iana-bootstrap';
    try { base = (await this.bootstrap())[tld] || null; } catch { base = null; }
    if (!base) { base = RDAP_FALLBACK; source = 'rdap.org'; }
    try {
      const r = await this._get(`${base}domain/${encodeURIComponent(domain)}`);
      if (r.status === 404) return source === 'rdap.org'
        ? { available: false, found: false, source, server: base, note: `.${tld} has no public RDAP service in the IANA bootstrap` }
        : { available: true, found: false, source, server: base, note: 'registry has no record (unregistered, or not published over RDAP)' };
      if (!r.ok) return { available: false, found: false, source, server: base, error: `RDAP HTTP ${r.status}` };
      return { available: true, found: true, source, server: base, ...parseRdap(await r.json(), this.now()) };
    } catch (e) {
      return { available: false, found: false, source, server: base, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 120) };
    }
  }
}

const vcardFn = (ent) => { const v = ent?.vcardArray?.[1]; const fn = Array.isArray(v) && v.find((x) => x[0] === 'fn'); return fn ? String(fn[3] || '').trim() || null : null; };
const DAY = 86400000;

export function parseRdap(j, now = Date.now()) {
  const ev = {};
  for (const e of j.events || []) if (e.eventAction && e.eventDate && !ev[e.eventAction]) ev[e.eventAction] = e.eventDate;
  const registrarEnt = (j.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const ianaId = registrarEnt?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier || null;
  const created = ev.registration || null; const expires = ev.expiration || null;
  const ts = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? t : null; };
  const age = created && ts(created) ? Math.floor((now - ts(created)) / DAY) : null;
  const left = expires && ts(expires) ? Math.floor((ts(expires) - now) / DAY) : null;
  return {
    domain: (j.ldhName || '').toLowerCase() || null,
    registrar: vcardFn(registrarEnt) || registrarEnt?.handle || null,
    registrar_iana_id: ianaId,
    created, expires, updated: ev['last changed'] || null,
    age_days: age, expires_in_days: left,
    status: (j.status || []).map((s) => String(s).toLowerCase()),
    nameservers: (j.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase().replace(/\.$/, '')).filter(Boolean),
    dnssec_signed: j.secureDNS ? !!j.secureDNS.delegationSigned : null,
  };
}
