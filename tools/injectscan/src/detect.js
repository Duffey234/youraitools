// InjectScan detector: deterministic heuristics for prompt injection in text an LLM agent is about to read.
// scan(text) -> { risk_score 0-100, verdict, categories, findings (with spans into the ORIGINAL text), hidden, decoded }
// No network, no model, no state: the same input and RULESET_VERSION always give the same result.
import { RULES, CATEGORIES, RULESET_VERSION } from './rules.js';

export { RULESET_VERSION, CATEGORIES };
export const THRESHOLDS = { suspicious: 0.35, malicious: 0.7 };
export const MAX_SCAN_CHARS = 200_000;

// Invisible characters: zero-width, word joiners, BOM, soft hyphen, Mongolian vowel separator, invisible math operators.
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x00ad, 0x180e, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]);
// BOM and soft hyphen are stripped too but are common in ordinary web text, so they only count when there are many.
const BENIGN_INVISIBLE = new Set([0xfeff, 0x00ad]);
const isBidi = (cp) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f || cp === 0x061c;
const isTag = (cp) => cp >= 0xe0000 && cp <= 0xe007f; // Unicode "tag" block: invisible ASCII ("ASCII smuggling")
// Cyrillic / Greek letters that render like Latin ones.
const CONFUSABLE = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y', 'Ζ': 'Z',
};
// ZWJ between pictographs builds emoji sequences (e.g. a technologist emoji); that is not hidden text.
const PICTO = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F]/u;
function isEmojiJoin(text, i) { const before = text.slice(Math.max(0, i - 2), i); const after = text.slice(i + 1, i + 3); return PICTO.test(before) || PICTO.test(after); }
const LATIN = /[A-Za-z]/; const CYRILLIC = /[\u0400-\u04ff]/;

/**
 * Normalize while keeping a map back to the original string.
 * @returns {{ cased: string, lower: string, start: number[], end: number[], hidden: object }}
 */
export function normalize(text) {
  // Fast path: plain ASCII without control tricks needs no folding, and offsets map 1:1 (start/end = null).
  if (!/[^\x00-\x7f]/.test(text)) {
    return { cased: text, lower: text.toLowerCase(), start: null, end: null, hidden: { zeroWidth: 0, benignInvisible: 0, bidi: 0, tagChars: 0, tagText: '', tagSpans: [], zeroWidthSpans: [], homoglyphWords: 0 } };
  }
  const parts = []; let cap = text.length + 64; let start = new Int32Array(cap); let end = new Int32Array(cap); let k = 0;
  const grow = (need) => { if (k + need <= cap) return; cap = Math.max(cap * 2, k + need); const s2 = new Int32Array(cap); s2.set(start); start = s2; const e2 = new Int32Array(cap); e2.set(end); end = e2; };
  const hidden = { zeroWidth: 0, benignInvisible: 0, bidi: 0, tagChars: 0, tagText: '', tagSpans: [], zeroWidthSpans: [], homoglyphWords: 0 };
  let tagRun = null;
  const ASCII_RUN = /[\x00-\x7f]{8,}/y;
  for (let i = 0; i < text.length;) {
    ASCII_RUN.lastIndex = i;
    if (text.charCodeAt(i) < 0x80 && ASCII_RUN.test(text)) {
      const j = ASCII_RUN.lastIndex; grow(j - i); parts.push(text.slice(i, j));
      for (let p = i; p < j; p++) { start[k] = p; end[k] = p + 1; k++; }
      i = j; continue;
    }
    const cp = text.codePointAt(i); const len = cp > 0xffff ? 2 : 1; const ch = text.slice(i, i + len);
    if (isTag(cp)) {
      hidden.tagChars++;
      if (cp >= 0xe0020 && cp <= 0xe007e) hidden.tagText += String.fromCharCode(cp - 0xe0000);
      if (tagRun && tagRun.end === i) tagRun.end = i + len; else { tagRun = { start: i, end: i + len }; hidden.tagSpans.push(tagRun); }
    } else if (BENIGN_INVISIBLE.has(cp)) {
      hidden.benignInvisible++;
    } else if (ZERO_WIDTH.has(cp) && !(cp === 0x200d && isEmojiJoin(text, i))) {
      hidden.zeroWidth++;
      const last = hidden.zeroWidthSpans[hidden.zeroWidthSpans.length - 1];
      if (last && last.end === i) last.end = i + len; else if (hidden.zeroWidthSpans.length < 50) hidden.zeroWidthSpans.push({ start: i, end: i + len });
    } else if (isBidi(cp)) {
      hidden.bidi++;
    } else {
      const folded = cp < 0x80 ? ch : (CONFUSABLE[ch] || ch).normalize('NFKC');
      grow(folded.length); parts.push(folded);
      for (let q = 0; q < folded.length; q++) { start[k] = i; end[k] = i + len; k++; }
    }
    i += len;
  }
  // Homoglyph words: a single word mixing Latin letters with Cyrillic look-alikes (Greek is skipped: math text mixes it legitimately).
  for (const w of text.match(/[\p{L}]{3,}/gu) || []) if (LATIN.test(w) && CYRILLIC.test(w) && [...w].some((c) => CONFUSABLE[c] && CYRILLIC.test(c))) hidden.homoglyphWords++;
  const cased = parts.join('');
  return { cased, lower: cased.toLowerCase(), start: start.subarray(0, k), end: end.subarray(0, k), hidden };
}

