// Base58 (Solana alphabet), ed25519 on-curve test and program-derived addresses (no @solana/web3.js dependency).
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
export function base58Encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
/** true when the 32 bytes are a valid ed25519 point (a normal wallet key); PDAs (program-owned addresses) are off-curve. */
export function onCurve(b) { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } }
export function isOnCurveAddress(addr) { const b = base58Decode(addr); return !!b && b.length === 32 && onCurve(b); }
export function findProgramAddress(seeds, programId) {
  const pid = base58Decode(programId); const tag = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), pid, tag];
    const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    const h = sha256(buf);
    if (!onCurve(h)) return base58Encode(h);
  }
  throw new Error('no viable bump');
}
