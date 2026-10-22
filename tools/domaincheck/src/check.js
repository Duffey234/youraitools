// DomainCheck engine: domain and email trust reports from public DNS (DoH) and RDAP. No API keys, no paid upstreams.
//   checkDomain('example.com', { tier: 'full' | 'preview' })
//   checkEmail('jane@example.com', { tier: 'full' | 'preview' })
// Mailbox existence is NOT probed (no SMTP RCPT checks: they are unreliable, often blocked, and look like abuse).
import { getDomain, getPublicSuffix } from 'tldts';
import { DohResolver } from './dns.js';
import { Rdap } from './rdap.js';
import { parseEmail, normalizeDomain, isDisposableDomain, FREE_PROVIDERS } from './email.js';
import { parseSpf, parseDmarc, parseMtaSts, parseTlsRpt, parseBimi, parseDkim, DKIM_SELECTORS, mxProvider, isParkingNs } from './mailauth.js';
import { unquoteTxt } from './dns.js';

export const ENGINE_VERSION = 'domaincheck-2026.10.21';

// Each flag: [id, severity, score penalty, description]. Public at /v1/flags.
export const FLAGS = {
  nonexistent_domain: ['critical', 100, 'The domain does not exist in DNS (NXDOMAIN).'],
  registry_hold: ['critical', 45, 'Registry/registrar status is hold, pending delete or redemption: the domain is suspended or expiring.'],
  newly_registered_7d: ['high', 45, 'Registered in the last 7 days. Most phishing and throwaway-signup domains are this young.'],
  newly_registered_30d: ['high', 35, 'Registered in the last 30 days.'],
  young_domain_90d: ['medium', 20, 'Registered in the last 90 days.'],
  young_domain_1y: ['low', 5, 'Registered in the last year.'],
  expiring_15d: ['medium', 15, 'Registration expires within 15 days.'],
  disposable_email_domain: ['high', 45, 'Known disposable / throwaway email provider.'],
  parked_domain: ['medium', 30, 'Nameservers belong to a domain-parking or for-sale service.'],
  no_mail_server: ['medium', 15, 'No MX and no A/AAAA record: the domain cannot receive email.'],
  null_mx: ['medium', 10, 'Null MX (RFC 7505): the domain explicitly accepts no email.'],
  no_spf: ['low', 10, 'No SPF record: anyone can spoof mail from this domain.'],
  spf_pass_all: ['medium', 15, 'SPF ends in +all: every server on the internet is authorized to send as this domain.'],
  spf_multiple: ['low', 10, 'More than one SPF record (permerror for receivers).'],
  no_dmarc: ['low', 10, 'No DMARC record (checked the host and its registrable domain).'],
  dmarc_none: ['low', 5, 'DMARC policy is p=none (monitoring only, no enforcement).'],
  no_web_address: ['low', 10, 'No A/AAAA record: nothing is hosted at this name.'],
  dns_lookup_failed: ['info', 0, 'Some DNS lookups failed or timed out; affected sections are marked.'],
  rdap_unavailable: ['info', 0, 'Registration data (RDAP) was unavailable for this TLD or timed out; age-based checks skipped.'],
  role_address: ['low', 10, 'Role account (info@, support@, noreply@ ...), usually not a single person.'],
  free_email_provider: ['info', 0, 'Free webmail provider (gmail.com, outlook.com ...).'],
  invalid_syntax: ['critical', 100, 'Not a syntactically valid email address.'],
};
const flag = (id, extra) => ({ id, severity: FLAGS[id][0], penalty: FLAGS[id][1], description: FLAGS[id][2], ...(extra ? { detail: extra } : {}) });

const rdapCache = new Map(); // registrable domain -> { at, value }, per isolate, 6 h; keeps registry load polite
const RDAP_TTL = 6 * 3600000;

function scoreOf(flags) {
  if (flags.some((f) => f.id === 'nonexistent_domain' || f.id === 'invalid_syntax')) return 0;
  return Math.max(0, 100 - flags.reduce((s, f) => s + f.penalty, 0));
}
const verdictOf = (score) => (score >= 70 ? 'low_risk' : score >= 40 ? 'medium_risk' : 'high_risk');