// Compile every rule once, and derive a cheap pre-filter: when a pattern starts with \b(alt1|alt2|...) and every
// alternative begins with a plain literal, the rule can only match if one of those literals occurs in the text,
// which String.includes checks far faster than running the regex. Rules without such a prefix always run.
function hasTopLevelAlt(src) {
  let depth = 0, inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true; else if (c === '(') depth++; else if (c === ')') depth--; else if (c === '|' && depth <= 0) return true;
  }
  return false;
}
function literalPrefixes(source) {
  let i = source.startsWith('\\b(') ? 3 : -1;
  if (i < 0) return null;
  const alts = []; let depth = 0, cur = '', inClass = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { cur += c + source[i + 1]; i++; continue; }
    if (inClass) { if (c === ']') inClass = false; cur += c; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') { if (depth === 0) { alts.push(cur); break; } depth--; }
    if (c === '|' && depth === 0) { alts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (i >= source.length || hasTopLevelAlt(source.slice(i + 1))) return null; // "\b(a|b)x|y": y has no literal prefix
  const out = [];
  for (const a of alts) {
    const m = a.match(/^[a-z0-9 '_-]+/i); let lit = m ? m[0] : '';
    // A quantifier right after the literal makes its last character optional.
    if (lit && /^[?*{]/.test(a.slice(lit.length))) lit = lit.slice(0, -1);
    if (lit.replace(/ /g, '').length < 3) return null;
    out.push(lit);
  }
  return out.length ? out : null;
}
const COMPILED = RULES.map((rule) => {
  const flags = rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g';
  const pre = literalPrefixes(rule.re.source);
  // Pre-filter key = the literal's first word, at most 12 characters; it must be the start of some word in the text.
  const keys = pre && pre.map((x) => (rule.cs ? x : x.toLowerCase()).match(/^[\p{L}\p{N}_]*/u)[0].slice(0, 12));
  return { rule, re: new RegExp(rule.re.source, flags), reI: new RegExp(rule.re.source, flags.includes('i') ? flags : flags + 'i'), keys: keys && keys.every((k) => k.length >= 3) ? keys : null };
});
/** Set of every 3..12-character prefix of every word, for the pre-filter. */
function wordPrefixes(str) {
  const set = new Set();
  for (const m of str.matchAll(/[\p{L}\p{N}_]{3,}/gu)) { const w = m[0]; const top = Math.min(12, w.length); for (let l = 3; l <= top; l++) set.add(w.slice(0, l)); }
  return set;
}

function runRules(n, { offset = 0, location = 'text', origLen } = {}) {
  const findings = [];
  const lowerOk = n.lower.length === n.cased.length; // toLowerCase keeps length except for rare characters (e.g. U+0130)
  let lowerSet, casedSet;
  for (const { rule, re: reCs, reI, keys } of COMPILED) {
    const src = rule.cs || !lowerOk ? n.cased : n.lower;
    if (keys) {
      const set = rule.cs ? (casedSet ||= wordPrefixes(n.cased)) : (lowerSet ||= wordPrefixes(n.lower));
      if (!keys.some((k) => set.has(k))) continue;
    }
    const re = rule.cs ? reCs : lowerOk ? reCs : reI;
    re.lastIndex = 0; let m; let hits = 0;
    while ((m = re.exec(src)) && hits < 20) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      hits++;
      const s = n.start ? (m.index < n.start.length ? n.start[m.index] : origLen) : m.index;
      const e = n.end ? (m.index + m[0].length - 1 < n.end.length ? n.end[m.index + m[0].length - 1] : origLen) : m.index + m[0].length;
      findings.push({ rule: rule.id, category: rule.category, weight: rule.weight, start: s + offset, end: e + offset, location });
    }
  }
  return findings;
}

const printableRatio = (s) => { if (!s.length) return 0; let p = 0; for (const c of s) { const k = c.charCodeAt(0); if ((k >= 32 && k < 127) || k === 10 || k === 13 || k === 9 || k > 159) p++; } return p / s.length; };
function b64decode(s) {
  try {
    const t = s.replace(/-/g, '+').replace(/_/g, '/'); const pad = t + '='.repeat((4 - (t.length % 4)) % 4);
    const bin = atob(pad); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}
function hexdecode(s) { try { const bytes = new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16))); return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } }
function escdecode(s) {
  try { return s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/(%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } }); } catch { return null; }
}

