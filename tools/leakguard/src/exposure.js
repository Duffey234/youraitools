// Leaked-wallet exposure check (deep tier, /v1/scan). For every wallet key LeakGuard finds, derive the PUBLIC address it
// controls and look up native + USDC balances and activity on Base, Ethereum, Polygon PoS, Arbitrum One and Solana, so the
// caller knows whether funds are at risk right now. Keys never leave this function: only public addresses are returned,
// nothing is logged or stored.
//   * EVM private key (hex)      -> secp256k1 address
//   * BIP39 seed phrase (valid checksum, empty passphrase) -> EVM m/44'/60'/0'/0/{0,1,2} and Solana m/44'/501'/0'/0', m/44'/501'/0'
//   * Solana secret key (64 bytes, JSON array or base58) -> its public key (checked: the seed must derive the stored pubkey)
//   * WIF / xprv / PEM keys      -> reported as "not_checked" (rotate anyway)
// Fail-closed: a chain whose RPCs all fail or time out is listed in sources_failed and the address can only be
// "funds_at_risk" (a balance was seen elsewhere) or "unknown", never "no_funds_found".
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { sha512, sha256 } from '@noble/hashes/sha2';
import { HDKey } from '@scure/bip32';
import { withDeadline } from './deadline.js';

export const EVM_CHAINS = {
  base: { name: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rpcs: ['https://base-rpc.publicnode.com', 'https://base-mainnet.public.blastapi.io', 'https://gateway.tenderly.co/public/base', 'https://base.meowrpc.com', 'https://api.zan.top/base-mainnet'] },
  ethereum: { name: 'Ethereum', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet', 'https://eth-mainnet.public.blastapi.io', 'https://eth.meowrpc.com'] },
  polygon: { name: 'Polygon PoS', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://poly.api.pocket.network', 'https://gateway.tenderly.co/public/polygon'] },
  arbitrum: { name: 'Arbitrum One', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum-one.public.blastapi.io', 'https://api.zan.top/arb-one'] },
};
export const SOLANA = { name: 'Solana', usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', rpcs: ['https://solana-rpc.publicnode.com', 'https://public.rpc.solanavibestation.com', 'https://solana.api.pocket.network'] };
export const LIMITS = { maxAddresses: 8, rpcMs: 3000, rpcAttempts: 3, totalMs: 9500 };
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ---------- encoding helpers ----------
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
export function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return new Uint8Array(out);
}
export function toChecksum(addrHex) {
  const a = addrHex.toLowerCase().replace(/^0x/, ''); const h = hex(keccak_256(new TextEncoder().encode(a)));
  return '0x' + [...a].map((ch, i) => (parseInt(h[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('');
}
export function evmAddressFromPriv(priv) {
  const pub = secp256k1.getPublicKey(priv, false);
  return toChecksum(hex(keccak_256(pub.slice(1)).slice(-20)));
}
async function bip39Seed(mnemonic, passphrase = '') {
  const enc = new TextEncoder(); const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', enc.encode(mnemonic.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: enc.encode(('mnemonic' + passphrase).normalize('NFKD')), iterations: 2048 }, key, 512);
  return new Uint8Array(bits);
}
function slip10Ed25519(seed, path) { // hardened-only SLIP-0010 derivation
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let k = I.slice(0, 32), c = I.slice(32);
  for (const seg of path.split('/').slice(1)) {
    const idx = (parseInt(seg, 10) | 0) + 0x80000000;
    const data = new Uint8Array(37); data.set(k, 1); new DataView(data.buffer).setUint32(33, idx >>> 0);
    I = hmac(sha512, c, data); k = I.slice(0, 32); c = I.slice(32);
  }
  return k;
}

/** Public addresses controlled by the wallet keys among `findings` (findings carry start/end into `text`). */
export async function deriveAddresses(text, findings) {
  const out = []; const notChecked = [];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]; if (f.category !== 'wallet_key') continue;
    const v = text.slice(f.start, f.end);
    try {
      if (f.type === 'evm_private_key') {
        const h = v.replace(/^0x/i, ''); const n = BigInt('0x' + h);
        if (n === 0n || n >= SECP_N) { notChecked.push({ finding: i, type: f.type, reason: 'not a valid secp256k1 key' }); continue; }
        out.push({ finding: i, type: f.type, family: 'evm', address: evmAddressFromPriv(fromHex(h.toLowerCase())) });
      } else if (f.type === 'bip39_mnemonic') {
        if (!/checksum ok/.test(f.validator || '')) { notChecked.push({ finding: i, type: f.type, reason: 'checksum not valid, no addresses derived' }); continue; }
        const words = v.toLowerCase().match(/[a-z]+/g).join(' ');
        const seed = await bip39Seed(words);
        const root = HDKey.fromMasterSeed(seed);
        for (let j = 0; j < 3; j++) out.push({ finding: i, type: f.type, family: 'evm', path: `m/44'/60'/0'/0/${j}`, address: evmAddressFromPriv(root.derive(`m/44'/60'/0'/0/${j}`).privateKey) });
        for (const p of ["m/44'/501'/0'/0'", "m/44'/501'/0'"]) out.push({ finding: i, type: f.type, family: 'solana', path: p, address: b58encode(ed25519.getPublicKey(slip10Ed25519(seed, p))) });
      } else if (f.type === 'solana_secret_key' || f.type === 'solana_secret_key_b58') {
        const bytes = f.type === 'solana_secret_key' ? Uint8Array.from(v.slice(1, -1).split(',').map((x) => Number(x.trim()))) : b58decode(v);
        if (!bytes || bytes.length !== 64) { notChecked.push({ finding: i, type: f.type, reason: 'not 64 bytes' }); continue; }
        const pub = ed25519.getPublicKey(bytes.slice(0, 32));
        if (hex(pub) !== hex(bytes.slice(32))) { notChecked.push({ finding: i, type: f.type, reason: 'bytes are not an ed25519 keypair (may not be a Solana key)' }); continue; }
        out.push({ finding: i, type: f.type, family: 'solana', address: b58encode(pub) });
      } else notChecked.push({ finding: i, type: f.type, reason: 'balance lookup not supported for this key type; rotate it anyway' });
    } catch { notChecked.push({ finding: i, type: f.type, reason: 'could not derive an address' }); }
  }
  // de-duplicate addresses, cap the count
  const seen = new Set(); const uniq = [];
  for (const a of out) { const k = a.address.toLowerCase(); if (seen.has(k)) continue; seen.add(k); uniq.push(a); }
  const capped = uniq.slice(0, LIMITS.maxAddresses);
  for (const a of uniq.slice(LIMITS.maxAddresses)) notChecked.push({ finding: a.finding, type: a.type, address: a.address, reason: `more than ${LIMITS.maxAddresses} addresses; not checked` });
  return { addresses: capped, not_checked: notChecked };
}

// ---------- balance lookups (JSON-RPC batch, 2 RPC attempts per chain) ----------
async function rpcBatch(fetchImpl, urls, calls, ms) {
  let lastErr = 'no rpc';
  for (const url of urls.slice(0, LIMITS.rpcAttempts)) {
    try {
      const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c[0], params: c[1] }));
      const r = await withDeadline(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ms, `rpc ${new URL(url).host}`);
      if (!r.ok) { lastErr = `${new URL(url).host} http ${r.status}`; continue; }
      const j = await r.json();
      if (!Array.isArray(j)) { lastErr = `${new URL(url).host} no batch`; continue; }
      const byId = new Map(j.map((x) => [x.id, x]));
      if (calls.some((_, i) => !byId.get(i) || byId.get(i).error || byId.get(i).result === undefined)) { lastErr = `${new URL(url).host} rpc error`; continue; }
      return { ok: true, results: calls.map((_, i) => byId.get(i).result), source: new URL(url).host };
    } catch (e) { lastErr = String(e?.message || e).slice(0, 80); }
  }
  return { ok: false, error: lastErr };
}
const units = (raw, dec) => { const n = BigInt(raw); const s = n.toString().padStart(dec + 1, '0'); const w = s.slice(0, -dec), f = s.slice(-dec).replace(/0+$/, ''); return f ? `${w}.${f}` : w; };

async function evmChain(fetchImpl, key, addrs) {
  const ch = EVM_CHAINS[key]; const calls = [];
  for (const a of addrs) {
    calls.push(['eth_getBalance', [a, 'latest']]);
    calls.push(['eth_getTransactionCount', [a, 'latest']]);
    calls.push(['eth_call', [{ to: ch.usdc, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']]);
  }
  const r = await rpcBatch(fetchImpl, ch.rpcs, calls, LIMITS.rpcMs);
  if (!r.ok) return { ok: false, error: r.error };
  const per = {};
  addrs.forEach((a, i) => {
    const [bal, nonce, usdc] = r.results.slice(i * 3, i * 3 + 3);
    const usdcRaw = usdc && usdc !== '0x' ? BigInt(usdc) : 0n;
    per[a] = { native: units(BigInt(bal), 18), usdc: units(usdcRaw, 6), tx_count: Number(BigInt(nonce)), funded: BigInt(bal) > 0n || usdcRaw > 0n };
  });
  return { ok: true, per, source: r.source };
}
// Solana: one non-indexed getMultipleAccounts call (owners + their USDC associated token accounts). Indexed methods
// (getTokenAccountsByOwner, getSignaturesForAddress) are refused or incomplete on free RPCs, so tx history is not checked.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const onCurve = (b) => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
export function findPda(seeds, programId) {
  const tail = [b58decode(programId), new TextEncoder().encode('ProgramDerivedAddress')];
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), ...tail]; const buf = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0; for (const x of parts) { buf.set(x, o); o += x.length; }
    const h = sha256(buf); if (!onCurve(h)) return b58encode(h);
  }
  return null;
}
export const usdcAta = (owner) => findPda([b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(SOLANA.usdcMint)], ATA_PROGRAM);
async function rpcOne(fetchImpl, urls, method, params, ms) {
  let lastErr = 'no rpc';
  for (const url of urls.slice(0, LIMITS.rpcAttempts)) {
    try {
      const r = await withDeadline(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), ms, `rpc ${new URL(url).host}`);
      if (!r.ok) { lastErr = `${new URL(url).host} http ${r.status}`; continue; }
      const j = await r.json();
      if (j?.error || j?.result === undefined) { lastErr = `${new URL(url).host} rpc error`; continue; }
      return { ok: true, result: j.result, source: new URL(url).host };
    } catch (e) { lastErr = String(e?.message || e).slice(0, 80); }
  }
  return { ok: false, error: lastErr };
}
async function solanaChain(fetchImpl, addrs) {
  const atas = addrs.map(usdcAta);
  const r = await rpcOne(fetchImpl, SOLANA.rpcs, 'getMultipleAccounts', [[...addrs, ...atas], { encoding: 'jsonParsed', commitment: 'confirmed' }], LIMITS.rpcMs);
  if (!r.ok) return { ok: false, error: r.error };
  const v = r.result?.value;
  if (!Array.isArray(v) || v.length !== addrs.length * 2) return { ok: false, error: `${r.source} bad response` };
  const per = {};
  addrs.forEach((a, i) => {
    const lamports = BigInt(v[i]?.lamports ?? 0);
    const info = v[addrs.length + i]?.data?.parsed?.info;
    const usdcRaw = info && info.mint === SOLANA.usdcMint && info.owner === a ? BigInt(info.tokenAmount?.amount || 0) : 0n;
    per[a] = { native: units(lamports, 9), usdc: units(usdcRaw, 6), tx_count: null, funded: lamports > 0n || usdcRaw > 0n };
  });
  return { ok: true, per, source: r.source };
}

const RANK = { funds_at_risk: 4, unknown: 3, used_empty: 2, no_funds_found: 1 };
/** Exposure report for already-derived addresses ({ addresses, not_checked } from deriveAddresses). Never throws; fail-closed. */
export async function checkExposure({ addresses, not_checked = [] }, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (!addresses.length) return { status: not_checked.length ? 'not_checked' : 'not_applicable', addresses: [], not_checked, sources_failed: [], chains_checked: [] };
  const evm = addresses.filter((a) => a.family === 'evm').map((a) => a.address);
  const sol = addresses.filter((a) => a.family === 'solana').map((a) => a.address);
  const jobs = [];
  if (evm.length) for (const k of Object.keys(EVM_CHAINS)) jobs.push([k, evmChain(fetchImpl, k, evm)]);
  if (sol.length) jobs.push(['solana', solanaChain(fetchImpl, sol)]);
  const settled = await Promise.all(jobs.map(([k, p]) => withDeadline(p, LIMITS.totalMs, k).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 80) })).then((r) => [k, r])));
  const res = Object.fromEntries(settled); const sources_failed = settled.filter(([, r]) => !r.ok).map(([k, r]) => `${k}: ${r.error}`);
  const out = addresses.map((a) => {
    const chains = a.family === 'evm' ? Object.keys(EVM_CHAINS) : ['solana'];
    const balances = {}; const failed = [];
    for (const k of chains) { if (res[k]?.ok) balances[k] = res[k].per[a.address]; else failed.push(k); }
    const vals = Object.values(balances);
    const funded = vals.some((b) => b.funded); const used = vals.some((b) => b.tx_count && b.tx_count !== 0);
    const status = funded ? 'funds_at_risk' : failed.length ? 'unknown' : used ? 'used_empty' : 'no_funds_found';
    return { ...a, status, balances, ...(failed.length ? { chains_failed: failed } : {}) };
  });
  const status = out.reduce((m, a) => (RANK[a.status] > RANK[m] ? a.status : m), 'no_funds_found');
  return { status, addresses: out, not_checked, sources_failed, chains_checked: settled.filter(([, r]) => r.ok).map(([k]) => k) };
}