/** Mail-authentication grade A-F from SPF, DMARC, MTA-STS. */
export function mailGrade({ spf, dmarc, mta_sts }) {
  let pts = 0;
  if (spf?.present && !spf.multiple) pts += spf.policy === 'fail' ? 3 : spf.policy === 'softfail' ? 2 : spf.policy === 'redirect' ? 2 : spf.policy === 'pass' ? 0 : 1;
  if (dmarc?.present) pts += dmarc.policy === 'reject' ? 4 : dmarc.policy === 'quarantine' ? 3 : 1;
  if (mta_sts?.present) pts += 1;
  return pts >= 7 ? 'A' : pts >= 5 ? 'B' : pts >= 4 ? 'C' : pts >= 2 ? 'D' : 'F';
}

function deps(o) {
  return { resolver: o.resolver || new DohResolver({ fetchImpl: o.fetchImpl, timeoutMs: o.dnsTimeoutMs }), rdap: o.rdap || new Rdap({ fetchImpl: o.fetchImpl, timeoutMs: o.rdapTimeoutMs, now: o.now, userAgent: o.userAgent }), now: o.now || (() => Date.now()) };
}

async function rdapCached(rdap, domain, now) {
  const hit = rdapCache.get(domain);
  if (hit && now() - hit.at < RDAP_TTL && hit.value.found) return { ...hit.value, cached: true };
  const value = await rdap.lookup(domain);
  if (value.found) { rdapCache.set(domain, { at: now(), value }); if (rdapCache.size > 2000) rdapCache.delete(rdapCache.keys().next().value); }
  return value;
}
export const _clearRdapCache = () => rdapCache.clear();

/**
 * Domain trust + email-authentication report.
 * @param {string} input domain, URL or email address
 * @param {{tier?:'full'|'preview', resolver?:any, rdap?:any, fetchImpl?:Function, now?:()=>number}} [o]
 */
