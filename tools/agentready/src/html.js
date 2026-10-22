// Lightweight HTML fact extraction (regex based, bounded input) that works the same in Workers and Node.
// Only reads the raw server HTML: what an agent without a JS engine sees.
export const MAX_PARSE = 600 * 1024;

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } });
export function attrs(tag) {
  const out = {}; const re = /([^\s=/<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let m;
  const inner = tag.replace(/^<[^\s>]+/, '').replace(/\/?>$/, '');
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
const count = (html, name) => tags(html, name).length;

export function extract(htmlIn, baseUrl) {
  const html = String(htmlIn || '').slice(0, MAX_PARSE);
  const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html) || [, html.slice(0, 100000)])[1];
  const metas = tags(head, 'meta').map(attrs);
  const meta = (k) => metas.find((m) => (m.name || '').toLowerCase() === k || (m.property || '').toLowerCase() === k)?.content?.trim() || null;
  const links = tags(head, 'link').map(attrs);
  const abs = (h) => { try { return new URL(h, baseUrl).href; } catch { return null; } };
  const title = decode((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [])[1] || '').replace(/\s+/g, ' ').trim() || null;
  const htmlTag = attrs((/<html\b[^>]*>/i.exec(html) || ['<html>'])[0]);

  // JSON-LD
  const ld = []; let ldInvalid = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { ld.push(JSON.parse(m[1].trim())); } catch { ldInvalid++; }
  }
  const ldTypes = new Set();
  const walk = (n, d = 0) => { if (!n || d > 6) return; if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1)); if (typeof n !== 'object') return; const t = n['@type']; (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => ldTypes.add(String(x))); if (n['@graph']) walk(n['@graph'], d + 1); };
  ld.forEach((x) => walk(x));
  const microdata = (html.match(/\bitemscope\b/gi) || []).length;
  const rdfa = (html.match(/\btypeof\s*=/gi) || []).length;

  // Visible text in the raw HTML (scripts, styles, templates, svg removed)
  const body = (/<body\b[^>]*>([\s\S]*)/i.exec(html) || [, html])[1];
  const stripped = body.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decode(stripped.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  const scripts = count(html, 'script');
  const spaShell = /<div[^>]+id\s*=\s*["'](root|app|__next|__nuxt|svelte|q-app)["'][^>]*>\s*<\/div>/i.test(html) && words < 80;
  const needsJs = /(enable|turn on)\s+javascript|requires? javascript|javascript (is )?(required|disabled)/i.test(text) && words < 150;

  // Semantics and accessibility basics
  const headings = {}; for (let i = 1; i <= 6; i++) headings[`h${i}`] = count(html, `h${i}`);
  const landmarks = { main: count(html, 'main') + (html.match(/role\s*=\s*["']main["']/gi) || []).length, nav: count(html, 'nav'), header: count(html, 'header'), footer: count(html, 'footer'), article: count(html, 'article') };
  const imgs = tags(html, 'img').map(attrs);
  const imgNoAlt = imgs.filter((a) => a.alt === undefined && a.role !== 'presentation' && a['aria-hidden'] !== 'true').length;
  const ids = new Set((html.match(/<label\b[^>]*\bfor\s*=\s*["']?([^"'\s>]+)/gi) || []).map((l) => (/for\s*=\s*["']?([^"'\s>]+)/i.exec(l) || [])[1]));
  const inputs = tags(html, 'input').map(attrs).filter((a) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((a.type || '').toLowerCase()));
  const fields = [...inputs, ...tags(html, 'select').map(attrs), ...tags(html, 'textarea').map(attrs)];
  const wrapped = (html.match(/<label\b[^>]*>(?:(?!<\/label>)[\s\S]){0,400}?<(input|select|textarea)\b/gi) || []).length;
  const unlabeled = Math.max(0, fields.filter((a) => !(a['aria-label'] || a['aria-labelledby'] || a.title || (a.id && ids.has(a.id)))).length - wrapped);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  const unnamedButtons = buttons.filter((b) => { const a = attrs(`<b ${b[1]}>`); return !(a['aria-label'] || a.title || a['aria-labelledby']) && !decode(b[2].replace(/<[^>]+>/g, '')).trim() && !/\balt\s*=\s*["'][^"']+/.test(b[2]); }).length;

  // Same-site links with anchor text (for the llms.txt draft)
  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return null; } })();
  const navLinks = []; const seen = new Set();
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (navLinks.length >= 40) break;
    const a = attrs(`<a ${m[1]}>`); const href = a.href && abs(a.href);
    if (!href || !origin || !href.startsWith(origin) || /#|\.(png|jpe?g|gif|svg|webp|pdf|zip)$/i.test(href) || /\/(login|signin|signup|register|cart|account|logout)\b/i.test(href)) continue;
    const label = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || a['aria-label'] || a.title;
    if (!label || label.length > 80) continue;
    const key = href.replace(/\/$/, '');
    if (seen.has(key) || key === origin) continue;
    seen.add(key); navLinks.push({ href, label });
  }
  const robotsMeta = metas.filter((m) => /^(robots|googlebot|gptbot|chatgpt-user|claudebot|ccbot)$/i.test(m.name || '')).map((m) => `${m.name}: ${m.content || ''}`);
  return {
    title, lang: htmlTag.lang || null,
    description: meta('description'), canonical: abs(links.find((l) => /(^|\s)canonical(\s|$)/i.test(l.rel || ''))?.href || '') || null,
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), type: meta('og:type'), url: meta('og:url') },
    twitter: { card: meta('twitter:card') },
    viewport: !!meta('viewport'), robotsMeta,
    alternates: links.filter((l) => /alternate/i.test(l.rel || '') && l.type).map((l) => ({ type: l.type.toLowerCase(), href: abs(l.href) })).filter((l) => l.href),
    linkRels: links.filter((l) => /\b(llms|mcp|api|describedby|service-desc|agent)\b/i.test(l.rel || '')).map((l) => ({ rel: l.rel, href: abs(l.href), type: l.type || null })).filter((l) => l.href),
    jsonld: { blocks: ld.length, invalid: ldInvalid, types: [...ldTypes].slice(0, 30) }, microdata, rdfa,
    text: { words, sample: text.slice(0, 300), scripts, spaShell, needsJs, htmlBytes: html.length, ratio: html.length ? Math.round((text.length / html.length) * 1000) / 1000 : 0 },
    headings, landmarks,
    a11y: { images: imgs.length, imagesMissingAlt: imgNoAlt, fields: fields.length, unlabeledFields: unlabeled, buttons: buttons.length, unnamedButtons },
    navLinks,
  };
}
