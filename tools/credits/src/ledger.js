// Keys and account lookup. A key is "yatc_" + 43 base64url chars (32 random bytes); only its SHA-256 is used
// (as the Durable Object name). Keys are shown once, at purchase, and never stored or logged.
export const KEY_RE = /^yatc_[A-Za-z0-9_-]{43}$/;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function newKey() { return `yatc_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`; }
export async function keyHash(key) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** Durable Object stub for a key (ns = env.ACCOUNTS, or a test fake with the same idFromName/get shape). */
export async function accountFor(ns, key) { return ns.get(ns.idFromName(await keyHash(key))); }

/** Key from Authorization: Bearer / X-Credits-Key / X-Credit-Token (Hono c.req). */
export function keyFromReq(req) {
  const m = (req.header('authorization') || '').trim().match(/^Bearer\s+(\S+)$/i);
  for (const v of [m ? m[1] : '', (req.header('x-credits-key') || '').trim(), (req.header('x-credit-token') || '').trim()]) if (v) return v;
  return '';
}