export async function checkDomain(input, o = {}) {
  const t0 = Date.now();
  const tier = o.tier || 'full';
  const fullTier = tier !== 'preview';
  const extras = fullTier && !o.mailOnly; // DKIM / MTA-STS / TLS-RPT / BIMI / CAA
  const { resolver, rdap, now } = deps(o);
  const host = normalizeDomain(input);
  if (!host) return { error: 'invalid_domain', message: 'not a valid domain name' };
  const registrable = getDomain(host, { allowPrivateDomains: false });
  const suffix = getPublicSuffix(host, { allowPrivateDomains: false });
  if (!registrable) return { error: 'invalid_domain', message: `"${host}" is a public suffix or has no registrable domain` };

  const q = (name, type) => resolver.query(name, type);
  const base = {
    a: q(host, 'A'), aaaa: q(host, 'AAAA'), mx: q(host, 'MX'), txt: q(host, 'TXT'),
    ns: q(registrable, 'NS'), dmarc: q(`_dmarc.${host}`, 'TXT'),
  };
  const full = extras ? {
    caa: q(host, 'CAA'), mtasts: q(`_mta-sts.${host}`, 'TXT'), tlsrpt: q(`_smtp._tls.${host}`, 'TXT'), bimi: q(`default._bimi.${host}`, 'TXT'),
    ...Object.fromEntries(DKIM_SELECTORS.map((s) => [`dkim:${s}`, q(`${s}._domainkey.${host}`, 'TXT')])),
  } : {};
  const rdapP = fullTier && !o.skipRdap ? rdapCached(rdap, registrable, now) : null;
  const keys = [...Object.keys(base), ...Object.keys(full)];
  const vals = await Promise.all([...Object.values(base), ...Object.values(full)]);
  const R = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  let dmarcRes = R.dmarc; let dmarcFrom = null;
  if (!DohResolver.of(dmarcRes, 'TXT').some((a) => /v\s*=\s*DMARC1/i.test(unquoteTxt(a.data))) && host !== registrable) {
    dmarcRes = await q(`_dmarc.${registrable}`, 'TXT'); dmarcFrom = registrable;
  }
  // Core lookups failed: no trustworthy report is possible. Return an error (the API answers 503 and never charges).
  const core = ['a', 'mx', 'ns', 'txt'].filter((k) => R[k].status === 'ERROR');
  if (core.length >= 2) return { error: 'dns_unavailable', message: `DNS lookups failed (${core.map((k) => `${k}: ${R[k].error}`).join('; ')}); not charged, please retry`, status: 503 };
  const failed = Object.entries(R).filter(([, r]) => r.status === 'ERROR' || r.status === 'SERVFAIL').map(([k]) => k);
  const exists = !(R.a.status === 'NXDOMAIN' && R.mx.status === 'NXDOMAIN' && R.ns.status === 'NXDOMAIN') && !(R.a.status === 'NXDOMAIN' && R.txt.status === 'NXDOMAIN' && R.mx.status === 'NXDOMAIN');
  const flags = [];
  const txts = DohResolver.of(R.txt, 'TXT').map((a) => unquoteTxt(a.data));
  const mxRecs = DohResolver.of(R.mx, 'MX').map((a) => { const [p, h] = String(a.data).split(/\s+/); return { priority: Number(p), host: String(h || '').replace(/\.$/, '').toLowerCase() }; }).sort((x, y) => x.priority - y.priority);
  const nullMx = mxRecs.length === 1 && (mxRecs[0].host === '' || mxRecs[0].host === '.');
  const a = DohResolver.of(R.a, 'A').map((x) => x.data); const aaaa = DohResolver.of(R.aaaa, 'AAAA').map((x) => x.data);
  const ns = DohResolver.of(R.ns, 'NS').map((x) => String(x.data).replace(/\.$/, '').toLowerCase());
  const spf = parseSpf(txts);
  const dmarc = parseDmarc(DohResolver.of(dmarcRes, 'TXT').map((x) => unquoteTxt(x.data)), { inherited: !!dmarcFrom, from: dmarcFrom });

  const report = {
    input: String(input), domain: host, registrable_domain: registrable, public_suffix: suffix, tier, exists,
    dns: {
      a, aaaa, ns,
      mx: nullMx ? [] : mxRecs, null_mx: nullMx,
      cname: [...DohResolver.of(R.a, 'CNAME')].map((x) => String(x.data).replace(/\.$/, '')),
      dnssec_validated: !!(R.a.ad || R.mx.ad || R.ns.ad),
      ...(extras ? { caa: DohResolver.of(R.caa, 'CAA').map((x) => x.data) } : {}),
      txt_count: txts.length,
    },
    email: { accepts_mail: !nullMx && (mxRecs.length > 0 || a.length > 0 || aaaa.length > 0), mx_provider: nullMx ? null : mxProvider(mxRecs.map((m) => m.host)), spf, dmarc },
  };
  if (extras) {
    const dkim = DKIM_SELECTORS.map((s) => ({ selector: s, rec: parseDkim(DohResolver.of(R[`dkim:${s}`], 'TXT').map((x) => unquoteTxt(x.data))) })).filter((d) => d.rec).map((d) => ({ selector: d.selector, ...d.rec }));
    const live = dkim.filter((k) => !k.revoked);
    report.email.dkim = { selectors_found: live, revoked_selectors: dkim.length - live.length, selectors_checked: DKIM_SELECTORS.length, note: 'DKIM selectors cannot be enumerated; only common selectors are checked, so none found does not mean DKIM is absent.' };
    report.email.mta_sts = parseMtaSts(DohResolver.of(R.mtasts, 'TXT').map((x) => unquoteTxt(x.data)));
    report.email.tls_rpt = parseTlsRpt(DohResolver.of(R.tlsrpt, 'TXT').map((x) => unquoteTxt(x.data)));
    report.email.bimi = parseBimi(DohResolver.of(R.bimi, 'TXT').map((x) => unquoteTxt(x.data)));
  }
  if (fullTier) report.email.grade = mailGrade(report.email);

  if (!exists) flags.push(flag('nonexistent_domain'));
  else {
    if (isDisposableDomain(host)) flags.push(flag('disposable_email_domain'));
    if (ns.some(isParkingNs)) flags.push(flag('parked_domain', ns.filter(isParkingNs).join(', ')));
    if (nullMx) flags.push(flag('null_mx'));
    else if (!report.email.accepts_mail) flags.push(flag('no_mail_server'));
    if (!a.length && !aaaa.length) flags.push(flag('no_web_address'));
    if (!spf.present) flags.push(flag('no_spf'));
    else { if (spf.policy === 'pass') flags.push(flag('spf_pass_all')); if (spf.multiple) flags.push(flag('spf_multiple')); }
    if (!dmarc.present) flags.push(flag('no_dmarc'));
    else if (dmarc.policy === 'none') flags.push(flag('dmarc_none'));
  }
  if (rdapP) {
    const reg = await rdapP;
    report.registration = reg;
    if (exists) {
      if (!reg.found || reg.age_days == null) flags.push(flag('rdap_unavailable', reg.error || reg.note || 'no registration date published'));
      else {
        const age = reg.age_days;
        if (age < 7) flags.push(flag('newly_registered_7d', `${age} days`));
        else if (age < 30) flags.push(flag('newly_registered_30d', `${age} days`));
        else if (age < 90) flags.push(flag('young_domain_90d', `${age} days`));
        else if (age < 365) flags.push(flag('young_domain_1y', `${age} days`));
      }
      if (reg.found && reg.expires_in_days != null && reg.expires_in_days < 15) flags.push(flag('expiring_15d', `${reg.expires_in_days} days`));
      if (reg.found && (reg.status || []).some((s) => /hold|pending delete|pendingdelete|redemption/.test(s))) flags.push(flag('registry_hold', reg.status.filter((s) => /hold|delete|redemption/.test(s)).join(', ')));
    }
  }
  if (failed.length) flags.push(flag('dns_lookup_failed', failed.join(', ')));
  if (fullTier) {
    report.score = scoreOf(flags);
    report.verdict = exists ? verdictOf(report.score) : 'nonexistent';
  }
  const { input: _i, domain, registrable_domain, public_suffix, tier: _t, exists: _e, score, verdict, ...rest } = report;
  return {
    input: String(input), domain, registrable_domain, public_suffix, tier, exists,
    ...(fullTier ? { verdict, score } : {}), flags, ...rest,
    engine: ENGINE_VERSION, dns_queries: Object.keys(R).length + (dmarcFrom ? 1 : 0), ms: Date.now() - t0,
  };
}

