import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStack, extractPage, cookieNames, groupByCategory, normalizeTarget, dnsName, isCloudflareIp, SIGNATURE_COUNT, HTML_SCAN_BYTES } from '../src/detect.js';
import { SIGNATURES, CATEGORIES } from '../src/signatures.js';
import { WP_HTML } from './helpers.js';

test('signature set: unique names, known categories, implies point at real entries', () => {
  const names = SIGNATURES.map((s) => s.name);
  assert.equal(new Set(names).size, names.length); assert.ok(SIGNATURE_COUNT > 200);
  for (const s of SIGNATURES) { for (const c of s.cats) assert.ok(CATEGORIES[c], `${s.name}: ${c}`); for (const i of s.implies || []) assert.ok(names.includes(i), `${s.name} implies ${i}`); }
});

test('extractPage: scripts, links, meta (name/property), title', () => {
  const p = extractPage(WP_HTML);
  assert.equal(p.meta.generator, 'WordPress 6.6.2'); assert.equal(p.meta['og:title'], 'Shop'); assert.equal(p.title, 'Test Shop');
  assert.ok(p.scripts.some((s) => s.includes('jquery.min.js'))); assert.ok(p.links.some((s) => s.includes('fonts.googleapis.com')));
});

test('matchStack: headers with versions, cookies (names only), meta, scripts, html markers, implies, no false Apache on Tomcat', () => {
  const page = { ...extractPage(WP_HTML), headers: { server: 'Apache/2.4.58 (Ubuntu)', 'x-powered-by': 'PHP/8.3.0' }, cookies: ['PHPSESSID', 'wp-settings-1'] };
  const t = Object.fromEntries(matchStack(page).map((x) => [x.name, x]));
  assert.equal(t['Apache HTTP Server'].version, '2.4.58'); assert.equal(t.PHP.version, '8.3.0'); assert.equal(t.WordPress.version, '6.6.2');
  assert.ok(t.WooCommerce && t['Meta Pixel'] && t['Google Analytics'] && t.Stripe);
  assert.equal(t.MySQL.confidence, 50); assert.equal(t.MySQL.evidence[0].type, 'implied');
  const tom = matchStack({ headers: { server: 'Apache-Coyote/1.1' } }).map((x) => x.name);
  assert.ok(tom.includes('Apache Tomcat') && !tom.includes('Apache HTTP Server'), tom.join());
  assert.ok(!matchStack({ headers: { server: 'GitHub.com' }, host: 'github.com' }).some((x) => x.name === 'GitHub Pages'));
  assert.ok(matchStack({ headers: { server: 'GitHub.com' }, host: 'someone.github.io' }).some((x) => x.name === 'GitHub Pages'));
});

test('matchStack DNS: MX / NS / SPF include / verification TXT', () => {
  const r = matchStack({}, { mx: ['example-com.mail.protection.outlook.com'], ns: ['ns-1.awsdns-01.org'], txt: ['v=spf1 include:amazonses.com include:mail.zendesk.com -all', 'stripe-verification=abc', 'openai-domain-verification=dv-1'] });
  const n = r.map((x) => x.name);
  for (const x of ['Microsoft 365', 'Amazon Route 53', 'Amazon SES', 'Zendesk (email)', 'Stripe (verified domain)', 'OpenAI']) assert.ok(n.includes(x), x);
  assert.ok(groupByCategory(r)['email-provider'].includes('Microsoft 365'));
});

test('cookieNames: getSetCookie and folded header; values dropped', () => {
  const h = new Headers(); h.append('set-cookie', 'a=1; Path=/'); h.append('set-cookie', '_ga=GA1.2; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
  assert.deepEqual(cookieNames(h), ['a', '_ga']);
  assert.deepEqual(cookieNames({ get: () => 'x=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, y=2' }), ['x', 'y']);
});

test('normalizeTarget / dnsName; large pages are scanned head + tail only and stay fast', () => {
  assert.equal(normalizeTarget('shopify.com').href, 'https://shopify.com/'); assert.throws(() => normalizeTarget('')); assert.throws(() => normalizeTarget('javascript:alert(1)'));
  assert.equal(dnsName('www.Example.com.'), 'example.com'); assert.equal(dnsName('a.b.example.co.uk'), 'example.co.uk'); assert.equal(dnsName('me.github.io'), 'me.github.io');
  const big = '<html><head><meta name="generator" content="Hugo 0.120.0"></head><body>' + '<div class="x">lorem ipsum</div>'.repeat(60000) + '<script>window.__NUXT__={}</script></body></html>';
  const p = extractPage(big); assert.ok(p.html.length < HTML_SCAN_BYTES + 40000);
  const t0 = performance.now(); const r = matchStack({ ...p, headers: {} }); const ms = performance.now() - t0;
  assert.ok(r.some((x) => x.name === 'Hugo') && r.some((x) => x.name === 'Nuxt'), 'head and tail both scanned');
  assert.ok(ms < 200, `${ms} ms`);
});

test('Cloudflare on Workers: edge-injected server/cf-ray ignored with cfEdge; detected from Cloudflare IP ranges instead', () => {
  const H = { server: 'cloudflare', 'cf-ray': 'abc-SEA', 'cf-cache-status': 'DYNAMIC', 'x-powered-by': 'PHP/8.1.0' };
  assert.ok(matchStack({ headers: H }).some((x) => x.name === 'Cloudflare'), 'off Workers the header counts');
  const edge = matchStack({ headers: H, cfEdge: true, ips: ['192.0.78.9'] }).map((x) => x.name);
  assert.ok(!edge.includes('Cloudflare') && edge.includes('PHP'), edge.join());
  const cf = matchStack({ headers: H, cfEdge: true, ips: ['104.18.32.7'] }).find((x) => x.name === 'Cloudflare');
  assert.equal(cf.evidence[0].type, 'ip');
  assert.ok(isCloudflareIp('2606:4700::6810:84e5') && isCloudflareIp('172.67.1.1') && !isCloudflareIp('8.8.8.8') && !isCloudflareIp('104.15.255.255'));
});