/** Find encoded segments that decode to readable text. Spans are into the original text. */
export function findEncoded(text, limit = 25) {
  const out = [];
  const tryAdd = (encoding, m, decoded) => {
    if (!decoded || decoded.length < 8 || printableRatio(decoded) < 0.9 || !/[a-z]{3,}.*\s.*[a-z]{2,}/i.test(decoded)) return;
    out.push({ encoding, start: m.index, end: m.index + m[0].length, decoded: decoded.slice(0, 2000) });
  };
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/=_-])/g)) { if (out.length >= limit) break; if (/^[a-z]+$/i.test(m[0]) || /^[0-9a-f]+$/i.test(m[0])) continue; tryAdd('base64', m, b64decode(m[0])); }
  for (const m of text.matchAll(/(?<![0-9a-fx])(?:[0-9a-f]{2}){16,}(?![0-9a-f])/gi)) { if (out.length >= limit) break; tryAdd('hex', m, hexdecode(m[0])); }
  for (const m of text.matchAll(/(?:\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|%[0-9a-f]{2}){8,}/gi)) { if (out.length >= limit) break; tryAdd('escaped', m, escdecode(m[0])); }
  return out;
}

const WEAK = 0.3; const WEAK_CAP = 0.3;
const noisyOr = (ws) => 1 - ws.reduce((p, w) => p * (1 - w), 1);

function score(findings) {
  // Per rule: strongest weight, plus a small bump for repeats. Per category: noisy-OR of rules. Overall: noisy-OR of categories.
  const byRule = new Map();
  for (const f of findings) { const cur = byRule.get(f.rule); if (!cur) byRule.set(f.rule, { ...f, n: 1 }); else { cur.n++; if (f.weight > cur.weight) Object.assign(cur, { weight: f.weight, start: f.start, end: f.end }); } }
  // Two rules of the same category matching the same words are one signal, not two: halve the weaker one.
  const rules = [...byRule.values()].sort((a, b) => b.weight - a.weight);
  for (let i = 0; i < rules.length; i++) for (let j = 0; j < i; j++) {
    const a = rules[i], b = rules[j];
    if (a.category !== b.category || a.halved) continue;
    const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    if (ov > 0 && ov >= 0.5 * (a.end - a.start)) { a.weight *= 0.5; a.halved = true; }
  }
  const byCat = new Map();
  for (const r of rules) { const w = Math.min(0.95, r.weight + Math.min(0.1, 0.03 * (r.n - 1))); (byCat.get(r.category) || byCat.set(r.category, []).get(r.category)).push(w); }
  const categories = [...byCat.entries()].map(([category, ws]) => ({ category, score: +noisyOr(ws).toFixed(3), rules: ws.length })).sort((a, b) => b.score - a.score);
  // Weak signals (weight < WEAK) are common in ordinary technical text (install commands, badges, "silently").
  // Together they add at most WEAK_CAP, so on their own they never reach "suspicious".
  const bumped = (r) => Math.min(0.95, r.weight + Math.min(0.1, 0.03 * (r.n - 1)));
  const strong = rules.filter((r) => r.weight >= WEAK).map(bumped); const weak = rules.filter((r) => r.weight < WEAK).map(bumped);
  const total = noisyOr([...strong, Math.min(WEAK_CAP, noisyOr(weak))]);
  return { total, categories };
}

