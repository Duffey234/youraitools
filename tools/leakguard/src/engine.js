// LeakGuard engine: find and redact secrets, wallet keys and PII in text BEFORE an agent sends it to a
// third-party tool, LLM or webhook. Zero dependencies; runs on Cloudflare Workers, Node 20+ and browsers.
// Validators keep false positives down: BIP39 checksum, base58check (WIF), Luhn (cards), mod-97 (IBAN), SSN rules.
import { BIP39_EN } from './data/bip39-en.js';

export const ENGINE_VERSION = 'leakguard-engine/0.1.0';
const WORD = new Map(BIP39_EN.map((w, i) => [w, i]));
const subtle = globalThis.crypto?.subtle;
const sha256 = async (bytes) => new Uint8Array(await subtle.digest('SHA-256', bytes));

// ---------- validators ----------
export async function bip39ChecksumOk(words) {
  const n = words.length; if (![12, 15, 18, 21, 24].includes(n)) return false;
  let bits = ''; for (const w of words) { const i = WORD.get(w); if (i === undefined) return false; bits += i.toString(2).padStart(11, '0'); }
  const csLen = n / 3, entLen = bits.length - csLen;
  const ent = new Uint8Array(entLen / 8); for (let i = 0; i < ent.length; i++) ent[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const h = await sha256(ent); const hb = [...h].map((b) => b.toString(2).padStart(8, '0')).join('');
  return hb.slice(0, csLen) === bits.slice(entLen);
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return new Uint8Array(out);
}
export async function base58checkOk(s) {
  const b = b58decode(s); if (!b || b.length < 5) return false;
  const body = b.slice(0, -4), cs = b.slice(-4); const h = await sha256(await sha256(body));
  return cs.every((x, i) => x === h[i]);
}
export function luhnOk(digits) {
  let sum = 0, alt = false; for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
}
export function ibanOk(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4); let m = 0;
  for (const c of r) { const v = c >= 'A' ? (c.charCodeAt(0) - 55).toString() : c; for (const d of v) m = (m * 10 + (d.charCodeAt(0) - 48)) % 97; }
  return m === 1;
}
export function ssnOk(s) {
  const [a, b, c] = s.split('-'); if (a === '000' || a === '666' || a[0] === '9' || b === '00' || c === '0000') return false;
  return !['078-05-1120', '219-09-9999', '123-45-6789'].includes(s); // well-known sample numbers
}
const shannon = (s) => { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0); };

