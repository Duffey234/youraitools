// Parsers for mail-authentication DNS records: SPF (RFC 7208), DMARC (RFC 7489), MTA-STS (RFC 8461),
// TLS-RPT (RFC 8460), BIMI; plus MX provider and parking-nameserver detection. Pure functions.

export function parseSpf(txts) {
  const recs = txts.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (!recs.length) return { present: false };
  const record = recs[0].trim();
  const terms = record.split(/\s+/).slice(1);
  const mech = terms.map((t) => { const m = /^([+\-~?]?)([a-z0-9]+)(?:[:=/](.*))?$/i.exec(t); return m ? { q: m[1] || '+', name: m[2].toLowerCase(), value: m[3] || null } : { q: '+', name: 'invalid', value: t }; });
  const all = mech.find((m) => m.name === 'all');
  const lookups = mech.filter((m) => ['include', 'a', 'mx', 'ptr', 'exists', 'redirect'].includes(m.name)).length;
  const policy = all ? { '-': 'fail', '~': 'softfail', '?': 'neutral', '+': 'pass' }[all.q] : (mech.some((m) => m.name === 'redirect') ? 'redirect' : 'none');
  return {
    present: true, record, multiple: recs.length > 1,
    all: all ? `${all.q === '+' ? '+' : all.q}all` : null, policy,
    includes: mech.filter((m) => m.name === 'include').map((m) => m.value),
    redirect: mech.find((m) => m.name === 'redirect')?.value || null,
    dns_lookups_top_level: lookups,
    invalid_terms: mech.filter((m) => m.name === 'invalid').map((m) => m.value),
  };
}

export function parseTags(record) {
  const tags = {};
  for (const part of record.split(';')) { const i = part.indexOf('='); if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
  return tags;
}

export function parseDmarc(txts, { inherited = false, from = null } = {}) {
  const recs = txts.filter((t) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(t.trim()));
  if (!recs.length) return { present: false };
  const record = recs[0].trim(); const t = parseTags(record);
  const p = (t.p || '').toLowerCase();
  return {
    present: true, record, multiple: recs.length > 1, inherited_from: inherited ? from : null,
    policy: ['none', 'quarantine', 'reject'].includes(p) ? p : (p ? `invalid:${p}` : 'missing'),
    subdomain_policy: (t.sp || '').toLowerCase() || null,
    pct: t.pct !== undefined ? Number(t.pct) : 100,
    rua: !!t.rua, ruf: !!t.ruf,
    adkim: (t.adkim || 'r').toLowerCase(), aspf: (t.aspf || 'r').toLowerCase(),
  };
}

export function parseMtaSts(txts) {
  const r = txts.find((t) => /^v=STSv1/i.test(t.trim()));
  return r ? { present: true, id: parseTags(r).id || null } : { present: false };
}
export function parseTlsRpt(txts) { const r = txts.find((t) => /^v=TLSRPTv1/i.test(t.trim())); return { present: !!r }; }
export function parseBimi(txts) { const r = txts.find((t) => /^v=BIMI1/i.test(t.trim())); if (!r) return { present: false }; const t = parseTags(r); return { present: true, logo: t.l || null, vmc: !!t.a }; }
export function parseDkim(txts) {
  const r = txts.find((t) => /(^|;)\s*(v=DKIM1|k=|p=)/i.test(t));
  if (!r) return null;
  const t = parseTags(r);
  return { key_type: (t.k || 'rsa').toLowerCase(), revoked: t.p === '', testing: /y/i.test(t.t || '') };
}

// Common DKIM selectors (big providers). DKIM selectors can't be enumerated, so absence here proves nothing.
// Kept to 10 so a full report stays well under the Workers free-plan limit of 50 subrequests, even with DoH fallback.
export const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 's2', 'dkim', 'protonmail', 'fm1'];

const MX_PROVIDERS = [
  [/(^|\.)google(mail)?\.com$|aspmx\.l\.google\.com$|\.googlemail\.com$|smtp\.google\.com$/, 'Google Workspace / Gmail'],
  [/\.mail\.protection\.outlook\.com$|\.olc\.protection\.outlook\.com$|hotmail\.com$|outlook\.com$/, 'Microsoft 365 / Outlook'],
  [/\.yahoodns\.net$|yahoo\.com$/, 'Yahoo'],
  [/icloud\.com$|me\.com$/, 'Apple iCloud'],
  [/protonmail\.ch$|proton\.me$/, 'Proton Mail'],
  [/zoho\.(com|eu|in|com\.au)$/, 'Zoho Mail'],
  [/messagingengine\.com$/, 'Fastmail'],
  [/yandex\.(net|ru)$/, 'Yandex'],
  [/mail\.ru$/, 'Mail.ru'],
  [/mimecast\.com$/, 'Mimecast'],
  [/pphosted\.com$|ppe-hosted\.com$/, 'Proofpoint'],
  [/barracudanetworks\.com$/, 'Barracuda'],
  [/cf-emailsecurity\.net$|mx\.cloudflare\.net$/, 'Cloudflare'],
  [/amazonaws\.com$|amazonses\.com$/, 'Amazon SES / WorkMail'],
  [/secureserver\.net$/, 'GoDaddy'],
  [/ovh\.net$/, 'OVH'],
  [/ionos\.|kundenserver\.de$|1and1\./, 'IONOS'],
  [/gmx\.(net|com)$|web\.de$/, 'GMX / WEB.DE'],
  [/hostinger\.com$/, 'Hostinger'],
  [/namecheap|privateemail\.com$|registrar-servers\.com$/, 'Namecheap'],
  [/mailgun\.org$/, 'Mailgun'],
  [/sendgrid\.net$/, 'SendGrid'],
  [/tutanota\.de$|tuta\.io$/, 'Tuta'],
  [/improvmx\.com$/, 'ImprovMX (forwarding)'],
  [/forwardemail\.net$/, 'Forward Email (forwarding)'],
  [/mx\d*\.zoho/, 'Zoho Mail'],
];
export function mxProvider(hosts) {
  for (const h of hosts) for (const [re, name] of MX_PROVIDERS) if (re.test(h)) return name;
  return hosts.length ? 'other / self-hosted' : null;
}

// Nameservers of domain-parking / for-sale services.
const PARKING_NS = /(sedoparking\.com|parkingcrew\.net|bodis\.com|above\.com|afternic\.com|dan\.com|undeveloped\.com|parklogic\.com|uniregistrymarket\.link|huge-domains\.com|hugedomains\.com|domaincontrol\.com\.parked|ns1\.parked|parked\.com|namebrightdns\.com|smartname\.com|cashparking\.com|dsredirection\.com|fabulous\.com|voodoo\.com|rookdns\.com|ztomy\.com|brandbucket\.com|squadhelp\.com|atom\.com|perfectdomain\.com|epik\.com\.parked)$/;
export const isParkingNs = (ns) => PARKING_NS.test(ns);
