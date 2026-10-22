import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSite, AuditIncomplete, InputError, validateLlmsTxt, WEIGHTS, isChallenge } from '../src/audit.js';
import { normalizeTarget, isPrivateIp, createSafeFetcher, USER_AGENT, FetchFailure } from '../src/net.js';
import { parseRobots, isAllowed, botMatrix, contentSignals } from '../src/robots.js';
import { mockWeb } from './mock.js';

const run = (u, web = mockWeb()) => auditSite(u, { fetchImpl: web.fetchImpl });
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('weights: 23 checks, 100 points', () => {
  assert.equal(Object.keys(WEIGHTS).length, 23);
  assert.equal(Object.values(WEIGHTS).reduce((s, [, w]) => s + w, 0), 100);
});

test('agent-ready site: 100/100, grade A, high confidence, nothing failed, no fixes', async () => {
  const r = await run('good-site.com');
  assert.equal(r.final_url, 'https://good-site.com/');
  assert.equal(r.score, 100); assert.equal(r.grade, 'A'); assert.equal(r.verdict, 'agent_ready'); assert.equal(r.confidence, 'high');
  assert.deepEqual(r.sources_failed, []); assert.equal(r.fixes.length, 0); assert.equal(r.checks.length, 23);
  const c = byId(r);
  assert.match(c.mcp.detail, /good-mcp 1\.0\.0/); assert.equal(c.markdown.status, 'pass'); assert.equal(c.llms_txt.status, 'pass');
  assert.equal(c.https_redirect_hsts.points, 2); assert.equal(r.robots.bots.GPTBot.status, 'allowed');
});