// ---------- detectors ----------
// category: wallet_key (funds at risk), secret (credentials), pii (personal data)
const KEY_CONTEXT = /(priv(ate)?[\s_-]*key|secret[\s_-]*key|\bpk\b|wallet[\s_-]*key|signer[\s_-]*key|PRIVATE_KEY|seed)/i;
const RULES = [
  { type: 'pem_private_key', category: 'secret', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{20,}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { type: 'bip32_xprv', category: 'wallet_key', severity: 'critical', re: /\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/g, check: base58checkOk },
  { type: 'wif_private_key', category: 'wallet_key', severity: 'critical', re: /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, check: base58checkOk },
  { type: 'solana_secret_key', category: 'wallet_key', severity: 'critical', re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, check: (m) => m.slice(1, -1).split(',').every((x) => Number(x) <= 255) },
  { type: 'solana_secret_key_b58', category: 'wallet_key', severity: 'critical', re: /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g, check: (m) => b58decode(m)?.length === 64 },
  { type: 'evm_private_key', category: 'wallet_key', severity: 'critical', re: /\b(?:0x)?[0-9a-fA-F]{64}\b/g, context: KEY_CONTEXT, contextOnly: true },
  { type: 'aws_access_key_id', category: 'secret', severity: 'high', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { type: 'aws_secret_access_key', category: 'secret', severity: 'critical', re: /\b[A-Za-z0-9/+=]{40}\b/g, context: /aws.{0,20}secret|secret.{0,20}access.{0,5}key/i, contextOnly: true },
  { type: 'github_token', category: 'secret', severity: 'critical', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { type: 'gitlab_token', category: 'secret', severity: 'critical', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'stripe_secret_key', category: 'secret', severity: 'critical', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { type: 'anthropic_api_key', category: 'secret', severity: 'critical', re: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/g },
  { type: 'openai_api_key', category: 'secret', severity: 'critical', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}\b/g },
  { type: 'google_api_key', category: 'secret', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'slack_token', category: 'secret', severity: 'critical', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'slack_webhook', category: 'secret', severity: 'high', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
  { type: 'discord_webhook', category: 'secret', severity: 'high', re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,}/g },
  { type: 'telegram_bot_token', category: 'secret', severity: 'critical', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { type: 'sendgrid_api_key', category: 'secret', severity: 'critical', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { type: 'npm_token', category: 'secret', severity: 'critical', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: 'huggingface_token', category: 'secret', severity: 'high', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { type: 'twilio_api_key', category: 'secret', severity: 'high', re: /\bSK[0-9a-f]{32}\b/g },
  { type: 'jwt', category: 'secret', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g },
  { type: 'url_with_credentials', category: 'secret', severity: 'high', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:[^\s@/]{3,128}@[^\s/]+/gi },
  { type: 'password_assignment', category: 'secret', severity: 'high', re: /\b(?:password|passwd|pwd|api[_-]?key|apikey|secret|token|auth[_-]?token|access[_-]?token|client[_-]?secret)\b\s*["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi, group: 1, check: (m) => shannon(m) >= 2.5 && !/^(?:\*+|x+|<[^>]+>|\$\{?[A-Z_]+\}?|process\.env\.\w+|true|false|null|undefined|changeme|password)$/i.test(m) },
  { type: 'credit_card', category: 'pii', severity: 'high', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|3(?:0[0-5]|[68])|35)/.test(d) && luhnOk(d); } },
  { type: 'iban', category: 'pii', severity: 'high', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, check: ibanOk },
  { type: 'us_ssn', category: 'pii', severity: 'high', re: /\b\d{3}-\d{2}-\d{4}\b/g, check: ssnOk },
  { type: 'email', category: 'pii', severity: 'medium', re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g },
  { type: 'phone', category: 'pii', severity: 'medium', re: /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?![\w.])|(?<![\w])\+\d{7,14}(?![\w])/g },
  { type: 'ipv4', category: 'pii', severity: 'low', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, check: (m) => !/^(?:0\.|127\.|10\.|192\.168\.|255\.)/.test(m), notContext: /(?:version|ver\.?|\bv)\s*$/i },
];
const SEV = { low: 1, medium: 2, high: 3, critical: 4 };

async function findMnemonics(text) {
  const out = []; const re = /[a-z]+/g; let m; const toks = [];
  while ((m = re.exec(text))) toks.push({ w: m[0], s: m.index, e: m.index + m[0].length });
  let i = 0;
  while (i < toks.length) {
    if (!WORD.has(toks[i].w)) { i++; continue; }
    let j = i; while (j + 1 < toks.length && WORD.has(toks[j + 1].w) && /^[\s,\d.)-]*$/.test(text.slice(toks[j].e, toks[j + 1].s)) && text.slice(toks[j].e, toks[j + 1].s).length <= 6) j++;
    const run = j - i + 1;
    if (run >= 12) {
      let best = null;
      for (const n of [24, 21, 18, 15, 12]) {
        for (let k = i; k + n - 1 <= j; k++) { const ws = toks.slice(k, k + n).map((t) => t.w); if (await bip39ChecksumOk(ws)) { best = { k, n, valid: true }; break; } }
        if (best) break;
      }
      if (best) out.push({ type: 'bip39_mnemonic', category: 'wallet_key', severity: 'critical', start: toks[best.k].s, end: toks[best.k + best.n - 1].e, confidence: 0.99, validator: `bip39 checksum ok (${best.n} words)` });
      else if (run >= 12) out.push({ type: 'bip39_mnemonic', category: 'wallet_key', severity: 'high', start: toks[i].s, end: toks[j].e, confidence: 0.6, validator: `${run} consecutive BIP39 words, checksum not valid (could still be a seed phrase with a typo)` });
    }
    i = j + 1;
  }
  return out;
}

export async function scan(text, { types, minSeverity = 'low' } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const findings = [...(await findMnemonics(text))];
  for (const r of RULES) {
    r.re.lastIndex = 0; let m;
    while ((m = r.re.exec(text))) {
      const val = r.group ? m[r.group] : m[0]; const start = r.group ? m.index + m[0].lastIndexOf(val) : m.index; const end = start + val.length;
      let confidence = 0.9; let validator;
      if (r.check) { const ok = await r.check(val); if (!ok) continue; validator = 'validated'; confidence = 0.97; }
      if (r.notContext && r.notContext.test(text.slice(Math.max(0, start - 12), start))) continue;
      if (r.context) { const ctx = text.slice(Math.max(0, start - 60), start); const hit = r.context.test(ctx); if (r.contextOnly && !hit) continue; if (hit) { validator = 'keyword context'; confidence = 0.95; } }
      findings.push({ type: r.type, category: r.category, severity: r.severity, start, end, confidence, ...(validator ? { validator } : {}) });
    }
  }
  // drop overlaps: keep the higher-severity / longer finding
  findings.sort((a, b) => a.start - b.start || SEV[b.severity] - SEV[a.severity] || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const f of findings) { const prev = kept[kept.length - 1]; if (prev && f.start < prev.end) { if (SEV[f.severity] > SEV[prev.severity]) kept[kept.length - 1] = f; continue; } kept.push(f); }
  const sel = kept.filter((f) => SEV[f.severity] >= SEV[minSeverity] && (!types || types.includes(f.type) || types.includes(f.category)));
  return sel;
}

export function mask(value, type) {
  if (type === 'email') { const [u, d] = value.split('@'); return `${u[0]}***@${d}`; }
  if (type === 'credit_card' || type === 'iban' || type === 'phone') { const d = value.replace(/[\s-]/g, ''); return `***${d.slice(-4)}`; }
  return `[REDACTED:${type}]`;
}

export async function redact(text, opts = {}) {
  const findings = await scan(text, opts);
  const style = opts.style || 'label'; // label: [REDACTED:type]; mask: keep last 4 / email domain for PII
  let out = ''; let pos = 0; const counts = {};
  for (const f of findings) {
    const v = text.slice(f.start, f.end); counts[f.type] = (counts[f.type] || 0) + 1;
    out += text.slice(pos, f.start) + (style === 'mask' && f.category === 'pii' ? mask(v, f.type) : `[REDACTED:${f.type}]`); pos = f.end;
  }
  out += text.slice(pos);
  const cats = new Set(findings.map((f) => f.category));
  const verdict = cats.has('wallet_key') ? 'WALLET_KEY_EXPOSED' : cats.has('secret') ? 'SECRETS_FOUND' : cats.has('pii') ? 'PII_FOUND' : 'CLEAN';
  const top = findings.reduce((m, f) => Math.max(m, SEV[f.severity]), 0);
  return {
    verdict, safe_to_send: findings.length === 0, max_severity: Object.keys(SEV).find((k) => SEV[k] === top) || 'none',
    counts, findings: findings.map(({ start, end, ...f }) => ({ ...f, start, end, preview: mask(text.slice(start, end), f.type) })),
    redacted: out, engine: ENGINE_VERSION,
  };
}
