// AgentReady engine: is this website ready for AI agents?
// Fetches a bounded set of public URLs (SSRF-safe, honest user agent, tight timeouts), runs 23 weighted checks in 5
// categories and returns a 0-100 score, a grade, prioritized fixes and ready-to-paste snippets.
// FAIL-CLOSED: a source that errors, times out, rate-limits (429) or answers 5xx makes its checks "unknown" (0 points,
// listed in sources_failed, confidence lowered). Unknown never counts as a pass. If the page itself can't be fetched,
// the audit throws AuditIncomplete (paid routes answer 503 checks_incomplete and are not charged).
import { createSafeFetcher, normalizeTarget, InputError, FetchFailure, USER_AGENT } from './net.js';
import { parseRobots, botMatrix, contentSignals, AI_BOTS } from './robots.js';
import { extract } from './html.js';

export { InputError, normalizeTarget, USER_AGENT };
export const ENGINE_VERSION = 'agentready-0.1';
export const DISCLAIMER = 'Automated checks of public URLs at the time of the audit, from a Cloudflare edge with an honest AgentReadyBot user agent. Informational; no guarantee that any specific AI product will crawl, cite or use the site.';
export const LIMITS = [
  'Raw HTML only: content that needs JavaScript to render is reported as missing for agents (that is what most agents and AI crawlers see).',
  'Bot-challenge detection uses our own honest agent user agent (no spoofing of GPTBot, ClaudeBot etc.); vendors whitelisted by IP may be treated differently.',
  'robots.txt rules are evaluated per RFC 9309 for the audited path and the site root.',
  'At most ~20 requests per audit, 5 s each (page 7 s), bodies capped at 512 KB (page HTML 1 MB, first 600 KB parsed).',
  'Response time is measured once from a Cloudflare edge location, not from every region.',
];
export class AuditIncomplete extends Error {
  constructor(message, sourcesFailed, provisional) { super(message); this.status = 503; this.code = 'checks_incomplete'; this.sources_failed = sourcesFailed; this.provisional = provisional; }
}

