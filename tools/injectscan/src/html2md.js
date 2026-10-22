// Fast, dependency-free HTML -> clean Markdown for LLM agents.
// Single regex tokenizer pass (no DOM): drops scripts/styles/nav chrome, prefers <main>/<article>,
// keeps headings, paragraphs, lists, links (absolute), code, blockquotes, simple tables.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷', sect: '§', para: '¶', shy: '' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// Elements whose whole subtree is dropped.
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'head', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'textarea', 'dialog', 'menu']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'address', 'details', 'summary', 'dl', 'dt', 'dd', 'center', 'body', 'html']);

const ATTR_RE = {};
function attr(tag, name) {
  const re = (ATTR_RE[name] ||= new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  const m = tag.match(re);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

export function extractMeta(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  let description = null; let lang = html.match(/<html[^>]*\slang\s*=\s*["']?([\w-]+)/i)?.[1] || null;
  let canonical = null;
  for (const m of html.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const t = m[0];
    if (m[1].toLowerCase() === 'meta') {
      const n = (attr(t, 'name') || attr(t, 'property') || '').toLowerCase();
      if (!description && (n === 'description' || n === 'og:description')) description = attr(t, 'content');
    } else if ((attr(t, 'rel') || '').toLowerCase() === 'canonical') canonical = attr(t, 'href');
  }
  return { title: decodeEntities(title) || null, description: description ? description.trim() : null, lang, canonical };
}

/** Pick the main content region: <main>, else the longest <article>, else <body>, else everything. */
function mainRegion(html) {
  const pick = (re) => { let best = null; for (const m of html.matchAll(re)) if (!best || m[1].length > best.length) best = m[1]; return best; };
  return pick(/<main\b[^>]*>([\s\S]*?)<\/main>/gi) || pick(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)
    || html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] || html;
}

function absolutize(href, base) {
  if (!href) return null;
  if (/^(javascript|data|vbscript|mailto|tel):/i.test(href)) return /^(mailto|tel):/i.test(href) ? href : null;
  if (href.startsWith('#')) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

/**
 * @param {string} html
 * @param {{baseUrl?:string, maxChars?:number, keepImages?:boolean}} [opts]
 * @returns {{markdown:string, title:string|null, description:string|null, lang:string|null, canonical:string|null, links:number, truncated:boolean}}
 */
export function htmlToMarkdown(html, { baseUrl, maxChars = 200000, keepImages = false } = {}) {
  const meta = extractMeta(html);
  const src = mainRegion(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''));
  const out = []; // chunks
  let dropDepth = 0; let dropTag = null;
  let pre = 0; let inCode = 0; let linkStack = []; const listStack = []; let links = 0;
  let textCount = 0; let nlCount = 0; // counters so links can be finalized in O(1)
  let quote = 0; let cellCount = 0; let tableHeaderDone = false; let rowIsHeader = false;
  const nl = (n = 2) => { nlCount++; out.push({ nl: n }); };
  const tok = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>|<![^>]*>|<\?[^>]*>|[^<]+|</g;
  let m;
  while ((m = tok.exec(src))) {
    const t = m[0];
    if (t[0] !== '<' || t === '<') {
      if (dropDepth) continue;
      let text = decodeEntities(t);
      if (!pre) text = text.replace(/[\s\u00a0]+/g, ' ');
      if (text) { out.push({ text, pre: !!pre }); if (/\S/.test(text)) textCount++; }
      continue;
    }
    if (!m[1]) continue;
    const name = m[1].toLowerCase();
    const closing = t[1] === '/';
    if (dropDepth) {
      if (name === dropTag) dropDepth += closing ? -1 : (t.endsWith('/>') ? 0 : 1);
      continue;
    }
    if (!closing && !VOID.has(name) && !t.endsWith('/>') && /\s(hidden\b|aria-hidden\s*=\s*["']?true|role\s*=\s*["']?(navigation|banner|contentinfo|search|complementary)\b)/i.test(t)) {
      dropDepth = 1; dropTag = name; continue;
    }
    if (DROP.has(name) && !closing) {
      if (t.endsWith('/>') || VOID.has(name)) continue;
      dropDepth = 1; dropTag = name; continue;
    }
    if (/^h[1-6]$/.test(name)) {
      if (!closing) { nl(); out.push({ text: '#'.repeat(+name[1]) + ' ', raw: true }); } else nl();
      continue;
    }
    switch (name) {
      case 'br': out.push({ nl: 1 }); break;
      case 'hr': nl(); out.push({ text: '---', raw: true }); nl(); break;
      case 'pre': if (!closing) { pre++; nl(); out.push({ text: '```\n', raw: true }); } else { pre = Math.max(0, pre - 1); out.push({ text: '\n```', raw: true }); nl(); } break;
      case 'code': if (!pre) out.push({ text: '`', raw: true }); inCode += closing ? -1 : 1; break;
      case 'strong': case 'b': if (!pre) out.push({ text: '**', raw: true }); break;
      case 'em': case 'i': if (!pre) out.push({ text: '_', raw: true }); break;
      case 'blockquote': if (!closing) { quote++; nl(); } else { quote = Math.max(0, quote - 1); nl(); } break;
      case 'ul': case 'ol': if (!closing) { listStack.push({ ordered: name === 'ol', n: 0 }); nl(1); } else { listStack.pop(); nl(listStack.length ? 1 : 2); } break;
      case 'li': if (!closing) {
        const L = listStack[listStack.length - 1] || { ordered: false, n: 0 };
        L.n++; nl(1);
        out.push({ text: '  '.repeat(Math.max(0, listStack.length - 1)) + (L.ordered ? `${L.n}. ` : '- '), raw: true });
      } break;
      case 'a': if (!closing) {
        const href = absolutize(attr(t, 'href'), baseUrl);
        linkStack.push({ href, start: out.length, text: textCount, nls: nlCount });
        if (href) out.push({ text: '[', raw: true });
      } else {
        const L = linkStack.pop();
        if (L?.href) {
          if (textCount === L.text) out[L.start] = { text: '', raw: true };
          else if (nlCount !== L.nls) { out[L.start] = { text: '', raw: true }; out.push({ text: ` ([link](${L.href}))`, raw: true }); links++; }
          else { out.push({ text: `](${L.href})`, raw: true }); links++; }
        }
      } break;
      case 'img': if (keepImages) { const s = absolutize(attr(t, 'src'), baseUrl); if (s) out.push({ text: `![${attr(t, 'alt') || ''}](${s})`, raw: true }); } else { const alt = attr(t, 'alt'); if (alt) out.push({ text: alt, pre: false }); } break;
      case 'table': if (!closing) { nl(); tableHeaderDone = false; } else nl(); break;
      case 'tr': if (!closing) { nl(1); out.push({ text: '| ', raw: true }); cellCount = 0; rowIsHeader = false; } else if (!tableHeaderDone) { tableHeaderDone = true; if (cellCount) { nl(1); out.push({ text: '|' + ' --- |'.repeat(cellCount), raw: true }); } } break;
      case 'td': case 'th': if (closing) { out.push({ text: ' | ', raw: true }); cellCount++; if (name === 'th') rowIsHeader = true; } break;
      default: if (BLOCK.has(name)) nl(); else if (name === 'li') nl(1);
    }
    if (quote && (BLOCK.has(name) || name === 'br') && !closing) out.push({ text: '> '.repeat(quote), raw: true });
  }
  // Assemble with newline collapsing.
  const parts = []; let pendingNl = 0;
  for (const c of out) {
    if (c.nl) { pendingNl = Math.max(pendingNl, c.nl); continue; }
    if (!c.text) continue;
    if (pendingNl) {
      if (parts.length) { parts[parts.length - 1] = parts[parts.length - 1].replace(/[ \t]+$/, ''); parts.push('\n'.repeat(pendingNl)); }
      pendingNl = 0;
      if (!c.pre && !c.raw) c.text = c.text.replace(/^ +/, '');
    }
    parts.push(c.text);
  }
  let s = parts.join('');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
    .replace(/\*\*\s*\*\*/g, '').replace(/(^|\n)(#{1,6}) *\n/g, '$1');
  let truncated = false;
  if (s.length > maxChars) { s = s.slice(0, maxChars); truncated = true; }
  return { markdown: s, ...meta, links, truncated };
}

export const wordCount = (s) => (s.match(/\S+/g) || []).length;
