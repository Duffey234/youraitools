// Address format detection and checksum validation (no network). Used to report a chain guess and whether the
// address is well-formed; the sanctions match itself is an exact lookup and does not depend on this.
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_XRP = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

export function base58Decode(s, alphabet = B58) {
  let n = 0n;
  for (const ch of s) { const i = alphabet.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === alphabet[0]) bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
/** base58check: returns the payload (version + data) or null when the 4-byte double-SHA256 checksum fails. */
export function base58Check(s, alphabet = B58) {
  const b = base58Decode(s, alphabet);
  if (!b || b.length < 5) return null;
  const body = b.slice(0, -4); const sum = sha256(sha256(body)).slice(0, 4);
  return sum.every((x, i) => x === b[b.length - 4 + i]) ? body : null;
}

/** EIP-55: true / false for mixed case, null when the address is all lower or all upper case (no checksum). */
export function eip55(addr) {
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return null;
  const h = hex(keccak_256(new TextEncoder().encode(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const c = body[i]; if (/[0-9]/.test(c)) continue;
    if ((parseInt(h[i], 16) >= 8) !== (c === c.toUpperCase())) return false;
  }
  return true;
}
export function toChecksumAddress(addr) {
  const body = addr.slice(2).toLowerCase(); const h = hex(keccak_256(new TextEncoder().encode(body)));
  return '0x' + [...body].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1;
  for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]; }
  return chk >>> 0;
}
/** bech32 / bech32m: { hrp, variant, witnessVersion } or null. Mixed case is invalid. */
export function bech32Decode(s) {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const str = s.toLowerCase(); const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length || str.length > 90) return null;
  const hrp = str.slice(0, pos); const data = [];
  for (const ch of str.slice(pos + 1)) { const i = BECH.indexOf(ch); if (i < 0) return null; data.push(i); }
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const pm = bech32Polymod([...exp, ...data]);
  const variant = pm === 1 ? 'bech32' : pm === 0x2bc830a3 ? 'bech32m' : null;
  return variant ? { hrp, variant, witnessVersion: data[0] } : null;
}
function cashaddrPolymod(v) {
  const G = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]; let c = 1n;
  for (const d of v) { const c0 = c >> 35n; c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d); for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= G[i]; }
  return c ^ 1n;
}
/** Bitcoin Cash cashaddr (with or without the bitcoincash: prefix). */
export function cashaddrValid(s, prefix = 'bitcoincash') {
  const str = s.toLowerCase(); const body = str.includes(':') ? str.split(':')[1] : str;
  const p = str.includes(':') ? str.split(':')[0] : prefix; const data = [];
  for (const ch of body) { const i = BECH.indexOf(ch); if (i < 0) return false; data.push(i); }
  return cashaddrPolymod([...[...p].map((c) => c.charCodeAt(0) & 31), 0, ...data]) === 0n;
}

const B58_VERSIONS = {
  0x00: ['bitcoin', 'p2pkh', ['bitcoin', 'bitcoin-cash (legacy format)', 'bitcoin-sv']],
  0x05: ['bitcoin', 'p2sh', ['bitcoin', 'bitcoin-cash (legacy format)', 'bitcoin-sv', 'litecoin (legacy p2sh)']],
  0x41: ['tron', 'tron', ['tron']],
  0x30: ['litecoin', 'p2pkh', ['litecoin']],
  0x32: ['litecoin', 'p2sh', ['litecoin']],
  0x1e: ['dogecoin', 'p2pkh', ['dogecoin', 'verge']],
  0x16: ['dogecoin', 'p2sh', ['dogecoin']],
  0x4c: ['dash', 'p2pkh', ['dash']],
  0x10: ['dash', 'p2sh', ['dash']],
  0x26: ['bitcoin-gold', 'p2pkh', ['bitcoin-gold']],
  0x17: ['bitcoin-gold', 'p2sh', ['bitcoin-gold']],
};
const BECH_HRP = { bc: 'bitcoin', tb: 'bitcoin-testnet', ltc: 'litecoin', bnb: 'bnb-beacon-chain' };
const EVM = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb-smart-chain', 'avalanche-c', 'ethereum-classic'];

/**
 * @returns {{ format: string, guess: string, candidates: string[], checksum_valid: boolean|null, checksum: string|null, checksum_address?: string, note?: string }}
 */
export function detectAddress(a) {
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    const v = eip55(a);
    return { format: 'evm-hex20', guess: 'evm', candidates: EVM, checksum: 'eip55', checksum_valid: v, checksum_address: toChecksumAddress(a), ...(v === null ? { note: 'All lower or upper case: EIP-55 checksum not present (valid format).' } : {}) };
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(a)) return { format: 'hex32', guess: 'unknown', candidates: ['aptos', 'sui', 'other 32-byte account or a transaction hash'], checksum: null, checksum_valid: null };
  if (/^(bitcoincash:)?[qp][0-9a-z]{41}$/i.test(a)) return { format: 'cashaddr', guess: 'bitcoin-cash', candidates: ['bitcoin-cash', 'ecash'], checksum: 'cashaddr', checksum_valid: cashaddrValid(a) };
  if (/^[a-z]{2,4}1[02-9ac-hj-np-z]{6,87}$/i.test(a)) {
    const d = bech32Decode(a); const hrp = a.toLowerCase().split('1')[0];
    return { format: d ? d.variant : 'bech32', guess: BECH_HRP[hrp] || 'unknown', candidates: BECH_HRP[hrp] ? [BECH_HRP[hrp]] : [], checksum: 'bech32', checksum_valid: !!d, ...(d && d.witnessVersion !== undefined && /^(bc|tb|ltc)$/.test(hrp) ? { note: `segwit v${d.witnessVersion}` } : {}) };
  }
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) {
    const p = base58Check(a, B58_XRP);
    if (p && p.length === 21 && p[0] === 0) return { format: 'xrp-base58check', guess: 'xrp', candidates: ['xrp'], checksum: 'base58check', checksum_valid: true };
  }
  if (/^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$/.test(a)) return { format: 'monero', guess: 'monero', candidates: ['monero'], checksum: null, checksum_valid: null, note: 'Monero address format; checksum not verified.' };
  if (/^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) { const p = base58Check(a); return { format: 'zcash-transparent', guess: 'zcash', candidates: ['zcash'], checksum: 'base58check', checksum_valid: !!(p && p.length === 22) }; }
  if (/^[1-9A-HJ-NP-Za-km-z]{25,44}$/.test(a)) {
    const p = base58Check(a);
    if (p && p.length === 21 && B58_VERSIONS[p[0]]) { const [guess, kind, candidates] = B58_VERSIONS[p[0]]; return { format: `base58check-${kind}`, guess, candidates, checksum: 'base58check', checksum_valid: true }; }
    const raw = base58Decode(a);
    if (raw && raw.length === 32 && !p) return { format: 'base58-32', guess: 'solana', candidates: ['solana'], checksum: null, checksum_valid: null, note: 'Solana addresses carry no checksum.' };
    const looks = /^(1|3)/.test(a) ? 'bitcoin' : /^T/.test(a) ? 'tron' : /^[LM]/.test(a) ? 'litecoin' : /^D/.test(a) ? 'dogecoin' : /^X/.test(a) ? 'dash' : 'unknown';
    return { format: 'base58', guess: looks, candidates: looks === 'unknown' ? [] : [looks], checksum: 'base58check', checksum_valid: false, note: 'base58 checksum does not verify (typo or unsupported format).' };
  }
  return { format: 'unknown', guess: 'unknown', candidates: [], checksum: null, checksum_valid: null };
}
