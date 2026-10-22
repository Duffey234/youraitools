// DNS over HTTPS (JSON API) resolver. Primary: Cloudflare 1.1.1.1, fallback: Google Public DNS.
// No API keys. Every query has its own timeout; a failed query returns { error } instead of throwing,
// so one slow record type can't sink the whole report.
export const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, DS: 43, RRSIG: 46, DNSKEY: 48, CAA: 257 };
const NAME_OF = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
export const RCODE = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 5: 'REFUSED' };
export const DOH_SERVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

/** TXT data from DoH JSON comes quoted and possibly split into 255-byte chunks: "v=spf1 ..." "more". */
export function unquoteTxt(data) {
  const s = String(data || '');
  if (!s.includes('"')) return s;
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d))).replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : s;
}

export class DohResolver {
  /** @param {{fetchImpl?:Function, servers?:string[], timeoutMs?:number}} [o] */
  constructor(o = {}) {
    this.fetch = o.fetchImpl || ((u, i) => globalThis.fetch(u, i));
    this.servers = o.servers || DOH_SERVERS;
    this.timeoutMs = o.timeoutMs ?? 4000;
    this.queries = 0;
  }
  async _one(server, name, type) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      this.queries++;
      const r = await this.fetch(`${server}?name=${encodeURIComponent(name)}&type=${type}&do=1`, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  /**
   * @returns {Promise<{name:string,type:string,status:string,ad:boolean,answers:{type:string,ttl:number,data:string}[],error?:string}>}
   */
  async query(name, type) {
    let lastErr;
    for (const server of this.servers) {
      try {
        const j = await this._one(server, name, type);
        const status = RCODE[j.Status] || `RCODE${j.Status}`;
        if (status === 'SERVFAIL' && server !== this.servers[this.servers.length - 1]) { lastErr = new Error('SERVFAIL'); continue; }
        const answers = (j.Answer || []).map((a) => ({ name: String(a.name || '').replace(/\.$/, ''), type: NAME_OF[a.type] || String(a.type), ttl: a.TTL, data: a.data }));
        return { name, type, status, ad: !!j.AD, answers };
      } catch (e) { lastErr = e; }
    }
    return { name, type, status: 'ERROR', ad: false, answers: [], error: (lastErr && (lastErr.name === 'AbortError' ? 'timeout' : lastErr.message)) || 'failed' };
  }
  /** Answers of the requested type only (skips CNAME chain links and RRSIGs). */
  static of(res, type) { return (res?.answers || []).filter((a) => a.type === type); }
}
