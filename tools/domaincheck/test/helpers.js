import { createApp } from '../src/app.js';
import { Stats } from '../src/stats.js';
import { TYPES } from '../src/dns.js';
export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const BASE = 'https://domaincheck.example.com';
export const NOW = Date.parse('2026-10-21T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

// Fake DNS zone data: name -> { TYPE: [data...] }; names absent => NXDOMAIN unless under an existing zone.
export const ZONES = {
  'good.example': { A: ['192.0.2.10'], AAAA: ['2001:db8::10'], NS: ['ns1.provider.net.', 'ns2.provider.net.'], MX: ['10 aspmx.l.google.com.', '20 alt1.aspmx.l.google.com.'], TXT: ['"v=spf1 include:_spf.google.com -all"', '"google-site-verification=abc"'], CAA: ['0 issue "letsencrypt.org"'] },
  '_dmarc.good.example': { TXT: ['"v=DMARC1; p=reject; rua=mailto:d@good.example"'] },
  '_mta-sts.good.example': { TXT: ['"v=STSv1; id=2026"'] },
  'google._domainkey.good.example': { TXT: ['"v=DKIM1; k=rsa; p=MIIBIjANBg" "kqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"'] },
  'www.good.example': { A: ['192.0.2.11'] },
  'fresh.example': { A: ['192.0.2.20'], NS: ['ns1.cheapdns.net.'], MX: ['10 mx.fresh.example.'], TXT: ['"v=spf1 +all"'] },
  'parked.example': { A: ['192.0.2.30'], NS: ['ns1.sedoparking.com.', 'ns2.sedoparking.com.'] },
  'nomail.example': { A: ['192.0.2.40'], NS: ['ns1.provider.net.'], MX: ['0 .'], TXT: ['"v=spf1 -all"'] },
  '_dmarc.nomail.example': { TXT: ['"v=DMARC1; p=none"'] },
  'mailinator.com': { A: ['192.0.2.50'], NS: ['ns1.provider.net.'], MX: ['1 mail.mailinator.com.'], TXT: ['"v=spf1 -all"'] },
  '_dmarc.mailinator.com': { TXT: ['"v=DMARC1; p=reject"'] },
  'gmail.com': { A: ['192.0.2.60'], NS: ['ns1.google.com.'], MX: ['5 gmail-smtp-in.l.google.com.'], TXT: ['"v=spf1 redirect=_spf.google.com"'] },
  '_dmarc.gmail.com': { TXT: ['"v=DMARC1; p=none; sp=quarantine"'] },
};
export const RDAP = {
  'good.example': { ldhName: 'GOOD.EXAMPLE', events: [{ eventAction: 'registration', eventDate: daysAgo(4000) }, { eventAction: 'expiration', eventDate: daysAgo(-400) }], entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '292' }], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'MarkMonitor Inc.']]] }], status: ['client transfer prohibited'], nameservers: [{ ldhName: 'NS1.PROVIDER.NET' }], secureDNS: { delegationSigned: true } },
  'fresh.example': { ldhName: 'FRESH.EXAMPLE', events: [{ eventAction: 'registration', eventDate: daysAgo(3) }, { eventAction: 'expiration', eventDate: daysAgo(-362) }], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Cheap Registrar LLC']]] }], status: ['active'] },
  'parked.example': { ldhName: 'PARKED.EXAMPLE', events: [{ eventAction: 'registration', eventDate: daysAgo(2000) }, { eventAction: 'expiration', eventDate: daysAgo(-10) }], status: ['client hold'] },
  'nomail.example': { ldhName: 'NOMAIL.EXAMPLE', events: [{ eventAction: 'registration', eventDate: daysAgo(60) }] },
  'mailinator.com': { ldhName: 'MAILINATOR.COM', events: [{ eventAction: 'registration', eventDate: daysAgo(8000) }] },
};
export const BOOTSTRAP = { publication: '2026-10-01T00:00:00Z', services: [[['example'], ['https://rdap.test/example/']], [['com'], ['https://rdap.test/com/']]] };

/** fetchImpl serving DoH JSON (both servers), the IANA bootstrap and RDAP. `opts.hang` = never resolve DoH. */
export function fakeNet({ hang = false, rdapDown = false } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(url);
    const u = new URL(url);
    if (u.pathname === '/dns-query' || u.pathname === '/resolve') {
      if (hang) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      const name = u.searchParams.get('name').toLowerCase(); const type = u.searchParams.get('type');
      const z = ZONES[name];
      const parentExists = Object.keys(ZONES).some((k) => name.endsWith(`.${k}`));
      const status = z || parentExists ? 0 : 3;
      const answers = (z?.[type] || []).map((data) => ({ name: `${name}.`, type: TYPES[type], TTL: 300, data }));
      return Response.json({ Status: status, AD: name === 'good.example', Answer: answers.length ? answers : undefined });
    }
    if (url === 'https://data.iana.org/rdap/dns.json') return Response.json(BOOTSTRAP);
    if (u.hostname === 'rdap.test') {
      if (rdapDown) return new Response('busy', { status: 429 });
      const d = decodeURIComponent(u.pathname.split('/domain/')[1] || '');
      return RDAP[d] ? Response.json(RDAP[d]) : new Response('{}', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, seen };
}

export function fakeFacilitator() {
  const f = { verified: [], settled: [],
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: ['bazaar'], signers: {} }; },
    async verify(payload, req) { f.verified.push(req); const a = payload?.payload?.authorization; return a && a.to.toLowerCase() === req.payTo.toLowerCase() && String(a.value) === String(req.amount) ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'fake_invalid' }; },
    async settle(payload, req) { f.settled.push(req); return { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from }; },
  };
  return f;
}
export function memKv() { const m = new Map(); return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async put(k, v) { m.set(k, v); } }; }

export async function makeApp({ limiter, v1FetchImpl, workMs, net, appOpts = {} } = {}) {
  const { DohResolver } = await import('../src/dns.js');
  const { Rdap } = await import('../src/rdap.js');
  const { _clearRdapCache } = await import('../src/check.js');
  _clearRdapCache();
  const n = net || fakeNet();
  const facilitator = fakeFacilitator(); const stats = new Stats(memKv(), { flushMs: 0 });
  const resolver = new DohResolver({ fetchImpl: n.fetchImpl, timeoutMs: 200 });
  const rdap = new Rdap({ fetchImpl: n.fetchImpl, now: () => NOW, cache: { at: 0, map: {} }, timeoutMs: 200 }); // per-instance bootstrap cache
  const app = createApp({ facilitatorClient: facilitator, resolver, rdap, payTo: PAY_TO, network: NETWORK, publicUrl: BASE, stats, freeLimiter: limiter, v1FetchImpl, workMs, ...appOpts });
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, fetchApp, net: n, facilitator, stats };
}
