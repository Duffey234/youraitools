import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpf, parseDmarc, mxProvider, isParkingNs, parseDkim } from '../src/mailauth.js';
import { unquoteTxt } from '../src/dns.js';
import { parseEmail, normalizeDomain, isDisposableDomain, DISPOSABLE_COUNT } from '../src/email.js';
import { parseRdap } from '../src/rdap.js';
import { mailGrade } from '../src/check.js';
import { DOMAIN_EXAMPLE, EMAIL_EXAMPLE } from '../src/examples.js';

test('TXT unquoting joins 255-byte chunks and decodes escapes', () => {
  assert.equal(unquoteTxt('"v=spf1 include:a" " -all"'), 'v=spf1 include:a -all');
  assert.equal(unquoteTxt('"a\\"b\\059c"'), 'a"b;c');
  assert.equal(unquoteTxt('plain'), 'plain');
});

test('SPF parsing: policy, includes, multiple, +all', () => {
  const s = parseSpf(['v=spf1 ip4:1.2.3.4 include:_spf.google.com include:x.net ~all', 'other']);
  assert.deepEqual([s.present, s.policy, s.all, s.includes.length, s.dns_lookups_top_level, s.multiple], [true, 'softfail', '~all', 2, 2, false]);
  assert.equal(parseSpf(['v=spf1 +all']).policy, 'pass');
  assert.equal(parseSpf(['v=spf1 -all', 'v=spf1 ~all']).multiple, true);
  assert.equal(parseSpf(['v=spf1 redirect=_spf.google.com']).policy, 'redirect');
  assert.equal(parseSpf(['google-site-verification=x']).present, false);
});

test('DMARC parsing + grade', () => {
  const d = parseDmarc(['v=DMARC1; p=quarantine; sp=reject; pct=50; rua=mailto:a@b']);
  assert.deepEqual([d.policy, d.subdomain_policy, d.pct, d.rua], ['quarantine', 'reject', 50, true]);
  assert.equal(parseDmarc(['v=spf1 -all']).present, false);
  assert.equal(mailGrade({ spf: parseSpf(['v=spf1 -all']), dmarc: parseDmarc(['v=DMARC1; p=reject']), mta_sts: { present: true } }), 'A');
  assert.equal(mailGrade({ spf: { present: false }, dmarc: { present: false } }), 'F');
});

test('DKIM, MX provider and parking detection', () => {
  assert.deepEqual(parseDkim(['v=DKIM1; k=ed25519; p=abc']), { key_type: 'ed25519', revoked: false, testing: false });
  assert.equal(parseDkim(['v=DKIM1; p=']).revoked, true);
  assert.equal(mxProvider(['contoso-com.mail.protection.outlook.com']), 'Microsoft 365 / Outlook');
  assert.equal(mxProvider(['mx.example.org']), 'other / self-hosted');
  assert.ok(isParkingNs('ns1.sedoparking.com')); assert.ok(!isParkingNs('ns1.cloudflare.com'));
});

test('email syntax and classification', () => {
  const e = parseEmail('John.Doe+Tag@GoogleMail.com');
  assert.deepEqual([e.valid_syntax, e.canonical, e.plus_tag, e.free_provider], [true, 'johndoe@gmail.com', 'tag', true]);
  for (const bad of ['', 'a', '@x.com', 'a@', 'a..b@x.com', '.a@x.com', 'a@x', 'a@-x.com', 'a b@x.com', `${'a'.repeat(65)}@x.com`, 'a@1.2.3.4']) assert.equal(parseEmail(bad).valid_syntax, false, bad);
  assert.equal(parseEmail('postmaster@x.org').role, true);
  assert.equal(parseEmail('a@sub.mailinator.com').disposable, true);
  assert.ok(DISPOSABLE_COUNT > 5000); assert.ok(isDisposableDomain('guerrillamail.com'));
  assert.equal(parseEmail('bob@例え.jp').domain, 'xn--r8jz45g.jp');
});

test('domain normalization accepts URLs and emails, rejects junk', () => {
  assert.equal(normalizeDomain('https://Sub.Example.COM:8443/x?y'), 'sub.example.com');
  assert.equal(normalizeDomain('jane@example.org'), 'example.org');
  assert.equal(normalizeDomain('example.com.'), 'example.com');
  for (const b of ['localhost', '1.2.3.4', 'exa mple.com', '-a.com', 'a..com', '']) assert.equal(normalizeDomain(b), null, b);
});

test('RDAP parsing: dates, age, registrar, status', () => {
  const now = Date.parse('2026-01-11T00:00:00Z');
  const r = parseRdap({ ldhName: 'X.COM', events: [{ eventAction: 'registration', eventDate: '2026-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' }], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Reg Inc']]] }], status: ['Client Hold'] }, now);
  assert.deepEqual([r.domain, r.age_days, r.registrar, r.status[0]], ['x.com', 10, 'Reg Inc', 'client hold']);
});

test('Bazaar examples are real captured outputs with the documented shape', () => {
  for (const k of ['domain', 'exists', 'verdict', 'score', 'flags', 'dns', 'email', 'registration']) assert.ok(k in DOMAIN_EXAMPLE, k);
  for (const k of ['verdict', 'score', 'deliverability', 'domain_auth', 'flags', 'mailbox_checked']) assert.ok(k in EMAIL_EXAMPLE, k);
  assert.equal(EMAIL_EXAMPLE.mailbox_checked, false);
});
