// robots.txt parsing and matching (RFC 9309): groups by user-agent product token, most specific group wins
// (else "*"), longest matching rule wins, Allow wins ties, "*" and "$" wildcards. Also reads Sitemap: lines and
// Cloudflare-style Content-Signal: lines (search / ai-input / ai-train).

// AI crawlers and agents we report on. kind: "agent" = fetches a page because a user asked (most important for agents),
// "search" = AI search / answer engine index, "training" = model-training crawler (blocking these is a policy choice).
export const AI_BOTS = [
  { ua: 'ChatGPT-User', owner: 'OpenAI', kind: 'agent' },
  { ua: 'OAI-SearchBot', owner: 'OpenAI', kind: 'search' },
  { ua: 'GPTBot', owner: 'OpenAI', kind: 'training' },
  { ua: 'Claude-User', owner: 'Anthropic', kind: 'agent' },
  { ua: 'Claude-SearchBot', owner: 'Anthropic', kind: 'search' },
  { ua: 'ClaudeBot', owner: 'Anthropic', kind: 'training' },
  { ua: 'Perplexity-User', owner: 'Perplexity', kind: 'agent' },
  { ua: 'PerplexityBot', owner: 'Perplexity', kind: 'search' },
  { ua: 'Google-Extended', owner: 'Google', kind: 'training' },
  { ua: 'Applebot-Extended', owner: 'Apple', kind: 'training' },
  { ua: 'MistralAI-User', owner: 'Mistral', kind: 'agent' },
  { ua: 'DuckAssistBot', owner: 'DuckDuckGo', kind: 'search' },
  { ua: 'Amazonbot', owner: 'Amazon', kind: 'search' },
  { ua: 'Meta-ExternalAgent', owner: 'Meta', kind: 'training' },
  { ua: 'CCBot', owner: 'Common Crawl', kind: 'training' },
  { ua: 'Bytespider', owner: 'ByteDance', kind: 'training' },
  { ua: 'cohere-ai', owner: 'Cohere', kind: 'training' },
];

export function parseRobots(text) {
  const groups = []; const sitemaps = []; const signals = [];
  let cur = null; let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/).slice(0, 5000)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'content-signal') { signals.push(val); if (cur) cur.signal = val; continue; }
    if ((key === 'allow' || key === 'disallow') && cur) cur.rules.push({ allow: key === 'allow', path: val });
  }
  return { groups, sitemaps, signals };
}

function ruleMatches(pattern, path) {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/** The group that applies to a user agent: exact product-token match (case-insensitive), else "*", else null. */
export function groupFor(parsed, ua) {
  const t = ua.toLowerCase();
  const own = parsed.groups.filter((g) => g.agents.includes(t));
  if (own.length) return { agents: own.flatMap((g) => g.agents), rules: own.flatMap((g) => g.rules), signal: own.find((g) => g.signal)?.signal, specific: true };
  const star = parsed.groups.filter((g) => g.agents.includes('*'));
  if (star.length) return { agents: ['*'], rules: star.flatMap((g) => g.rules), signal: star.find((g) => g.signal)?.signal, specific: false };
  return null;
}

/** Is `path` allowed for `ua`? */
export function isAllowed(parsed, ua, path = '/') {
  const g = groupFor(parsed, ua);
  if (!g) return true;
  let best = null;
  for (const r of g.rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** Per-bot status for the home path and the site root: allowed / blocked / partial (root allowed, page blocked or vice versa). */
export function botMatrix(parsed, path = '/') {
  const out = {};
  for (const b of AI_BOTS) {
    const root = isAllowed(parsed, b.ua, '/'); const page = path === '/' ? root : isAllowed(parsed, b.ua, path);
    const g = groupFor(parsed, b.ua);
    const anyDisallow = g?.rules.some((r) => !r.allow && r.path && r.path !== '/') || false;
    out[b.ua] = { owner: b.owner, kind: b.kind, status: !root && !page ? 'blocked' : root && page ? (anyDisallow ? 'partial' : 'allowed') : 'partial', rule_group: g ? (g.specific ? b.ua : '*') : 'none' };
  }
  return out;
}

/** Content-Signal values as an object, e.g. { search: 'yes', 'ai-input': 'yes', 'ai-train': 'no' }. */
export function contentSignals(parsed) {
  const out = {};
  for (const s of parsed.signals) for (const part of s.split(',')) { const [k, v] = part.split('=').map((x) => x && x.trim().toLowerCase()); if (k && v) out[k] = v; }
  return out;
}
