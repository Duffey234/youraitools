// LeakGuard tiers on top of the zero-dependency engine (engine.js):
//   liteScan(text)        -> verdict, findings (masked previews, offsets), redacted text, remediation per finding
//   deepScan({text|json}) -> lite + JSON payloads (findings by JSON path, redacted JSON with the same shape) + leaked-wallet
//                            exposure (public addresses + balances on Base/Ethereum/Polygon/Arbitrum/Solana) + ordered actions
//   previewScan(text)     -> verdict, counts and max severity only (no positions, no redacted text)
// Inputs are processed in memory only: never logged, stored or cached. Findings never echo a secret (masked previews).
import { scan, redact, mask, ENGINE_VERSION as CORE } from './engine.js';
import { deriveAddresses, checkExposure, LIMITS as EXPOSURE_LIMITS } from './exposure.js';

export const ENGINE_VERSION = `leakguard-0.1.0 (${CORE})`;
export const LIMITS = { previewBytes: 8_192, liteBytes: 32_768, scanBytes: 262_144, jsonStrings: 5_000, jsonDepth: 32, maxAddresses: EXPOSURE_LIMITS.maxAddresses };
export const DISCLAIMER = 'Pattern and validator based detection (checksums, Luhn, mod-97, keyword context): it can miss secrets in unknown formats and can flag look-alikes. A clean result is not a guarantee. Balances are a point-in-time lookup of native coin and USDC only.';
export class InputError extends Error { constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; } }

export const REMEDIATION = {
  bip39_mnemonic: 'Treat the wallet as compromised: create a new seed offline and move all funds now. Never paste a seed phrase into a chat, prompt or tool.',
  evm_private_key: 'Treat this key as compromised: move funds to a fresh wallet now and revoke token approvals from the old address.',
  wif_private_key: 'Treat this Bitcoin key as compromised: sweep funds to a new wallet now.',
  bip32_xprv: 'An extended private key exposes every derived address: move all funds from that wallet now.',
  solana_secret_key: 'Treat this Solana keypair as compromised: move SOL and tokens to a new wallet now.',
  solana_secret_key_b58: 'Treat this Solana keypair as compromised: move SOL and tokens to a new wallet now.',
  pem_private_key: 'Rotate the key pair and replace it everywhere it is trusted (servers, certificates, SSH authorized_keys).',
  aws_access_key_id: 'Deactivate and rotate the access key in AWS IAM; check CloudTrail for use.',
  aws_secret_access_key: 'Deactivate and rotate the AWS access key in IAM; check CloudTrail for use.',
  github_token: 'Revoke the token at github.com/settings/tokens and check the security log.',
  gitlab_token: 'Revoke the token in GitLab (User settings > Access tokens).',
  stripe_secret_key: 'Roll the key in the Stripe dashboard (Developers > API keys).',
  anthropic_api_key: 'Delete the key in the Anthropic console and create a new one.',
  openai_api_key: 'Revoke the key in the OpenAI dashboard (API keys) and create a new one.',
  google_api_key: 'Regenerate or restrict the key in Google Cloud console (APIs & Services > Credentials).',
  slack_token: 'Revoke the token (Slack app settings > OAuth) and reinstall the app.',
  slack_webhook: 'Regenerate the incoming webhook URL in the Slack app settings.',
  discord_webhook: 'Delete the webhook in the Discord channel settings and create a new one.',
  telegram_bot_token: 'Revoke it with @BotFather (/revoke) and update the bot.',
  sendgrid_api_key: 'Delete the key in SendGrid (Settings > API Keys) and create a new one.',
  npm_token: 'Revoke the token at npmjs.com (Access Tokens) and check recent publishes.',
  huggingface_token: 'Invalidate the token at huggingface.co/settings/tokens.',
  twilio_api_key: 'Delete the API key in the Twilio console and create a new one.',
  jwt: 'If this token is still valid, revoke the session or rotate the signing key.',
  url_with_credentials: 'Change the password in that URL and stop embedding credentials in URLs.',
  password_assignment: 'Rotate this password or secret wherever it is used.',
  credit_card: 'Do not send card numbers to tools or LLMs; if exposed, ask the issuer to replace the card.',
  iban: 'Remove bank account numbers from prompts and logs unless the recipient needs them.',
  us_ssn: 'Remove SSNs; if exposed to a third party, consider a credit freeze.',
  email: 'Personal data: send only if the recipient needs it (data minimization).',
  phone: 'Personal data: send only if the recipient needs it (data minimization).',
  ipv4: 'Remove internal or personal IP addresses unless needed.',
};
const ACTION_ORDER = ['wallet_key', 'secret', 'pii'];