/** Hidden-text findings from the normalization pass (spans into the original text). */
function hiddenFindings(h, textLen) {
  const f = [];
  if (h.tagChars) for (const s of h.tagSpans.slice(0, 20)) f.push({ rule: 'hidden.unicode_tags', category: 'hidden_text', weight: 0.8, ...s, location: 'text' });
  if (h.zeroWidth) {
    const w = h.zeroWidth >= 20 ? 0.45 : h.zeroWidth >= 5 ? 0.25 : 0.1;
    for (const s of h.zeroWidthSpans.slice(0, 20)) f.push({ rule: 'hidden.zero_width', category: 'hidden_text', weight: w, ...s, location: 'text' });
  }
  if (h.benignInvisible >= 20) f.push({ rule: 'hidden.many_invisible', category: 'hidden_text', weight: 0.2, start: 0, end: textLen, location: 'text' });
  if (h.bidi) f.push({ rule: 'hidden.bidi_controls', category: 'hidden_text', weight: h.bidi >= 2 ? 0.4 : 0.2, start: 0, end: textLen, location: 'text' });
  if (h.homoglyphWords) f.push({ rule: 'hidden.homoglyphs', category: 'hidden_text', weight: h.homoglyphWords >= 3 ? 0.45 : 0.2, start: 0, end: textLen, location: 'text' });
  return f;
}

/**
 * Scan text. Options: { maxChars, depth (internal), extraFindings }.
 * @returns {object} result (see README for the schema)
 */