test('poor site: blocked AI agents, JS-only shell, soft-404 llms.txt; fixes ordered by points with ready-to-paste snippets', async () => {
  const r = await run('https://poor-site.com');
  const c = byId(r);
  assert.ok(r.score < 40, String(r.score)); assert.equal(r.grade, 'F'); assert.equal(r.verdict, 'not_ready');
  assert.equal(c.no_js_content.status, 'fail'); assert.match(c.no_js_content.detail, /app shell/);
  assert.equal(c.robots_agents.status, 'warn'); assert.match(c.robots_agents.detail, /ChatGPT-User, Claude-User, Perplexity-User/);
  assert.equal(r.robots.bots['MistralAI-User'].status, 'allowed'); assert.equal(r.robots.bots.GPTBot.status, 'blocked');
  assert.equal(c.llms_txt.status, 'fail'); assert.match(c.llms_txt.detail, /soft 404/);
  assert.equal(r.fixes[0].check, 'no_js_content'); assert.equal(r.fixes[0].priority, 'high');
  for (let i = 1; i < r.fixes.length; i++) assert.ok(r.fixes[i - 1].points_gain >= r.fixes[i].points_gain);
  assert.match(r.snippets.llms_txt, /^# App\n\n> /);
  assert.match(r.snippets.robots_txt, /User-agent: ChatGPT-User[\s\S]*Allow: \//);
  assert.doesNotMatch(r.snippets.robots_txt, /^User-agent: GPTBot/m, 'training bots are left to the owner');
  assert.match(r.snippets.json_ld, /"@type": "Organization"/); assert.match(r.snippets.meta_tags, /og:title/);
  assert.equal(r.top_issues.length, 5);
});

test('bot challenge: reported as a failure for agents (not a pass, not an outage)', async () => {
  const r = await run('challenge-site.com');
  const c = byId(r);
  assert.equal(c.no_challenge.status, 'fail'); assert.equal(c.home_ok.status, 'fail'); assert.equal(c.no_js_content.status, 'fail');
  assert.match(c.no_challenge.detail, /home, robots\.txt, llms\.txt/);
  assert.ok(r.score < 20); assert.ok(r.warnings.some((w) => /bot challenge/.test(w)));
});

test('FAIL-CLOSED: sources that time out, error, 429 or 5xx are unknown, score 0, listed in sources_failed, low confidence', async () => {
  const r = await run('flaky-site.com');
  const c = byId(r);
  for (const id of ['robots_txt', 'robots_agents', 'robots_search', 'llms_txt', 'llms_full', 'sitemap', 'openapi', 'mcp', 'agent_card', 'x402']) {
    assert.equal(c[id].status, 'unknown', id); assert.equal(c[id].points, 0, id);
  }
  for (const s of ['robots.txt', 'llms.txt', 'llms-full.txt', 'sitemap']) assert.ok(r.sources_failed.includes(s), s);
  assert.equal(r.confidence, 'low');
  assert.ok(r.warnings[0].startsWith('checks_incomplete'));
  assert.ok(r.score <= 60, 'unknown never counts as a pass');
  assert.ok(!r.fixes.some((f) => c[f.check].status === 'unknown'), 'no fix advice for checks we could not run');
});

test('unreachable page: AuditIncomplete (503 checks_incomplete upstream) for network errors, 5xx and redirect loops', async () => {
  for (const u of ['down-site.com', 'error-site.com', 'redirect-loop.com', 'not-in-mock-site.com']) {
    await assert.rejects(run(u), (e) => e instanceof AuditIncomplete && e.status === 503 && e.code === 'checks_incomplete' && e.sources_failed.includes('home'), u);
  }
});

test('SSRF: private DNS answers, NXDOMAIN, redirects to metadata IPs are refused (422); DNS outage is incomplete', async () => {
  await assert.rejects(run('private-site.com'), (e) => e instanceof InputError && e.status === 422 && e.code === 'ssrf_blocked');
  await assert.rejects(run('rebind-site.com'), (e) => e instanceof InputError && e.code === 'ssrf_blocked');
  await assert.rejects(run('nx-site.com'), (e) => e instanceof InputError && e.status === 422 && e.code === 'not_found');
  await assert.rejects(run('redirect-private.com'), (e) => e instanceof InputError && e.status === 422 && e.code === 'ssrf_blocked');
  await assert.rejects(run('dnsdown-site.com'), (e) => e instanceof AuditIncomplete);
});

test('SSRF: URL shape checks reject schemes, ports, credentials, private IPs and internal names', () => {
  for (const u of ['ftp://x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://foo.internal/', 'http://printer.local/', 'http://intranet/', 'https://a.com:8443/', 'https://u:p@a.com/', 'https://a b.com', 'x'.repeat(3000)]) {
    assert.throws(() => normalizeTarget(u), InputError, u);
  }
  assert.equal(normalizeTarget('Example.COM').href, 'https://example.com/');
  assert.equal(normalizeTarget('https://stripe.com/docs#x').href, 'https://stripe.com/docs');
  assert.equal(normalizeTarget('http://1.1.1.1/').hostname, '1.1.1.1');
  for (const ip of ['10.1.1.1', '172.31.0.1', '192.168.0.1', '127.0.0.53', '0.0.0.0', '169.254.1.1', 'fd00::1', 'fe80::1', '::1', '::ffff:10.0.0.1', '64:ff9b::a00:1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(!isPrivateIp(ip), ip);
});

test('safe fetcher: honest user agent on every request, manual redirects, body cap, timeout', async () => {
  const web = mockWeb();
  await run('good-site.com', web);
  const siteCalls = web.calls.filter((c) => !/dns/.test(c.url));
  assert.ok(siteCalls.length >= 15 && siteCalls.length <= 30, String(siteCalls.length));
  assert.ok(siteCalls.every((c) => c.headers['user-agent'] === USER_AGENT)); assert.match(USER_AGENT, /^AgentReadyBot\/0\.1 \(\+https:\/\/api\.youraitools\.co\/agentready/);
  const big = await run('big-site.com');
  assert.ok(byId(big).speed.evidence.bytes <= 1024 * 1024);
  const f = createSafeFetcher({ fetchImpl: mockWeb().fetchImpl, skipDns: true });
  await assert.rejects(f.get('https://flaky-site.com/robots.txt', { timeoutMs: 50 }), (e) => e instanceof FetchFailure && e.kind === 'timeout');
  const r = await f.get('https://good-site.com/robots.txt', { maxBytes: 10 }); assert.equal(r.bytes, 10); assert.equal(r.truncated, true);
});

test('robots.txt: RFC 9309 groups, most specific agent wins, longest rule wins, wildcards, Content-Signal', () => {
  const p = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok$\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /*.pdf$\nContent-Signal: search=yes, ai-train=no\nSitemap: https://a.com/s.xml');
  assert.equal(isAllowed(p, 'GPTBot', '/'), false); assert.equal(isAllowed(p, 'ccbot', '/x'), false);
  assert.equal(isAllowed(p, 'ChatGPT-User', '/'), true); assert.equal(isAllowed(p, 'ChatGPT-User', '/private/x'), false); assert.equal(isAllowed(p, 'ChatGPT-User', '/private/ok'), true);
  assert.equal(isAllowed(p, 'ClaudeBot', '/a.pdf'), false); assert.equal(isAllowed(p, 'ClaudeBot', '/private'), true, 'own group replaces *');
  assert.deepEqual(p.sitemaps, ['https://a.com/s.xml']); assert.deepEqual(contentSignals(p), { search: 'yes', 'ai-train': 'no' });
  const m = botMatrix(p); assert.equal(m.GPTBot.status, 'blocked'); assert.equal(m.ClaudeBot.status, 'partial'); assert.equal(m['Claude-User'].status, 'partial');
  assert.equal(isAllowed(parseRobots(''), 'GPTBot', '/'), true); assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), 'GPTBot', '/'), true);
});

test('llms.txt validation and challenge detection', () => {
  assert.equal(validateLlmsTxt('# Site\n\n> Sum\n\n## Docs\n- [A](https://a.com/a): x').valid, true);
  const v = validateLlmsTxt('Some text\n# Late title\nno links'); assert.equal(v.valid, false); assert.ok(v.issues.length >= 2);
  assert.ok(isChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' }, text: '' }));
  assert.ok(isChallenge({ status: 429, headers: {}, text: '<title>Vercel Security Checkpoint</title>' }));
  assert.ok(!isChallenge({ status: 404, headers: {}, text: 'Not found' }));
});