const bytesOf = (s) => new TextEncoder().encode(s).length;
function checkOpts(o = {}) {
  const style = o.style ?? 'label';
  if (!['label', 'mask'].includes(style)) throw new InputError('"style" must be "label" or "mask"');
  const min = o.min_severity ?? o.minSeverity ?? 'low';
  if (!['low', 'medium', 'high', 'critical'].includes(min)) throw new InputError('"min_severity" must be low, medium, high or critical');
  let types = o.types;
  if (typeof types === 'string') types = types.split(',').map((x) => x.trim()).filter(Boolean);
  if (types !== undefined && (!Array.isArray(types) || types.some((t) => typeof t !== 'string'))) throw new InputError('"types" must be a list of finding types or categories (wallet_key, secret, pii)');
  return { style, minSeverity: min, types: types?.length ? types : undefined };
}
export function checkText(text, max) {
  if (typeof text !== 'string') throw new InputError('"text" must be a string');
  if (!text.length) throw new InputError('"text" is empty');
  const n = bytesOf(text);
  if (n > max) throw new InputError(`text is ${n} bytes; this tier accepts at most ${max} bytes (use /v1/scan for up to ${LIMITS.scanBytes})`, 413, 'too_large');
  return n;
}
const verdictOf = (cats) => (cats.has('wallet_key') ? 'WALLET_KEY_EXPOSED' : cats.has('secret') ? 'SECRETS_FOUND' : cats.has('pii') ? 'PII_FOUND' : 'CLEAN');
const SEV = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export async function previewScan(text) {
  checkText(text, LIMITS.previewBytes);
  const f = await scan(text);
  const counts = {}; const cats = { wallet_key: 0, secret: 0, pii: 0 };
  for (const x of f) { counts[x.type] = (counts[x.type] || 0) + 1; cats[x.category]++; }
  const top = f.reduce((m, x) => Math.max(m, SEV[x.severity]), 0);
  return { verdict: verdictOf(new Set(f.map((x) => x.category))), safe_to_send: f.length === 0, max_severity: Object.keys(SEV).find((k) => SEV[k] === top), total: f.length, categories: cats, counts, engine: ENGINE_VERSION };
}

export async function liteScan(text, opts = {}) {
  const bytes = checkText(text, LIMITS.liteBytes);
  const o = checkOpts(opts);
  const r = await redact(text, o);
  return { ...r, findings: r.findings.map((f) => ({ ...f, remediation: REMEDIATION[f.type] })), confidence: 'high', sources_failed: [], input: { kind: 'text', bytes }, engine: ENGINE_VERSION, checked_at: new Date().toISOString(), tier: 'lite' };
}