export function scan(input, { maxChars = MAX_SCAN_CHARS, depth = 0, extraFindings = [], detail = true } = {}) {
  const t0 = Date.now();
  const original = String(input ?? '');
  const text = original.length > maxChars ? original.slice(0, maxChars) : original;
  const n = normalize(text);
  let findings = runRules(n, { origLen: text.length });
  findings.push(...hiddenFindings(n.hidden, text.length));

  // Smuggled text in Unicode tag characters: scan it too and attribute matches to the tag span.
  const decoded = [];
  if (n.hidden.tagText.trim() && depth < 2) {
    const sub = scan(n.hidden.tagText, { maxChars, depth: depth + 1, detail: false });
    const span = n.hidden.tagSpans[0];
    decoded.push({ encoding: 'unicode_tags', start: span.start, end: n.hidden.tagSpans[n.hidden.tagSpans.length - 1].end, decoded: n.hidden.tagText.slice(0, 2000), risk_score: sub.risk_score });
    for (const f of sub._findings) findings.push({ ...f, weight: Math.min(0.95, f.weight + 0.15), start: span.start, end: span.end, location: 'unicode_tags' });
  }
  // Encoded payloads: decode, rescan, and attribute matches to the encoded segment.
  if (depth < 2) {
    for (const seg of findEncoded(text)) {
      const sub = scan(seg.decoded, { maxChars, depth: depth + 1, detail: false });
      decoded.push({ ...seg, risk_score: sub.risk_score });
      if (sub._findings.length) {
        findings.push({ rule: `encoded.${seg.encoding}_instructions`, category: 'encoded_payload', weight: Math.max(0.5, Math.min(0.9, sub.risk_score / 100 + 0.2)), start: seg.start, end: seg.end, location: seg.encoding });
        for (const f of sub._findings) findings.push({ ...f, start: seg.start, end: seg.end, location: seg.encoding });
      } else {
        findings.push({ rule: `encoded.${seg.encoding}_text`, category: 'encoded_payload', weight: 0.1, start: seg.start, end: seg.end, location: seg.encoding });
      }
    }
  }
  // Leetspeak ("1gn0r3 4ll pr3v10u5 1n57ruc710n5"): if several tokens mix letters and digits, rescan a de-leeted copy.
  if (depth < 2) {
    const head = text.length > 20000 ? text.slice(0, 20000) : text; // leetspeak obfuscation is a short-text trick
    const leetTokens = head.match(/\b(?=[a-z0-9@$]*[a-z])(?=[a-z0-9@$]*[0-9@$])[a-z0-9@$]{3,}\b/gi) || [];
    // Leet words have a letter-to-digit substitution inside the word (h3ll0, 1gn0r3), not a version or unit suffix.
    const realLeet = leetTokens.filter((w) => /[a-z][0134578@$9][a-z]|^[0134578@$9][a-z]{2}/i.test(w) && !/^(0x)?[0-9a-f]+$/i.test(w));
    if (realLeet.length >= 4) {
      const map = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', '$': 's' };
      const deleet = head.replace(/[a-z0-9@$]+/gi, (w) => (/[a-z]/i.test(w) || w.length > 2 ? w.replace(/[0134578@$9]/g, (c) => map[c]) : w));
      const sub = scan(deleet, { maxChars, depth: 2, detail: false });
      const known = new Set(findings.map((f) => f.rule)); const fresh = sub._findings.filter((f) => f.category !== 'hidden_text' && !known.has(f.rule));
      if (fresh.length) {
        decoded.push({ encoding: 'leetspeak', start: 0, end: head.length, decoded: deleet.slice(0, 2000), risk_score: sub.risk_score });
        findings.push({ rule: 'obfuscation.leetspeak', category: 'hidden_text', weight: 0.4, start: 0, end: head.length, location: 'leetspeak' });
        for (const f of fresh) findings.push({ ...f, start: 0, end: head.length, location: 'leetspeak' });
      }
    }
  }
  findings.push(...extraFindings);
  const { total, categories } = score(findings);
  const risk = Math.round(total * 100);
  const verdict = total >= THRESHOLDS.malicious ? 'malicious' : total >= THRESHOLDS.suspicious ? 'suspicious' : 'safe';
  const result = {
    risk_score: risk, verdict, flagged: verdict !== 'safe',
    categories: categories.map((c) => ({ ...c, score: Math.round(c.score * 100), description: CATEGORIES[c.category] })),
    findings: detail ? dedupe(findings).map((f) => ({ ...f, text: snippet(original, f) })) : undefined,
    hidden: detail ? { zero_width: n.hidden.zeroWidth, bom_soft_hyphen: n.hidden.benignInvisible, bidi_controls: n.hidden.bidi, unicode_tags: n.hidden.tagChars, homoglyph_words: n.hidden.homoglyphWords } : undefined,
    decoded: detail ? decoded : undefined,
    chars_scanned: text.length, truncated: original.length > text.length,
    ruleset: RULESET_VERSION, ms: Date.now() - t0,
  };
  Object.defineProperty(result, '_findings', { value: findings, enumerable: false });
  return result;
}

function dedupe(fs) {
  const seen = new Set(); const out = [];
  for (const f of fs.sort((a, b) => b.weight - a.weight || a.start - b.start)) { const k = `${f.rule}:${f.start}:${f.end}:${f.location}`; if (!seen.has(k)) { seen.add(k); out.push(f); } }
  return out.slice(0, 100).sort((a, b) => a.start - b.start);
}
function snippet(text, f) {
  if (f.location !== 'text' && f.location !== 'unicode_tags' && !['base64', 'hex', 'escaped'].includes(f.location)) return undefined;
  const s = text.slice(f.start, Math.min(f.end, f.start + 200));
  return s.length < f.end - f.start ? s + '…' : s;
}
