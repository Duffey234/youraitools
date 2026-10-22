import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, isPrivateIPv4, isPrivateIPv6, safeFetch, checkDns, FetchError } from '../src/safefetch.js';
import { parseRobots, isAllowed } from '../src/robots.js';

test('SSRF: blocks non-http schemes, credentials, odd ports, local/internal names and private IP literals', () => {
  for (const u of ['file:///etc/passwd', 'ftp://ex.com/', 'gopher://ex.com', 'data:text/html,x', 'javascript:alert(1)', 'http://user:pw@ex.com/', 'http://ex.com:8080/', 'http://localhost/', 'http://foo.localhost/',
    'http://intranet/', 'http://svc.internal/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.1.2.3/', 'http://172.16.5.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://x.agentgate.workers.dev/', 'not a url'])
    assert.throws(() => checkUrl(u, { blockedHosts: ['agentgate.workers.dev'] }), FetchError, u);
  for (const u of ['https://example.com/', 'http://example.com:80/a?b=c', 'https://8.8.8.8/', 'https://[2606:4700::1111]/']) assert.ok(checkUrl(u));
  assert.equal(isPrivateIPv4('8.8.8.8'), false); assert.equal(isPrivateIPv4('172.32.0.1'), false); assert.equal(isPrivateIPv4('172.31.255.255'), true);
  assert.equal(isPrivateIPv6('2606:4700::1111'), false); assert.equal(isPrivateIPv6('fc12::1'), true);
});

test('DNS rebinding guard: hostnames resolving to private addresses are refused', async () => {
  const doh = (ips) => async (url) => Response.json({ Answer: url.includes('type=A&') || url.endsWith('type=A') ? ips.map((data) => ({ type: 1, data })) : [] });
  await assert.rejects(checkDns('evil.example.org', { fetchImpl: doh(['10.0.0.5']) }), (e) => e.code === 'blocked_ip');
  await checkDns('good.example.org', { fetchImpl: doh(['93.184.215.14']) });
  await assert.rejects(checkDns('nx.example.org', { fetchImpl: async () => Response.json({}) }), (e) => e.code === 'dns_failed');
});

test('redirects are re-validated (redirect to metadata IP refused), capped, and bodies are size-limited', async () => {
  const f = async (url) => {
    if (url === 'https://ex.com/r') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    if (url === 'https://ex.com/loop') return new Response(null, { status: 301, headers: { location: '/loop' } });
    if (url === 'https://ex.com/big') return new Response('x'.repeat(5000), { headers: { 'content-type': 'text/plain' } });
    return new Response('ok');
  };
  await assert.rejects(safeFetch('https://ex.com/r', { fetchImpl: f, dns: false }), (e) => e.code === 'blocked_ip');
  await assert.rejects(safeFetch('https://ex.com/loop', { fetchImpl: f, dns: false }), (e) => e.code === 'too_many_redirects');
  const r = await safeFetch('https://ex.com/big', { fetchImpl: f, dns: false, maxBytes: 1000 });
  assert.equal(r.bytes, 1000); assert.equal(r.truncated, true);
});

test('time limit aborts slow servers', async () => {
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(safeFetch('https://ex.com/slow', { fetchImpl: slow, dns: false, timeoutMs: 50 }), (e) => e.code === 'timeout');
});

test('robots.txt: agent groups, longest match, wildcards and $', () => {
  const g = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: WebReadBot\nUser-agent: other\nDisallow: /nobots\n`);
  assert.equal(isAllowed(g, 'webreadbot', '/private/x'), true); // specific group replaces *
  assert.equal(isAllowed(g, 'webreadbot', '/nobots/a'), false);
  const s = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$`);
  assert.equal(isAllowed(s, 'webreadbot', '/private/x'), false);
  assert.equal(isAllowed(s, 'webreadbot', '/private/ok/1'), true);
  assert.equal(isAllowed(s, 'webreadbot', '/a/b.pdf'), false);
  assert.equal(isAllowed(s, 'webreadbot', '/a/b.pdf?x'), true);
  assert.equal(isAllowed(parseRobots(''), 'webreadbot', '/'), true);
});
