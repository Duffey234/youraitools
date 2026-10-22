// Minimal Solana helpers: base58 encode and associated token account (ATA) derivation (findProgramAddress), so the USDC
// token account can be read with plain getAccountInfo (indexed methods like getTokenAccountsByOwner need paid RPC keys).
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import { base58Decode } from './address.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
const onCurve = (b) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
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
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const ataOf = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findProgramAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ATA_PROGRAM);
