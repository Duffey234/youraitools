// Read a URL into clean Markdown: SSRF-safe fetch, robots.txt check, HTML -> Markdown.
import { safeFetch, checkUrl, FetchError } from './safefetch.js';
import { parseRobots, isAllowed } from './robots.js';
import { htmlToMarkdown, wordCount } from './html2md.js';
import { DEFAULTS, USER_AGENT, ROBOTS_TOKEN } from './config.js';

export { FetchError };

export class Reader {
  constructor({ fetchImpl, dns = true, limits = {}, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl; this.dns = dns; this.now = now;
    this.limits = { ...DEFAULTS, ...limits };
    this.robots = new Map(); // origin -> { exp, groups|null, deny:boolean }
  }

  async robotsFor(url) {
    const origin = url.origin;
    const hit = this.robots.get(origin);
    if (hit && hit.exp > this.now()) return hit;
    let entry;
    try {
      const r = await safeFetch(`${origin}/robots.txt`, { fetchImpl: this.fetchImpl, dns: this.dns, userAgent: USER_AGENT, maxBytes: 500_000, timeoutMs: 4000, blockedHosts: this.limits.blockedHosts, accept: 'text/plain,*/*;q=0.1' });
      if (r.status >= 200 && r.status < 300) entry = { groups: parseRobots(r.text), deny: false };
      else if (r.status >= 400 && r.status < 500) entry = { groups: [], deny: false };      // RFC 9309: unavailable -> allowed
      else entry = { groups: null, deny: true };                                           // 5xx: unreachable -> disallow
    } catch (e) {
      if (e instanceof FetchError && e.status === 400) throw e;                           // blocked host etc.
      entry = { groups: null, deny: true };
    }
    entry.exp = this.now() + 10 * 60 * 1000;
    if (this.robots.size > 500) this.robots.clear();
    this.robots.set(origin, entry);
    return entry;
  }

  async assertAllowed(url) {
    const r = await this.robotsFor(url);
    if (r.deny) throw new FetchError('robots_unavailable', `${url.origin}/robots.txt could not be fetched (server error or timeout), so the site is treated as disallowed`, 403);
    if (!isAllowed(r.groups, ROBOTS_TOKEN, url.pathname + url.search)) throw new FetchError('robots_disallowed', `robots.txt at ${url.origin} disallows this path for ${ROBOTS_TOKEN}`, 403);
  }

  /** @returns {Promise<object>} full read result */
  async read(input, { maxChars = 200000, includeRaw = false } = {}) {
    const L = this.limits;
    checkUrl(input, { blockedHosts: L.blockedHosts });
    const res = await safeFetch(input, {
      fetchImpl: this.fetchImpl, dns: this.dns, userAgent: USER_AGENT, maxBytes: L.maxBytes, timeoutMs: L.timeoutMs, blockedHosts: L.blockedHosts,
      beforeRequest: (u) => this.assertAllowed(u), // every hop, including redirects
    });
    if (res.status >= 400) throw new FetchError('upstream_status', `the page answered HTTP ${res.status}`, 502);
    const ct = res.contentType.toLowerCase();
    let out; let raw = null;
    if (/text\/html|application\/xhtml\+xml/.test(ct) || (!ct && /^\s*<(!doctype|html)/i.test(res.text))) {
      const html = res.text.length > L.maxHtmlChars ? res.text.slice(0, L.maxHtmlChars) : res.text;
      if (includeRaw) raw = html;
      out = htmlToMarkdown(html, { baseUrl: res.finalUrl, maxChars });
      if (res.text.length > L.maxHtmlChars) out.truncated = true;
    } else if (/text\/plain|text\/markdown|text\/x-markdown/.test(ct)) {
      const s = res.text.trim();
      out = { markdown: s.slice(0, maxChars), title: null, description: null, lang: null, canonical: null, links: 0, truncated: s.length > maxChars };
    } else {
      throw new FetchError('unsupported_content_type', `content type "${res.contentType || 'unknown'}" is not HTML or text`, 415);
    }
    return {
      url: res.url, finalUrl: res.finalUrl, status: res.status, contentType: res.contentType,
      title: out.title, description: out.description, lang: out.lang, canonical: out.canonical,
      markdown: out.markdown, chars: out.markdown.length, wordCount: wordCount(out.markdown), links: out.links,
      truncated: out.truncated || res.truncated, sourceBytes: res.bytes, redirects: res.redirects, fetchMs: res.ms,
      robots: 'allowed', fetchedAt: new Date(this.now()).toISOString(),
      ...(includeRaw ? { raw } : {}),
    };
  }
}