function walk(v, path, depth, out, ctx = '') {
  if (depth > LIMITS.jsonDepth) throw new InputError(`JSON nested deeper than ${LIMITS.jsonDepth} levels`);
  if (typeof v === 'string') { if (out.length >= LIMITS.jsonStrings) throw new InputError(`JSON has more than ${LIMITS.jsonStrings} strings`, 413, 'too_large'); out.push({ path, text: v, ctx }); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1, out, ctx)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const kp = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`; if (typeof k === 'string' && k.length) out.push({ path: `${kp}#key`, text: k, isKey: true }); walk(x, kp, depth + 1, out, k.slice(0, 64)); }
}
function rebuild(v, path, map) {
  if (typeof v === 'string') return map.has(path) ? map.get(path) : v;
  if (Array.isArray(v)) return v.map((x, i) => rebuild(x, `${path}[${i}]`, map));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { const kp = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`; o[map.has(`${kp}#key`) ? map.get(`${kp}#key`) : k] = rebuild(x, kp, map); } return o; }
  return v;
}

function applyRedaction(text, fs, style) {
  let out = ''; let pos = 0;
  for (const f of fs) { out += text.slice(pos, f.start) + (style === 'mask' && f.category === 'pii' ? mask(text.slice(f.start, f.end), f.type) : `[REDACTED:${f.type}]`); pos = f.end; }
  return out + text.slice(pos);
}

/** Deep tier. input: { text } or { json }. deps.fetchImpl for the balance lookups. */
export async function deepScan(input, opts = {}, deps = {}) {
  const o = checkOpts(opts);
  let items; let kind; let bytes;
  if (input.json !== undefined) {
    kind = 'json'; const s = JSON.stringify(input.json); bytes = bytesOf(s);
    if (bytes > LIMITS.scanBytes) throw new InputError(`JSON is ${bytes} bytes; at most ${LIMITS.scanBytes}`, 413, 'too_large');
    items = []; walk(input.json, '$', 0, items);
  } else { kind = 'text'; bytes = checkText(input.text, LIMITS.scanBytes); items = [{ path: null, text: input.text }]; }
  const findings = []; const redactedMap = new Map(); const keyRedactions = new Map(); let redactedText; const derived = { addresses: [], not_checked: [] };
  for (const it of items) {
    if (!it.text) continue;
    // JSON values are scanned with their key name in front ("privateKey=<value>") so context rules (EVM keys, AWS
    // secrets, password=...) see the field name; findings inside that prefix are dropped and offsets shifted back.
    const pre = it.ctx ? `${it.ctx}=` : '';
    const raw = (await scan(pre + it.text, o)).filter((f) => f.start >= pre.length).map((f) => ({ ...f, start: f.start - pre.length, end: f.end - pre.length }));
    if (!raw.length) continue;
    const base = findings.length;
    raw.forEach((f) => findings.push({ type: f.type, category: f.category, severity: f.severity, confidence: f.confidence, ...(f.validator ? { validator: f.validator } : {}), start: f.start, end: f.end, preview: mask(it.text.slice(f.start, f.end), f.type), ...(it.path ? { path: it.path.replace(/#key$/, ''), ...(it.isKey ? { in: 'key' } : {}) } : {}), remediation: REMEDIATION[f.type] }));
    const d = await deriveAddresses(it.text, raw);
    for (const a of d.addresses) derived.addresses.push({ ...a, finding: base + a.finding });
    for (const n of d.not_checked) derived.not_checked.push({ ...n, finding: base + n.finding });
    const red = applyRedaction(it.text, raw, o.style);
    if (kind === 'json') { redactedMap.set(it.path, red); if (it.isKey) keyRedactions.set(it.text, red); } else redactedText = red;
  }
  // a JSON key that is itself a secret must not leak through the "path" of any finding
  if (keyRedactions.size) for (const f of findings) if (f.path) for (const [k, r] of keyRedactions) f.path = f.path.split(k).join(r);
  // de-duplicate across strings and cap
  const seen = new Set(); const uniq = [];
  for (const a of derived.addresses) { const k = a.address.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(a); } }
  for (const a of uniq.slice(LIMITS.maxAddresses)) derived.not_checked.push({ finding: a.finding, type: a.type, address: a.address, reason: `more than ${LIMITS.maxAddresses} addresses; not checked` });
  derived.addresses = uniq.slice(0, LIMITS.maxAddresses);
  const exposure = await checkExposure(derived, deps);
  const cats = new Set(findings.map((f) => f.category));
  const counts = {}; for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  const top = findings.reduce((m, f) => Math.max(m, SEV[f.severity]), 0);
  const actions = [];
  if (exposure.status === 'funds_at_risk') actions.push('URGENT: a leaked key controls a wallet that holds funds right now. Move the funds to a new wallet before anything else.');
  else if (exposure.status === 'unknown') actions.push('A leaked wallet key was found and its balance could not be fully checked: assume funds are at risk and move them now.');
  for (const cat of ACTION_ORDER) for (const t of [...new Set(findings.filter((f) => f.category === cat).map((f) => f.type))]) actions.push(REMEDIATION[t]);
  if (findings.length) actions.push('Send the redacted output instead of the original.');
  const sources_failed = exposure.sources_failed;
  return {
    verdict: verdictOf(cats), safe_to_send: findings.length === 0, max_severity: Object.keys(SEV).find((k) => SEV[k] === top), confidence: sources_failed.length ? 'low' : 'high',
    counts, findings, ...(kind === 'json' ? { redacted_json: rebuild(input.json, '$', redactedMap) } : { redacted: redactedText ?? input.text }),
    exposure, actions, sources_failed, input: { kind, bytes, strings_scanned: items.length }, engine: ENGINE_VERSION, checked_at: new Date().toISOString(), tier: 'scan', disclaimer: DISCLAIMER,
  };
}
export { mask };
