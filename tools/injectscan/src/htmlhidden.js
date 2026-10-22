// Text in an HTML page that a human does not see but an agent reading the raw HTML (or a naive extractor) might:
// comments, elements hidden with CSS or attributes, and alt / title / aria-label / meta text.
import { decodeEntities } from './html2md.js';

const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|em|rem|pt|%)?\s*(;|$|!)|opacity\s*:\s*0(\.0+)?\s*(;|$|!)|(^|;)\s*color\s*:\s*(transparent|rgba\([^)]*,\s*0\))|(height|width|max-height)\s*:\s*0(px)?\s*;[^"']*overflow\s*:\s*hidden|(left|top|text-indent)\s*:\s*-\d{3,}px|clip\s*:\s*rect\(\s*0)/i;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const textOf = (html) => decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * @param {string} html
 * @param {{ maxSegments?: number, maxChars?: number }} [o]
 * @returns {{ kind: string, text: string }[]}
 */
export function hiddenSegments(html, { maxSegments = 200, maxChars = 50000 } = {}) {
  const out = []; let total = 0;
  const push = (kind, text) => {
    text = (text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 12 || out.length >= maxSegments || total >= maxChars) return;
    text = text.slice(0, maxChars - total); total += text.length; out.push({ kind, text });
  };
  for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) push('html_comment', m[1]);
  // Elements hidden by inline style, the hidden attribute or aria-hidden: take the text up to the matching close tag.
  const open = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi; let m;
  while ((m = open.exec(html)) && out.length < maxSegments) {
    const [, tag, attrs] = m; const t = tag.toLowerCase();
    if (VOID.has(t) || t === 'script' || t === 'style' || t === 'template') continue;
    const style = attrs.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i); const css = style ? (style[2] ?? style[3]) : '';
    const hiddenAttr = /\shidden(\s|=|$)|aria-hidden\s*=\s*["']?true/i.test(' ' + attrs);
    if (!hiddenAttr && !(css && HIDDEN_STYLE.test(css))) continue;
    // Find the matching close tag (same-name nesting only), capped at 20k chars.
    const re = new RegExp(`<(/?)${t}\\b[^>]*>`, 'gi'); re.lastIndex = open.lastIndex; let depth = 1, end = -1, x;
    while ((x = re.exec(html)) && re.lastIndex - open.lastIndex < 20000) { if (x[1]) { if (--depth === 0) { end = x.index; break; } } else depth++; }
    if (end < 0) continue;
    push(hiddenAttr ? 'hidden_element' : 'css_hidden', textOf(html.slice(open.lastIndex, end)));
    open.lastIndex = end;
  }
  for (const a of html.matchAll(/\s(alt|title|aria-label|aria-description|data-[a-z-]*(prompt|instruction|llm|ai)[a-z-]*)\s*=\s*("([^"]{12,})"|'([^']{12,})')/gi)) push(`attr_${a[1].toLowerCase()}`, decodeEntities(a[4] ?? a[5]));
  for (const a of html.matchAll(/<meta\b[^>]*\scontent\s*=\s*("([^"]{12,})"|'([^']{12,})')[^>]*>/gi)) push('meta', decodeEntities(a[2] ?? a[3]));
  return out;
}