export const CATEGORIES = { access: 'Agent access', content: 'Content agents can read', discovery: 'Discovery and metadata', interfaces: 'Agent interfaces (APIs, MCP, payments)', performance: 'Speed and HTTPS' };
export const WEIGHTS = {
  home_ok: ['access', 6], no_challenge: ['access', 6], robots_agents: ['access', 8], robots_search: ['access', 5], no_noai: ['access', 3], robots_txt: ['access', 2],
  no_js_content: ['content', 10], markdown: ['content', 5], title_description: ['content', 4], semantic_html: ['content', 3], accessibility: ['content', 3],
  llms_txt: ['discovery', 8], llms_full: ['discovery', 2], sitemap: ['discovery', 5], structured_data: ['discovery', 5], meta_social: ['discovery', 5],
  openapi: ['interfaces', 3], mcp: ['interfaces', 4], agent_card: ['interfaces', 3], x402: ['interfaces', 2],
  https: ['performance', 3], https_redirect_hsts: ['performance', 2], speed: ['performance', 3],
};
const CHALLENGE_RE = /cf-chl|challenge-platform|<title>\s*just a moment|attention required! \| cloudflare|px-captcha|captcha-delivery|datadome|_incapsula_|incapsula incident|sgcaptcha|verify (that )?you are (a )?human|security checkpoint|ddos-guard|access denied[\s\S]{0,200}(akamai|reference #)|are you a robot|bot detection/i;

/** Classify a fetch outcome. Returns { kind: ok|missing|blocked|failed, r?, reason } */
function outcome(res) {
  if (res.error) return { kind: 'failed', reason: res.error };
  const r = res.r;
  if (isChallenge(r)) return { kind: 'blocked', r, reason: `bot challenge (HTTP ${r.status})` };
  if (r.status === 429 || r.status >= 500) return { kind: 'failed', r, reason: `HTTP ${r.status}` };
  if (r.ok) return { kind: 'ok', r };
  return { kind: 'missing', r, reason: `HTTP ${r.status}` };
}
export function isChallenge(r) {
  if (!r) return false;
  if ((r.headers['cf-mitigated'] || '').toLowerCase() === 'challenge') return true;
  if ([401, 403, 429, 503].includes(r.status) && CHALLENGE_RE.test(r.text.slice(0, 20000))) return true;
  if (r.ok && r.text.length < 20000 && /<title>\s*just a moment|challenge-platform\/h\/[bg]\/orchestrate|vercel security checkpoint/i.test(r.text)) return true;
  return false;
}
const looksHtml = (r) => /text\/html|application\/xhtml/i.test(r.headers['content-type'] || '') || /^\s*(<!doctype html|<html|<head|<body)/i.test(r.text.slice(0, 300));
const asJson = (r) => { if (!r || looksHtml(r)) return null; try { const j = JSON.parse(r.text); return j && typeof j === 'object' ? j : null; } catch { return null; } };

export function validateLlmsTxt(text) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  const lines = t.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  const links = (t.match(/^\s*[-*]\s*\[[^\]]+\]\([^)\s]+\)/gm) || []).length;
  const h2 = lines.filter((l) => /^##\s+\S/.test(l)).length;
  const summary = lines.some((l) => /^>\s*\S/.test(l));
  const issues = []; const notes = [];
  if (!h1) issues.push('no H1 title line ("# Site name")');
  else if (!/^#\s/.test(lines.find((l) => l.trim()) || '')) issues.push('the H1 title should be the first line');
  if (!links) issues.push('no "- [name](url): notes" link lists');
  if (!summary) notes.push('optional "> summary" blockquote missing');
  if (!h2) notes.push('no "## Section" headings');
  return { valid: !!h1 && links > 0, h1: h1 ? h1.replace(/^#\s+/, '').trim().slice(0, 120) : null, sections: h2, links, summary, bytes: t.length, issues, notes };
}

/** Run the audit. opts: fetchImpl, now (ms), skipDns (tests only) */
export async function auditSite(rawUrl, opts = {}) {
  const target = rawUrl instanceof URL ? rawUrl : normalizeTarget(rawUrl);
  const f = createSafeFetcher({ fetchImpl: opts.fetchImpl || ((...a) => globalThis.fetch(...a)), skipDns: opts.skipDns, maxRequests: 30 });
  const grab = (url, o) => f.get(url, o).then((r) => ({ r }), (e) => { if (e instanceof InputError) throw e; return { error: e instanceof FetchFailure ? `${e.kind}: ${e.message}` : String(e?.message || e), kind: e?.kind }; });
  const checkedAt = new Date(opts.now || Date.now()).toISOString();

  // 1) The page itself (critical)
  const home = await grab(target.href, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', maxBytes: 1024 * 1024, timeoutMs: 7000 });
  const ho = outcome(home);
  if (home.kind === 'ssrf') throw new InputError(`The page redirects to a blocked address (${home.error})`, 422, 'ssrf_blocked');
  if (ho.kind === 'failed') throw new AuditIncomplete(`The page could not be fetched (${ho.reason}). Not charged; retry later.`, ['home'], null);
  const final = new URL(ho.r.url);
  const origin = final.origin;
  const at = (p) => `${origin}${p}`;
  const path = final.pathname || '/';

  // 2) Everything else in parallel
  const [robots, llms, llmsFull, md, oa1, oa2, mcpJson, mcpCard, a2a, agentJson, agentsJson, plugin, x402, http] = await Promise.all([
    grab(at('/robots.txt'), { accept: 'text/plain,*/*;q=0.5' }),
    grab(at('/llms.txt'), { accept: 'text/plain,text/markdown,*/*;q=0.5' }),
    grab(at('/llms-full.txt'), { accept: 'text/plain,text/markdown,*/*;q=0.5', method: 'GET', maxBytes: 64 * 1024 }),
    grab(final.href, { accept: 'text/markdown, text/x-markdown;q=0.9, text/plain;q=0.5', maxBytes: 256 * 1024 }),
    grab(at('/openapi.json'), { accept: 'application/json' }),
    grab(at('/.well-known/openapi.json'), { accept: 'application/json' }),
    grab(at('/.well-known/mcp.json'), { accept: 'application/json' }),
    grab(at('/.well-known/mcp/server-card.json'), { accept: 'application/json' }),
    grab(at('/.well-known/agent-card.json'), { accept: 'application/json' }),
    grab(at('/.well-known/agent.json'), { accept: 'application/json' }),
    grab(at('/.well-known/agents.json'), { accept: 'application/json' }),
    grab(at('/.well-known/ai-plugin.json'), { accept: 'application/json' }),
    grab(at('/.well-known/x402'), { accept: 'application/json' }),
    final.protocol === 'https:' ? grab(`http://${final.host}${path}`, { follow: false, accept: 'text/html', maxBytes: 4096, timeoutMs: 4000 }) : Promise.resolve(null),
  ]);
  const ro = outcome(robots);
  const parsedRobots = ro.kind === 'ok' && !looksHtml(ro.r) ? parseRobots(ro.r.text) : parseRobots('');
  // sitemap: robots Sitemap: lines first (same host only), else /sitemap.xml
  const smUrl = parsedRobots.sitemaps.map((s) => { try { return new URL(s, origin); } catch { return null; } }).find((u) => u && u.host === final.host)?.href || at('/sitemap.xml');
  const page = ho.kind === 'ok' ? extract(ho.r.text, final.href) : null;
  const mcpDecl = asJson(outcome(mcpJson).r) || asJson(outcome(mcpCard).r);
  const mcpUrl = (() => { const c = mcpDecl && (mcpDecl.endpoint || mcpDecl.url || mcpDecl.remotes?.[0]?.url || mcpDecl.servers?.[0]?.url || mcpDecl.servers?.[0]?.remotes?.[0]?.url || Object.values(mcpDecl.mcpServers || {})[0]?.url); try { return c ? new URL(c, origin).href : at('/mcp'); } catch { return at('/mcp'); } })();
  const [sitemap, mcpLive] = await Promise.all([
    grab(smUrl, { accept: 'application/xml,text/xml,*/*;q=0.5', maxBytes: 512 * 1024 }),
    grab(mcpUrl, { method: 'POST', accept: 'application/json, text/event-stream', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentready-audit', version: '0.1' } } }), maxBytes: 64 * 1024, timeoutMs: 5000 }),
  ]);

  const failed = new Set();
  const checks = [];
  const add = (id, status, earned, detail, evidence) => {
    const [category, max] = WEIGHTS[id];
    const points = status === 'unknown' ? 0 : Math.max(0, Math.min(max, earned));
    checks.push({ id, category, status, points, max, detail, ...(evidence ? { evidence } : {}) });
  };
  const unknown = (id, src, why) => { failed.add(src); add(id, 'unknown', 0, `Not checked: ${src} could not be fetched (${why}). Counted as 0 points (fail-closed).`); };
  const blockedNote = ho.kind === 'blocked' ? 'Agents get a bot-challenge page instead of your content.' : null;

  // ---- ACCESS ----
  if (ho.kind === 'ok') add('home_ok', 'pass', 6, `HTTP ${ho.r.status}${ho.r.redirects.length ? ` after ${ho.r.redirects.length} redirect(s)` : ''}.`, { status: ho.r.status, final_url: final.href, redirects: ho.r.redirects });
  else add('home_ok', 'fail', 0, `The page answered ${ho.reason} to an AI agent.`, { status: ho.r.status, final_url: final.href });
  const challenged = [['home', home], ['robots.txt', robots], ['llms.txt', llms]].filter(([, x]) => isChallenge(x?.r)).map(([n]) => n);
  if (challenged.length) add('no_challenge', 'fail', 0, `Bot challenge / WAF block for an AI-agent user agent on: ${challenged.join(', ')}. Agents cannot pass interactive challenges.`, { challenged, server: ho.r.headers.server || null, cf_mitigated: ho.r.headers['cf-mitigated'] || null });
  else add('no_challenge', 'pass', 6, 'No bot challenge or WAF block for an AI-agent user agent.');

  let matrix = null;
  if (ro.kind === 'failed') { unknown('robots_txt', 'robots.txt', ro.reason); unknown('robots_agents', 'robots.txt', ro.reason); unknown('robots_search', 'robots.txt', ro.reason); }
  else {
    if (ro.kind === 'blocked') add('robots_txt', 'fail', 0, 'robots.txt is behind a bot challenge.');
    else if (ro.kind === 'missing') add('robots_txt', ro.r.status === 404 || ro.r.status === 410 ? 'warn' : 'fail', ro.r.status === 404 || ro.r.status === 410 ? 1 : 0, `No robots.txt (${ro.reason}): everything is allowed by default, but there is no Sitemap: line or explicit AI-agent policy.`);
    else if (looksHtml(ro.r)) add('robots_txt', 'warn', 1, 'robots.txt returns an HTML page (soft 404): treated as "allow all".');
    else add('robots_txt', 'pass', 2, `robots.txt found: ${parsedRobots.groups.length} group(s), ${parsedRobots.sitemaps.length} Sitemap line(s).`);
    const robotsUsable = ro.kind !== 'blocked';
    matrix = robotsUsable ? botMatrix(parsedRobots, path) : null;
    const byKind = (k) => AI_BOTS.filter((b) => b.kind === k).map((b) => [b.ua, matrix?.[b.ua]?.status]);
    const score = (k, max, id, label) => {
      if (!matrix) return add(id, 'fail', 0, 'robots.txt is behind a bot challenge, so AI bots cannot read your rules.');
      const rows = byKind(k); const blocked = rows.filter(([, s]) => s === 'blocked').map(([u]) => u); const partial = rows.filter(([, s]) => s === 'partial').map(([u]) => u);
      const frac = (rows.length - blocked.length - partial.length * 0.25) / rows.length;
      const st = blocked.length === 0 ? 'pass' : blocked.length === rows.length ? 'fail' : 'warn';
      add(id, st, Math.round(max * frac * 2) / 2, blocked.length ? `${label} blocked by robots.txt: ${blocked.join(', ')}.${partial.length ? ` Partly restricted: ${partial.join(', ')}.` : ''}` : `All ${label} are allowed${partial.length ? ` (some paths restricted for ${partial.join(', ')})` : ''}.`, { bots: Object.fromEntries(rows) });
    };
    score('agent', 8, 'robots_agents', 'user-triggered AI agents (ChatGPT-User, Claude-User, Perplexity-User, MistralAI-User)');
    score('search', 5, 'robots_search', 'AI search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot, DuckAssistBot, Amazonbot)');
  }
  const signals = contentSignals(parsedRobots);
  {
    const xr = (ho.r.headers['x-robots-tag'] || '').toLowerCase();
    const metaBad = (page?.robotsMeta || []).filter((m) => /noindex|noai|noimageai|none/i.test(m));
    const bad = [...(/(noindex|noai|none)\b/.test(xr) ? [`X-Robots-Tag: ${xr}`] : []), ...metaBad, ...(signals['ai-input'] === 'no' ? ['Content-Signal ai-input=no'] : [])];
    if (bad.length) add('no_noai', 'fail', 0, `Opt-out signals tell AI systems not to use this page: ${bad.join('; ')}.`, { signals: bad });
    else add('no_noai', 'pass', 3, `No noindex / noai opt-out.${Object.keys(signals).length ? ` Content-Signal: ${Object.entries(signals).map(([k, v]) => `${k}=${v}`).join(', ')}.` : ''}`);
  }

  // ---- CONTENT ----
  if (!page) {
    for (const id of ['no_js_content', 'title_description', 'semantic_html', 'accessibility']) add(id, 'fail', 0, blockedNote || `No readable HTML (${ho.reason}).`);
  } else {
    const w = page.text.words;
    if (page.text.spaShell || page.text.needsJs || w < 50) add('no_js_content', 'fail', 0, `Only ${w} words in the raw HTML${page.text.spaShell ? ' (empty JavaScript app shell)' : ''}${page.text.needsJs ? ' ("enable JavaScript" notice)' : ''}. Agents without a browser see almost nothing.`, { words: w, scripts: page.text.scripts });
    else if (w < 150) add('no_js_content', 'warn', 5, `${w} words of text in the raw HTML; thin for agents. Server-render the main content.`, { words: w });
    else add('no_js_content', 'pass', 10, `${w} words of readable text in the raw HTML (no JavaScript needed).`, { words: w, sample: page.text.sample.slice(0, 160) });
    const tOk = !!page.title && page.title.length >= 10 && page.title.length <= 70; const dOk = !!page.description && page.description.length >= 50 && page.description.length <= 170;
    add('title_description', tOk && dOk ? 'pass' : (page.title || page.description) ? 'warn' : 'fail', (page.title ? (tOk ? 2 : 1) : 0) + (page.description ? (dOk ? 2 : 1) : 0),
      `Title: ${page.title ? `"${page.title.slice(0, 80)}" (${page.title.length} chars${tOk ? '' : '; aim for 10-70'})` : 'missing'}. Meta description: ${page.description ? `${page.description.length} chars${dOk ? '' : ' (aim for 50-160)'}` : 'missing'}.`, { title: page.title, description: page.description });
    const h1 = page.headings.h1; const semPts = (h1 === 1 ? 1 : h1 > 1 ? 0.5 : 0) + (page.landmarks.main ? 1 : 0) + (page.headings.h2 || page.landmarks.nav || page.landmarks.article ? 1 : 0);
    add('semantic_html', semPts >= 3 ? 'pass' : semPts >= 1.5 ? 'warn' : 'fail', semPts, `${h1} <h1>, ${page.headings.h2} <h2>, <main>: ${page.landmarks.main ? 'yes' : 'no'}, <nav>: ${page.landmarks.nav ? 'yes' : 'no'}, <article>: ${page.landmarks.article ? 'yes' : 'no'}.`, { headings: page.headings, landmarks: page.landmarks });
    const a = page.a11y; const altOk = !a.images || a.imagesMissingAlt / a.images <= 0.1; const lblOk = !a.unlabeledFields; const langOk = !!page.lang && !a.unnamedButtons;
    const aPts = (altOk ? 1 : 0) + (lblOk ? 1 : 0) + (langOk ? 1 : 0);
    add('accessibility', aPts === 3 ? 'pass' : aPts >= 1 ? 'warn' : 'fail', aPts, `Images without alt: ${a.imagesMissingAlt}/${a.images}. Unlabeled form fields: ${a.unlabeledFields}/${a.fields}. Buttons without a name: ${a.unnamedButtons}/${a.buttons}. <html lang>: ${page.lang || 'missing'}.`, a);
  }
  {
    const mo = outcome(md);
    const ct = (mo.r?.headers['content-type'] || '').toLowerCase();
    const negotiated = mo.kind === 'ok' && /text\/(x-)?markdown/.test(ct);
    const alt = (page?.alternates || []).find((l) => /markdown/.test(l.type));
    const llmLink = (page?.linkRels || []).find((l) => /llms/i.test(l.rel));
    if (negotiated || alt) add('markdown', 'pass', 5, negotiated ? `Markdown served on "Accept: text/markdown" (content negotiation${mo.r.headers['x-markdown-tokens'] ? `, ${mo.r.headers['x-markdown-tokens']} tokens` : ''}).` : `Markdown alternate linked: ${alt.href}.`, { negotiated, alternate: alt?.href || null });
    else if (mo.kind === 'failed' && !page) unknown('markdown', 'markdown', mo.reason);
    else add('markdown', llmLink ? 'warn' : 'fail', llmLink ? 2 : 0, `No markdown version: "Accept: text/markdown" returned ${ct || 'no content type'}${mo.kind === 'failed' ? ` (${mo.reason})` : ''} and there is no <link rel="alternate" type="text/markdown">.`);
  }

  // ---- DISCOVERY ----
  const lo = outcome(llms); let llmsInfo = null;
  if (lo.kind === 'failed') unknown('llms_txt', 'llms.txt', lo.reason);
  else if (lo.kind !== 'ok' || looksHtml(lo.r)) add('llms_txt', 'fail', 0, lo.kind === 'blocked' ? '/llms.txt is behind a bot challenge.' : `No /llms.txt (${lo.kind === 'ok' ? 'returns an HTML page (soft 404)' : lo.reason}).`);
  else {
    llmsInfo = validateLlmsTxt(lo.r.text);
    if (llmsInfo.valid && !llmsInfo.issues.length) add('llms_txt', 'pass', 8, `/llms.txt follows llmstxt.org: "${llmsInfo.h1}", ${llmsInfo.sections} section(s), ${llmsInfo.links} link(s)${llmsInfo.notes.length ? ` (${llmsInfo.notes.join('; ')})` : ''}.`, llmsInfo);
    else add('llms_txt', 'warn', llmsInfo.valid ? 6 : 3, `/llms.txt exists but: ${llmsInfo.issues.join('; ')}.`, llmsInfo);
  }
  const lf = outcome(llmsFull);
  if (lf.kind === 'failed') unknown('llms_full', 'llms-full.txt', lf.reason);
  else if (lf.kind === 'ok' && !looksHtml(lf.r) && lf.r.text.trim().length > 200) add('llms_full', 'pass', 2, `/llms-full.txt found (${lf.r.truncated ? '>64 KB' : `${Math.round(lf.r.bytes / 1024)} KB`}).`);
  else add('llms_full', 'fail', 0, 'No /llms-full.txt (the full docs in one markdown file).');
  const so = outcome(sitemap); let smInfo = null;
  if (so.kind === 'failed') unknown('sitemap', 'sitemap', so.reason);
  else if (so.kind === 'ok' && /<(urlset|sitemapindex)\b/i.test(so.r.text)) {
    const locs = [...so.r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    smInfo = { url: so.r.url, index: /<sitemapindex\b/i.test(so.r.text), urls: locs.length, lastmod: /<lastmod>/i.test(so.r.text), sample: locs.slice(0, 25), in_robots: parsedRobots.sitemaps.length > 0 };
    add('sitemap', locs.length ? (smInfo.in_robots ? 'pass' : 'warn') : 'warn', locs.length ? (smInfo.in_robots ? 5 : 4) : 2, `${smInfo.index ? 'Sitemap index' : 'Sitemap'} at ${so.r.url}: ${locs.length}${so.r.truncated ? '+' : ''} <loc> entries${smInfo.lastmod ? ', with lastmod' : ''}${smInfo.in_robots ? ', listed in robots.txt' : '; not listed in robots.txt'}.`, { ...smInfo, sample: smInfo.sample.slice(0, 5) });
  } else add('sitemap', 'fail', 0, `No XML sitemap at ${smUrl} (${so.kind === 'ok' ? 'not a sitemap' : so.reason}).`);
  if (!page) { add('structured_data', 'fail', 0, blockedNote || 'No HTML to read.'); add('meta_social', 'fail', 0, blockedNote || 'No HTML to read.'); }
  else {
    const j = page.jsonld;
    if (j.blocks && j.types.length && !j.invalid) add('structured_data', 'pass', 5, `JSON-LD: ${j.types.slice(0, 8).join(', ')}.`, j);
    else if (j.blocks && j.types.length) add('structured_data', 'warn', 3, `JSON-LD found (${j.types.slice(0, 6).join(', ')}) but ${j.invalid} block(s) are invalid JSON.`, j);
    else if (page.microdata || page.rdfa) add('structured_data', 'warn', 3, `Microdata/RDFa only (${page.microdata} itemscope, ${page.rdfa} typeof); JSON-LD is easiest for agents.`);
    else add('structured_data', 'fail', 0, `No schema.org structured data${j.invalid ? ` (${j.invalid} JSON-LD block(s) failed to parse)` : ''}.`);
    const pts = (page.canonical ? 2 : 0) + (page.og.title && page.og.description ? 2 : page.og.title || page.og.description ? 1 : 0) + (page.og.image ? 1 : 0);
    add('meta_social', pts >= 5 ? 'pass' : pts >= 2 ? 'warn' : 'fail', pts, `Canonical: ${page.canonical ? 'yes' : 'no'}. og:title/description: ${page.og.title ? 'yes' : 'no'}/${page.og.description ? 'yes' : 'no'}. og:image: ${page.og.image ? 'yes' : 'no'}. twitter:card: ${page.twitter.card || 'no'}.`, { canonical: page.canonical, og: page.og });
  }

  // ---- AGENT INTERFACES ----
  const openapiOf = (x) => { const o = outcome(x); const j = asJson(o.r); return o.kind === 'ok' && j && (j.openapi || j.swagger) ? { url: o.r.url, version: String(j.openapi || j.swagger), title: j.info?.title || null, paths: Object.keys(j.paths || {}).length, paid: JSON.stringify(j).includes('x-payment-info') || JSON.stringify(j).includes('"x-x402"'), valid: !!(j.info && j.paths && Object.keys(j.paths).length) } : null; };
  const oa = openapiOf(oa1) || openapiOf(oa2);
  const linkedApi = (page?.linkRels || []).find((l) => /service-desc|api/i.test(l.rel));
  if (oa) add('openapi', oa.valid ? 'pass' : 'warn', oa.valid ? 3 : 1, `OpenAPI ${oa.version} at ${oa.url}: ${oa.paths} path(s)${oa.title ? `, "${oa.title}"` : ''}${oa.valid ? '' : ' (missing info or paths)'}.`, oa);
  else if ([oa1, oa2].every((x) => outcome(x).kind === 'failed')) unknown('openapi', 'openapi', outcome(oa1).reason);
  else add('openapi', linkedApi ? 'warn' : 'fail', linkedApi ? 1 : 0, linkedApi ? `API description linked (${linkedApi.href}) but no OpenAPI at /openapi.json or /.well-known/openapi.json.` : 'No OpenAPI spec at /openapi.json or /.well-known/openapi.json.');
  const ml = outcome(mcpLive);
  const live = (() => { if (ml.kind !== 'ok') return null; let t = ml.r.text; const ev = /^data:\s*(\{.*\})\s*$/m.exec(t); if (ev) t = ev[1]; try { const j = JSON.parse(t); return j?.result?.serverInfo || j?.result?.protocolVersion ? { name: j.result.serverInfo?.name || null, version: j.result.serverInfo?.version || null, protocol: j.result.protocolVersion || null, url: ml.r.url } : null; } catch { return null; } })();
  const mcpPts = (mcpDecl ? 2 : 0) + (live ? 2 : 0);
  if (mcpPts) add('mcp', mcpPts === 4 ? 'pass' : 'warn', mcpPts, `${mcpDecl ? 'MCP discovery file found.' : 'No /.well-known/mcp.json or server card.'} ${live ? `Live MCP server at ${live.url} answered initialize (${live.name || 'unnamed'} ${live.version || ''}, protocol ${live.protocol || '?'}).` : `No MCP server answered initialize at ${mcpUrl}.`}`, { declared: !!mcpDecl, live });
  else if ([mcpJson, mcpCard].every((x) => outcome(x).kind === 'failed') && ml.kind === 'failed') unknown('mcp', 'mcp', ml.reason);
  else add('mcp', 'fail', 0, `No MCP server: no /.well-known/mcp.json or /.well-known/mcp/server-card.json, and ${mcpUrl} did not answer an MCP initialize.`);
  const cards = [['A2A agent card', a2a], ['agent.json', agentJson], ['agents.json', agentsJson], ['ai-plugin.json', plugin]].map(([n, x]) => { const o = outcome(x); const j = asJson(o.r); return j && o.kind === 'ok' ? { name: n, url: o.r.url, title: j.name || j.name_for_human || j.info?.title || null } : null; }).filter(Boolean);
  if (cards.length) add('agent_card', 'pass', 3, `Agent manifest(s): ${cards.map((c) => `${c.name} (${c.url})`).join(', ')}.`, { found: cards });
  else if ([a2a, agentJson, agentsJson, plugin].every((x) => outcome(x).kind === 'failed')) unknown('agent_card', 'agent manifests', outcome(a2a).reason);
  else add('agent_card', 'fail', 0, 'No agent manifest (/.well-known/agent-card.json for A2A, agent.json, agents.json or ai-plugin.json).');
  const xo = outcome(x402); const xj = asJson(xo.r);
  if (xj && xo.kind === 'ok' && (xj.resources || xj.accepts || xj.x402Version || xj.version)) add('x402', 'pass', 2, `x402 payments discoverable at /.well-known/x402${Array.isArray(xj.resources) ? ` (${xj.resources.length} paid resource(s))` : ''}.`, { resources: Array.isArray(xj.resources) ? xj.resources.slice(0, 10) : null });
  else if (oa?.paid) add('x402', 'pass', 2, 'Paid routes declared in OpenAPI (x-payment-info / x-x402).');
  else if (xo.kind === 'failed') unknown('x402', 'x402', xo.reason);
  else add('x402', 'fail', 0, 'No machine-payable endpoints (no /.well-known/x402). Optional: only needed if you sell API calls or content to agents.');

  // ---- PERFORMANCE / SECURITY ----
  if (final.protocol === 'https:') add('https', 'pass', 3, 'Served over HTTPS.'); else add('https', 'fail', 0, 'Not served over HTTPS (agents and browsers flag plain HTTP).');
  {
    const hsts = !!ho.r.headers['strict-transport-security'];
    let redir = null; const hx = http ? outcome(http) : null;
    if (http && hx.kind === 'failed') redir = null; else if (http) redir = hx.r && hx.r.status >= 300 && hx.r.status < 400 && hx.r.redirects.length === 0 && /^https:/i.test(hx.r.headers.location || '') ? true : false;
    if (final.protocol !== 'https:') add('https_redirect_hsts', 'fail', 0, 'No HTTPS.');
    else if (redir === null && http) { failed.add('http'); add('https_redirect_hsts', hsts ? 'warn' : 'unknown', hsts ? 1 : 0, `HSTS: ${hsts ? 'yes' : 'no'}. http:// redirect not checked (${hx.reason}).`); }
    else add('https_redirect_hsts', redir && hsts ? 'pass' : redir || hsts ? 'warn' : 'fail', (redir ? 1 : 0) + (hsts ? 1 : 0), `http:// -> https:// redirect: ${redir ? 'yes' : 'no'}. HSTS: ${hsts ? 'yes' : 'no'}.`);
  }
  {
    const ms = ho.r.ms;
    add('speed', ms < 800 ? 'pass' : ms < 2000 ? 'warn' : 'fail', ms < 800 ? 3 : ms < 2000 ? 1.5 : 0, `First response in ${ms} ms${ho.r.redirects.length ? ` (incl. ${ho.r.redirects.length} redirect(s))` : ''}, ${Math.round(ho.r.bytes / 1024)} KB HTML${ho.r.truncated ? ' (capped)' : ''}.`, { ms, bytes: ho.r.bytes });
  }

  // ---- score ----
  checks.sort((a, b) => Object.keys(WEIGHTS).indexOf(a.id) - Object.keys(WEIGHTS).indexOf(b.id));
  const total = checks.reduce((s, c) => s + c.points, 0);
  const score = Math.round(total);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  const categories = {};
  for (const [k, label] of Object.entries(CATEGORIES)) { const cs = checks.filter((c) => c.category === k); categories[k] = { label, score: Math.round(cs.reduce((s, c) => s + c.points, 0) * 10) / 10, max: cs.reduce((s, c) => s + c.max, 0), unknown: cs.filter((c) => c.status === 'unknown').length }; }
  const sourcesFailed = [...failed];
  const unknownCount = checks.filter((c) => c.status === 'unknown').length;
  const confidence = sourcesFailed.length === 0 && ho.kind === 'ok' ? 'high' : unknownCount <= 2 && !sourcesFailed.includes('robots.txt') ? 'medium' : 'low';
  const verdict = score >= 80 ? 'agent_ready' : score >= 55 ? 'partially_ready' : 'not_ready';
  const counts = checks.reduce((o, c) => { o[c.status] = (o[c.status] || 0) + 1; return o; }, { pass: 0, warn: 0, fail: 0, unknown: 0 });
  const ctx = { origin, final, page, matrix, parsedRobots, smInfo, llmsInfo, home: ho.r, signals };
  const fixes = buildFixes(checks, ctx);
  const warnings = [];
  if (sourcesFailed.length) warnings.push(`checks_incomplete: ${sourcesFailed.join(', ')} could not be fetched; those checks are "unknown" and scored 0 (fail-closed).`);
  if (ho.kind === 'blocked') warnings.push('The page served a bot challenge to an AI-agent user agent; content checks reflect what agents see.');
  return {
    url: target.href, final_url: final.href, host: final.host,
    score, grade, verdict, confidence, categories, counts,
    checks, top_issues: fixes.slice(0, 5).map(({ check, priority, title, points_gain }) => ({ check, priority, title, points_gain })), fixes,
    snippets: buildSnippets(checks, ctx),
    robots: { found: ro.kind === 'ok' && !looksHtml(ro.r), bots: matrix, content_signal: Object.keys(signals).length ? signals : null, sitemaps: parsedRobots.sitemaps.slice(0, 5) },
    sources_failed: sourcesFailed, warnings, requests: f.requests,
    engine: ENGINE_VERSION, checked_at: checkedAt, limits: LIMITS, disclaimer: DISCLAIMER,
  };
}

const FIX = {
  home_ok: ['Make the page return HTTP 200 to AI agents', 'Serve the page with HTTP 200 for non-browser user agents (no login wall, geo block or error page).'],
  no_challenge: ['Stop challenging AI agents', 'Agents cannot solve CAPTCHAs or JS challenges. In Cloudflare: Security > Bots, allow verified AI bots / "AI agents" and skip challenges for /, /robots.txt, /llms.txt and /.well-known/*; on other WAFs add an allow rule for those paths.'],
  robots_agents: ['Allow user-triggered AI agents in robots.txt', 'These bots fetch a page only when a person asks an assistant about it; blocking them hides you from AI answers and agent workflows. Add the robots lines from snippets.robots_txt.'],
  robots_search: ['Allow AI search crawlers', 'AI search engines (ChatGPT search, Claude, Perplexity) cite only pages they can index. Add the robots lines from snippets.robots_txt (training crawlers can stay blocked).'],
  no_noai: ['Remove noindex / noai opt-outs on pages you want agents to use', 'Drop "noindex"/"noai" from <meta name="robots"> and the X-Robots-Tag header, and avoid Content-Signal ai-input=no on public pages.'],
  robots_txt: ['Publish a robots.txt', 'Serve /robots.txt as text/plain with your AI-bot policy and a Sitemap: line (see snippets.robots_txt).'],
  no_js_content: ['Server-render the main content', 'Most agents and AI crawlers do not run JavaScript. Use SSR / static generation (Next.js, Nuxt, Astro, prerendering) so the text is in the HTML response.'],
  markdown: ['Offer a markdown version', 'Serve markdown on "Accept: text/markdown" (Cloudflare: AI Crawl Control > "Markdown for Agents"), or publish /index.md and link it with <link rel="alternate" type="text/markdown" href="/index.md">.'],
  title_description: ['Fix the title and meta description', 'Use a 10-70 character <title> and a 50-160 character meta description that say what the page is (see snippets.meta_tags).'],
  semantic_html: ['Use semantic HTML', 'One <h1>, the main content inside <main>, sections with <h2>, navigation in <nav>.'],
  accessibility: ['Fix accessibility basics agents rely on', 'alt text on images, a <label> (or aria-label) for every form field, names on buttons, and <html lang="...">. Browser agents navigate by these.'],
  llms_txt: ['Publish /llms.txt', 'A markdown map of your site for LLMs (llmstxt.org): "# Name", "> summary", then "## Section" lists of "- [Page](url): what it is". Draft in snippets.llms_txt.'],
  llms_full: ['Publish /llms-full.txt', 'Your key docs/pages concatenated as one markdown file, so an agent can load everything in one request.'],
  sitemap: ['Publish an XML sitemap and list it in robots.txt', 'Serve /sitemap.xml (with <lastmod>) and add "Sitemap: https://your.site/sitemap.xml" to robots.txt.'],
  structured_data: ['Add schema.org JSON-LD', 'Describe the organization, site and page type (Organization, WebSite, Product, Article, FAQPage...) in <script type="application/ld+json">. Starter in snippets.json_ld.'],
  meta_social: ['Add canonical and Open Graph tags', 'rel=canonical plus og:title, og:description and og:image (see snippets.meta_tags).'],
  openapi: ['Publish an OpenAPI spec (if you have an API)', 'Serve /openapi.json (OpenAPI 3.x with info, paths and examples) so agents can call your API without docs scraping.'],
  mcp: ['Expose an MCP server (if agents should act on your service)', 'Run a remote MCP server (Streamable HTTP) at /mcp and describe it in /.well-known/mcp.json (or /.well-known/mcp/server-card.json). Starter in snippets.mcp_json.'],
  agent_card: ['Publish an agent manifest', 'Add /.well-known/agent-card.json (A2A) describing what agents can do with your service. Starter in snippets.agent_card.'],
  x402: ['Make paid endpoints machine-payable (optional)', 'If you sell API calls or content, answer HTTP 402 with x402 terms (USDC) and list the routes in /.well-known/x402 so agents can pay per call.'],
  https: ['Serve the site over HTTPS', 'Get a TLS certificate (free via Let\'s Encrypt or Cloudflare) and serve every page over https://.'],
  https_redirect_hsts: ['Redirect http:// to https:// and send HSTS', 'Answer http:// with a 301 to https:// and add "Strict-Transport-Security: max-age=31536000; includeSubDomains".'],
  speed: ['Speed up the first response', 'Cache HTML at the edge/CDN and cut server work; agents give up on slow pages (aim for < 800 ms to first byte).'],
};
function buildFixes(checks) {
  return checks.filter((c) => c.status === 'fail' || c.status === 'warn')
    .map((c) => { const gain = Math.round((c.max - c.points) * 10) / 10; const [title, how] = FIX[c.id]; return { check: c.id, priority: gain >= 5 ? 'high' : gain >= 2 ? 'medium' : 'low', points_gain: gain, title, how, finding: c.detail }; })
    .filter((x) => x.points_gain > 0)
    .sort((a, b) => b.points_gain - a.points_gain);
}

const clean = (s, n = 160) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function siteName(ctx) {
  const t = ctx.page?.og?.title || ctx.page?.title || ctx.final.hostname;
  return clean(String(t).split(/\s[|\-–—·:]\s/)[0], 80) || ctx.final.hostname;
}
function buildSnippets(checks, ctx) {
  const st = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  const out = {};
  const name = siteName(ctx); const desc = clean(ctx.page?.description || ctx.page?.og?.description || `${name} website`, 200);
  if (st.llms_txt !== 'pass') {
    const links = (ctx.page?.navLinks || []).slice(0, 15);
    const extra = (ctx.smInfo?.sample || []).filter((u) => !links.some((l) => l.href.replace(/\/$/, '') === u.replace(/\/$/, ''))).slice(0, Math.max(0, 12 - links.length));
    const label = (u) => { try { const p = new URL(u).pathname.replace(/\/$/, '').split('/').pop() || 'Home'; return decodeURIComponent(p).replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').replace(/^\w/, (c) => c.toUpperCase()); } catch { return u; } };
    out.llms_txt = [`# ${name}`, '', `> ${desc}`, '', '## Main pages', '', `- [Home](${ctx.origin}/): ${clean(ctx.page?.title || name, 100)}`, ...links.map((l) => `- [${clean(l.label, 60)}](${l.href})`), ...extra.map((u) => `- [${label(u)}](${u})`), '',
      ...(ctx.smInfo ? ['## Optional', '', `- [Sitemap](${ctx.smInfo.url}): every page`] : []), ''].join('\n') + '\n# Review the list, add a one-line note after each link ("- [Page](url): what it covers"), then save as /llms.txt (text/plain or text/markdown).';
  }
  if (st.robots_agents !== 'pass' || st.robots_search !== 'pass' || st.robots_txt !== 'pass' || (ctx.smInfo && !ctx.smInfo.in_robots)) {
    const blocked = ctx.matrix ? Object.entries(ctx.matrix).filter(([, v]) => v.status !== 'allowed' && (v.kind === 'agent' || v.kind === 'search')).map(([k]) => k) : AI_BOTS.filter((b) => b.kind !== 'training').map((b) => b.ua);
    const lines = ['# AI agents and AI search: allowed (they fetch pages for users and cite you)'];
    for (const ua of blocked) lines.push(`User-agent: ${ua}`);
    if (blocked.length) lines.push('Allow: /', '');
    lines.push('# Training crawlers are a separate choice, e.g.:', '# User-agent: GPTBot', '# Disallow: /', '');
    lines.push(`Sitemap: ${ctx.smInfo?.url || `${ctx.origin}/sitemap.xml`}`);
    out.robots_txt = `${lines.join('\n')}\n# Put specific User-agent groups ABOVE any "User-agent: *" group; a bot obeys only its most specific group.`;
  }
  if (st.structured_data !== 'pass') {
    out.json_ld = `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', '@id': `${ctx.origin}/#org`, name, url: `${ctx.origin}/`, ...(ctx.page?.og?.image ? { logo: ctx.page.og.image } : {}) }, { '@type': 'WebSite', '@id': `${ctx.origin}/#website`, name, url: `${ctx.origin}/`, description: desc, publisher: { '@id': `${ctx.origin}/#org` } }] }, null, 2)}\n</script>`;
  }
  if (st.title_description !== 'pass' || st.meta_social !== 'pass') {
    const t = clean(ctx.page?.title || name, 70); const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    out.meta_tags = [`<title>${esc(t)}</title>`, `<meta name="description" content="${esc(desc.slice(0, 160))}">`, `<link rel="canonical" href="${esc(ctx.final.href)}">`, `<meta property="og:title" content="${esc(t)}">`, `<meta property="og:description" content="${esc(desc.slice(0, 200))}">`, `<meta property="og:image" content="${esc(ctx.page?.og?.image || `${ctx.origin}/og-image.png`)}">`, `<meta property="og:url" content="${esc(ctx.final.href)}">`, '<meta name="twitter:card" content="summary_large_image">'].join('\n');
  }
  if (st.markdown !== 'pass') out.markdown = '<link rel="alternate" type="text/markdown" href="/index.md">\n<!-- Or answer "Accept: text/markdown" with a markdown rendering of each page (Cloudflare: "Markdown for Agents"). -->';
  if (st.mcp !== 'pass') out.mcp_json = JSON.stringify({ name, description: desc, endpoint: `${ctx.origin}/mcp`, transport: 'streamable-http', documentation: `${ctx.origin}/llms.txt` }, null, 2);
  if (st.agent_card !== 'pass') out.agent_card = JSON.stringify({ protocolVersion: '0.3.0', name, description: desc, url: `${ctx.origin}/`, version: '1.0.0', capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain', 'application/json'], skills: [{ id: 'info', name: `About ${name}`, description: 'Answer questions about this site and its offerings.', tags: ['info'] }] }, null, 2);
  return out;
}

// ---- views ----
export function liteView(r) {
  return { url: r.url, final_url: r.final_url, host: r.host, score: r.score, grade: r.grade, verdict: r.verdict, confidence: r.confidence, categories: r.categories, counts: r.counts,
    top_issues: r.fixes.slice(0, 5).map(({ check, priority, points_gain, title, how }) => ({ check, priority, points_gain, title, how })),
    ai_bots_blocked: r.robots.bots ? Object.entries(r.robots.bots).filter(([, v]) => v.status === 'blocked').map(([k]) => k) : null,
    sources_failed: r.sources_failed, warnings: r.warnings, engine: r.engine, checked_at: r.checked_at, tier: 'lite', disclaimer: r.disclaimer };
}
export function previewView(r) {
  return { url: r.url, final_url: r.final_url, host: r.host, score: r.score, grade: r.grade, verdict: r.verdict, confidence: r.confidence,
    categories: Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, { score: v.score, max: v.max }])), counts: r.counts,
    issues: r.fixes.length, sources_failed: r.sources_failed, engine: r.engine, checked_at: r.checked_at, tier: 'preview' };
}