/**
 * Email address check: syntax, disposable / role / free provider, domain mail setup (MX, SPF, DMARC) and, on the full
 * tier, domain registration age and parking. Mailbox existence is not probed.
 */
export async function checkEmail(input, o = {}) {
  const t0 = Date.now();
  const tier = o.tier || 'full';
  const p = parseEmail(input);
  const out = { input: p.input, tier, syntax: { valid: p.valid_syntax, reason: p.reason } };
  if (!p.valid_syntax) {
    return { ...out, verdict: 'invalid', score: 0, flags: [flag('invalid_syntax', p.reason)], mailbox_checked: false, engine: ENGINE_VERSION, ms: Date.now() - t0 };
  }
  Object.assign(out, { normalized: p.normalized, canonical: p.canonical, local: p.local, domain: p.domain, plus_tag: p.plus_tag, role: p.role, free_provider: p.free_provider, disposable: p.disposable, smtputf8: p.smtputf8 });
  const flags = [];
  if (p.disposable) flags.push(flag('disposable_email_domain'));
  if (p.role) flags.push(flag('role_address'));
  if (p.free_provider) flags.push(flag('free_email_provider'));
  if (tier === 'preview') {
    return { ...out, flags, mailbox_checked: false, note: 'Free preview: syntax and provider lists only. The paid check adds MX / SPF / DMARC, domain age (RDAP), parking and a score + verdict.', engine: ENGINE_VERSION, ms: Date.now() - t0 };
  }
  // Big free providers are long-lived and well configured; skip RDAP for them to keep the call fast.
  const d = await checkDomain(p.domain, { ...o, tier: 'full', mailOnly: true, skipRdap: FREE_PROVIDERS.has(p.domain) });
  if (d.error) return d;
  const domFlags = (d.flags || []).filter((f) => !['no_web_address', 'disposable_email_domain'].includes(f.id));
  flags.push(...domFlags);
  const undeliverable = !d.exists || d.dns?.null_mx || !d.email?.accepts_mail;
  const score = undeliverable ? 0 : scoreOf(flags);
  const verdict = undeliverable ? 'undeliverable' : (p.disposable || score < 70) ? 'risky' : 'valid';
  return {
    ...out,
    verdict, score,
    deliverability: { domain_exists: d.exists, accepts_mail: !!d.email?.accepts_mail, mx: d.dns?.mx || [], null_mx: !!d.dns?.null_mx, mx_provider: d.email?.mx_provider || null },
    domain_auth: { spf: d.email?.spf?.present ? d.email.spf.policy : 'missing', dmarc: d.email?.dmarc?.present ? d.email.dmarc.policy : 'missing', grade: d.email?.grade || null },
    registration: d.registration ? { registrar: d.registration.registrar || null, created: d.registration.created || null, age_days: d.registration.age_days ?? null, source: d.registration.source } : null,
    flags,
    mailbox_checked: false,
    note: 'Mailbox existence is not probed (no SMTP RCPT check). "valid" means the address is well-formed, the domain accepts mail and nothing looks risky.',
    engine: ENGINE_VERSION, dns_queries: d.dns_queries, ms: Date.now() - t0,
  };
}
