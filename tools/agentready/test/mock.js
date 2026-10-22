// Offline website + DNS-over-HTTPS mock for engine and app tests. Each site is a map of path -> response spec.
// Spec: { status, headers, body } | 'timeout' | 'neterr' | (init) => Response
const r = (body, status = 200, headers = {}) => ({ status, headers, body });
const WORDS = Array.from({ length: 260 }, (_, i) => ['agents', 'read', 'this', 'page', 'about', 'widgets', 'pricing', 'docs', 'api', 'guide'][i % 10]).join(' ');
export const GOOD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Good Widgets: widget API and docs</title>
<meta name="description" content="Good Widgets sells widgets through a simple API with full docs, pricing and support for agents.">
<link rel="canonical" href="https://good-site.com/"><meta property="og:title" content="Good Widgets"><meta property="og:description" content="Widgets for agents"><meta property="og:image" content="https://good-site.com/og.png">
<link rel="alternate" type="text/markdown" href="/index.md">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Good Widgets","url":"https://good-site.com/"}</script></head>
<body><header><nav><a href="/docs">Docs</a> <a href="/pricing">Pricing</a> <a href="/blog/hello-world">Blog</a></nav></header><main><h1>Good Widgets</h1><h2>Why</h2><p>${WORDS}</p><img src="/a.png" alt="A widget"><form><label for="q">Search</label><input id="q" name="q"><button>Go</button></form></main><footer>Footer</footer></body></html>`;
export const SPA_HTML = '<!doctype html><html><head><title>App</title><script src="/bundle.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
const CHALLENGE = r('<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>', 403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html', server: 'cloudflare' });
const html = (b, h = {}) => r(b, 200, { 'content-type': 'text/html; charset=utf-8', ...h });
const NOTFOUND = r('<html><body>Not found</body></html>', 404, { 'content-type': 'text/html' });

export const SITES = {
  'good-site.com': {
    '/': (init) => (/text\/markdown/.test(init?.headers?.accept || '') ? r(`# Good Widgets\n\n${WORDS}`, 200, { 'content-type': 'text/markdown; charset=utf-8' }) : html(GOOD_HTML, { 'strict-transport-security': 'max-age=31536000' })),
    'http:/': r('', 301, { location: 'https://good-site.com/' }),
    '/robots.txt': r('User-agent: *\nAllow: /\nDisallow:\n\nSitemap: https://good-site.com/sitemap.xml\n', 200, { 'content-type': 'text/plain' }),
    '/llms.txt': r('# Good Widgets\n\n> Widgets via API.\n\n## Docs\n\n- [API](https://good-site.com/docs): API reference\n- [Pricing](https://good-site.com/pricing): plans\n', 200, { 'content-type': 'text/plain' }),
    '/llms-full.txt': r(`# Good Widgets full docs\n\n${WORDS}`, 200, { 'content-type': 'text/markdown' }),
    '/sitemap.xml': r('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://good-site.com/</loc><lastmod>2026-10-01</lastmod></url><url><loc>https://good-site.com/docs</loc></url></urlset>', 200, { 'content-type': 'application/xml' }),
    '/openapi.json': r(JSON.stringify({ openapi: '3.1.0', info: { title: 'Good Widgets API', version: '1' }, paths: { '/widgets': { get: {} } } }), 200, { 'content-type': 'application/json' }),
    '/.well-known/mcp.json': r(JSON.stringify({ name: 'good', endpoint: 'https://good-site.com/mcp' }), 200, { 'content-type': 'application/json' }),
    '/mcp': (init) => (init?.method === 'POST' ? r(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'good-mcp', version: '1.0.0' }, capabilities: {} } }), 200, { 'content-type': 'application/json' }) : r('', 405)),
    '/.well-known/agent-card.json': r(JSON.stringify({ name: 'Good agent', url: 'https://good-site.com/' }), 200, { 'content-type': 'application/json' }),
    '/.well-known/x402': r(JSON.stringify({ version: 1, resources: ['https://good-site.com/api/paid'] }), 200, { 'content-type': 'application/json' }),
  },
  'poor-site.com': {
    '/': html(SPA_HTML),
    'http:/': html(SPA_HTML),
    '/robots.txt': r('User-agent: GPTBot\nUser-agent: ChatGPT-User\nUser-agent: ClaudeBot\nUser-agent: Claude-User\nUser-agent: PerplexityBot\nUser-agent: Perplexity-User\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', 200, { 'content-type': 'text/plain' }),
    '/llms.txt': html('<html><body>Home</body></html>'), // soft 404
  },
  'challenge-site.com': { '/': CHALLENGE, '/robots.txt': CHALLENGE, '/llms.txt': CHALLENGE },
  'flaky-site.com': {
    '/': html(GOOD_HTML.replace(/good-site\.com/g, 'flaky-site.com')),
    '/robots.txt': 'timeout', '/llms.txt': 'neterr', '/llms-full.txt': r('busy', 503), '/sitemap.xml': r('slow down', 429),
    '/openapi.json': 'neterr', '/.well-known/openapi.json': 'neterr', '/.well-known/mcp.json': 'neterr', '/.well-known/mcp/server-card.json': 'neterr', '/mcp': 'neterr',
    '/.well-known/agent-card.json': 'neterr', '/.well-known/agent.json': 'neterr', '/.well-known/agents.json': 'neterr', '/.well-known/ai-plugin.json': 'neterr', '/.well-known/x402': 'neterr', 'http:/': 'neterr',
  },
  'down-site.com': { '/': 'neterr' },
  'error-site.com': { '/': r('oops', 502) },
  'redirect-private.com': { '/': r('', 302, { location: 'http://169.254.169.254/latest/meta-data/' }) },
  'redirect-loop.com': { '/': r('', 302, { location: '/a' }), '/a': r('', 302, { location: '/b' }), '/b': r('', 302, { location: '/' }) },
  'big-site.com': { '/': html(`<html lang="en"><head><title>Big page with lots of text</title></head><body><main><h1>Big</h1><p>${'word '.repeat(400000)}</p></main></body></html>`) },
};
export const DNS = { 'private-site.com': { A: ['10.0.0.5'] }, 'rebind-site.com': { A: ['8.8.8.8', '127.0.0.1'] }, 'nx-site.com': 'nx', 'dnsdown-site.com': 'down' };

export function mockWeb({ sites = SITES, dns = DNS, delayMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, method: init.method || 'GET', headers: init.headers || {} });
    if (u.host === 'cloudflare-dns.com' || u.host === 'dns.google') {
      const name = u.searchParams.get('name'); const type = u.searchParams.get('type'); const d = dns[name];
      if (d === 'down') return new Response('err', { status: 502 });
      if (d === 'nx') return Response.json({ Status: 3 });
      const ips = d?.[type] ?? (type === 'A' ? ['93.184.215.14'] : []);
      return Response.json({ Status: 0, Answer: ips.map((ip) => ({ type: type === 'A' ? 1 : 28, data: ip })) });
    }
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    const site = sites[u.host];
    if (!site) throw new TypeError('getaddrinfo ENOTFOUND (mock)');
    let spec = u.protocol === 'http:' ? site[`http:${u.pathname}`] : site[u.pathname];
    if (spec === undefined) spec = NOTFOUND;
    if (typeof spec === 'function') spec = spec(init);
    if (spec === 'timeout') return new Promise((_, rej) => { init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
    if (spec === 'neterr') throw new TypeError('network error (mock)');
    return new Response(spec.body ?? '', { status: spec.status ?? 200, headers: spec.headers || {} });
  };
  return { calls, fetchImpl };
}
