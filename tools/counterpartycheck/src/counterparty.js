// CounterpartyCheck engine: pre-payment due diligence for one address (EVM on Base / Ethereum / Polygon / Arbitrum One, or Solana).
// Composes our own checks into one decision (ok / caution / block) with reasons and a confidence field:
//   lists (offline, every tier): OFAC SDN digital-currency addresses (PayGuard's bundled snapshot), ScamSniffer phishing addresses,
//     x402 Bazaar payTo directory (is it a known x402 payee?), well-known protocol labels, burn addresses.
//   on-chain (public RPCs, tight timeouts): EOA / contract / EIP-7702 delegated EOA, nonce, native + USDC balance, ERC-20 metadata,
//     Safe multisig owners/threshold, EIP-1967 proxy slots; quick adds Sourcify verification + deployer, ENS / Basename, cross-chain
//     presence, Blockscout labels; full adds age (archive k-ary search), recent activity and exposure, recent approvals to this
//     address and, for Base tokens, TokenVerdict's verdict. Solana: account type, USDC token account, recent signatures, age bound.
// Every optional source degrades on failure: it is listed in missing_data and lowers the confidence; a failed lookup never reads
// as a clean result. If the chain RPC itself is down the paid routes answer 503 (never charged).
import { keccak256, namehash, stringToBytes, concat } from 'viem';
import { screenAddress } from './screen.js';
import { SCAM_EVM, SCAM_OTHER, SCAM_META } from './data/scamsniffer.js';
import { X402_PAYEES, X402_META } from './data/x402-payees.js';
import { ataOf } from './solana.js';
import { base58Decode } from './address.js';
import { makeRpc, encAddr, asAddr, asUint, asString, word, isRevert, RpcError } from './rpc.js';
import { normalize as ensNormalize } from 'viem/ens';
import { withDeadline } from './deadline.js';
import { labelOf, isLabeled, OUR_PAYEES, LABELS } from './known.js';

export const ENGINE_VERSION = 'counterpartycheck-0.1.1';
export const DISCLAIMER = 'Automated pre-payment due-diligence signals from public lists and on-chain data at the time of the check. Not legal, compliance or financial advice, and not a guarantee: "ok" means no known risk signal was found, not that the counterparty is trustworthy.';
export const LIMITS = [
  'Sanctions: exact match against the digital-currency addresses in the OFAC SDN list only (bundled snapshot); OFAC also covers persons and property not listed by address.',
  'Scam list: ScamSniffer open-source phishing addresses (GPL-3.0), published with a 7-day delay; new drainers will not be on it yet.',
  'x402 directory: payTo addresses in a CDP Bazaar catalog snapshot; a listing is not an endorsement.',
  'Fail closed: if a check the verdict depends on (on-chain code / wallet detection, token-contract check, name resolution; plus verification and cross-chain on quick, age, activity and approvals on full) does not complete, it is listed in sources_failed and the verdict is at least caution with confidence low, never ok. Paid tiers then answer 503 (not charged) with the provisional verdict.',
  'Names: ENS .eth names resolve via the Ethereum ENS registry and .base.eth Basenames via the Base registry (default address record only; off-chain/CCIP names are not supported).',
  'Labels cover a small set of well-known protocol contracts plus Blockscout public tags when Blockscout answers.',
  'Age: first outgoing transaction (EOAs) or creation block (contracts) via public archive RPCs; receive-only addresses show no age.',
  'Activity, exposure and approvals use the most recent transactions and blocks only (not full history).',
  'Solana: account type, USDC token account and the last 1,000 signatures; no name service lookup.',
];
export class InputError extends Error { constructor(msg, status = 400, code = 'bad_request') { super(msg); this.status = status; this.code = code; } }
export class UpstreamError extends Error { constructor(msg) { super(msg); this.code = 'rpc_unavailable'; } }

const UA = 'CounterpartyCheck/0.1 (+https://api.youraitools.co/counterpartycheck)';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';
export const CHAINS = {
  base: { key: 'base', id: 8453, name: 'Base', caip2: 'eip155:8453', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://api.zan.top/base-mainnet', 'https://base.api.pocket.network', 'https://base-mainnet.public.blastapi.io', 'https://gateway.tenderly.co/public/base', 'https://1rpc.io/base'], archive: ['https://gateway.tenderly.co/public/base', 'https://base.drpc.org', 'https://base-mainnet.public.blastapi.io'], blockscout: 'https://base.blockscout.com', explorer: 'https://basescan.org/address/' },
  ethereum: { key: 'ethereum', id: 1, name: 'Ethereum', caip2: 'eip155:1', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://api.zan.top/eth-mainnet', 'https://eth.api.pocket.network', 'https://eth-mainnet.public.blastapi.io', 'https://gateway.tenderly.co/public/mainnet', 'https://eth-pokt.nodies.app', 'https://1rpc.io/eth'], archive: ['https://gateway.tenderly.co/public/mainnet', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://eth-mainnet.public.blastapi.io'], blockscout: 'https://eth.blockscout.com', explorer: 'https://etherscan.io/address/' },
  polygon: { key: 'polygon', id: 137, name: 'Polygon PoS', caip2: 'eip155:137', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://api.zan.top/polygon-mainnet', 'https://poly.api.pocket.network', 'https://gateway.tenderly.co/public/polygon', 'https://1rpc.io/matic'], archive: ['https://gateway.tenderly.co/public/polygon', 'https://polygon.drpc.org'], blockscout: 'https://polygon.blockscout.com', explorer: 'https://polygonscan.com/address/' },
  arbitrum: { key: 'arbitrum', id: 42161, name: 'Arbitrum One', caip2: 'eip155:42161', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://api.zan.top/arb-one', 'https://arb-one.api.pocket.network', 'https://arbitrum-one.public.blastapi.io', 'https://1rpc.io/arb'], archive: ['https://arbitrum-one.public.blastapi.io', 'https://arbitrum.drpc.org'], blockscout: 'https://arbitrum.blockscout.com', explorer: 'https://arbiscan.io/address/' },
  solana: { key: 'solana', name: 'Solana', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', rpcs: ['https://solana-rpc.publicnode.com', 'https://solana.api.pocket.network', 'https://public.rpc.solanavibestation.com', 'https://api.mainnet-beta.solana.com'], explorer: 'https://solscan.io/account/' },
};
export const EVM_CHAINS = ['base', 'ethereum', 'polygon', 'arbitrum'];
const ALIASES = { base: 'base', 'base-mainnet': 'base', 8453: 'base', 'eip155:8453': 'base', ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum', 1: 'ethereum', 'eip155:1': 'ethereum', polygon: 'polygon', matic: 'polygon', pol: 'polygon', 137: 'polygon', 'eip155:137': 'polygon', arbitrum: 'arbitrum', 'arbitrum-one': 'arbitrum', arb: 'arbitrum', 42161: 'arbitrum', 'eip155:42161': 'arbitrum', solana: 'solana', sol: 'solana', 'solana-mainnet': 'solana', 'solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp': 'solana' };
export const INTENTS = ['pay', 'approve', 'interact'];
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069']);
const SOL_BURN = new Set([SYSTEM, '1nc1nerator11111111111111111111111111111111']);
// EIP-1967 implementation / admin slots
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const ENS_REGISTRY = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const BASENAME_RESOLVER = '0xc6d566a56a1aff6508b41f6c90ff131615583bcd';
const BASENAME_REGISTRY = '0xb94704422c2a1e396835a571837aa5ae53285a95';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const SEL = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567', totalSupply: '0x18160ddd', balanceOf: '0x70a08231', owner: '0x8da5cb5b', getThreshold: '0xe75235b8', getOwners: '0xa0e67e2b', VERSION: '0xffa1ad74', resolver: '0x0178b8bf', nameOf: '0x691f3431', addr: '0x3b3b57de' };

/** Validate and normalize { address, chain, intent }. Throws InputError (400, never charged). */
export function normalizeInput(raw = {}) {
  if (typeof raw === 'string') raw = { address: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('send {"address": "0x... or a Solana address", "chain": "base", "intent": "pay"}');
  const a = raw.address ?? raw.counterparty ?? raw.wallet;
  if (typeof a !== 'string' || !a.trim()) throw new InputError('"address" is required: an EVM address (0x + 40 hex) or a Solana address (base58)');
  let s = a.trim().replace(/^(ethereum|solana):/i, '').split(/[?@/]/)[0];
  if (s.length > 255) throw new InputError('"address" is too long');
  let chainIn = raw.chain ?? raw.network;
  if (chainIn !== undefined && chainIn !== null && chainIn !== '' && typeof chainIn !== 'string' && typeof chainIn !== 'number') throw new InputError('"chain" must be a string');
  chainIn = chainIn === undefined || chainIn === null || chainIn === '' ? null : String(chainIn).trim().toLowerCase();
  const chain = chainIn ? ALIASES[chainIn] : null;
  if (chainIn && !chain) throw new InputError(`unsupported "chain" ${JSON.stringify(chainIn).slice(0, 40)}: use base, ethereum, polygon, arbitrum or solana`);
  const intent = raw.intent === undefined || raw.intent === null || raw.intent === '' ? 'pay' : String(raw.intent).toLowerCase();
  if (!INTENTS.includes(intent)) throw new InputError('"intent" must be pay, approve or interact');
  if (/\.eth$/i.test(s)) {
    // ENS name (.eth) or Basename (.base.eth): resolved on chain inside the check (tight timeout; a failed lookup is never "ok").
    if (chain === 'solana') throw new InputError('ENS names and Basenames resolve to EVM addresses; use chain base, ethereum, polygon or arbitrum');
    let name; try { name = ensNormalize(s); } catch { throw new InputError(`"${s.slice(0, 80)}" is not a valid ENS name`); }
    return { address: name, name, input: a.trim(), chain: chain || 'base', intent, family: 'evm' };
  }
  if (s.length > 64) throw new InputError('"address" is too long');
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    if (chain === 'solana') throw new InputError('an 0x address is not a Solana address; use chain base, ethereum, polygon or arbitrum');
    return { address: s.toLowerCase(), input: a.trim(), chain: chain || 'base', intent, family: 'evm' };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) {
    const b = base58Decode(s);
    if (b && b.length === 32) {
      if (chain && chain !== 'solana') throw new InputError(`a base58 address is a Solana address, not ${chain}`);
      return { address: s, input: a.trim(), chain: 'solana', intent, family: 'solana' };
    }
  }
  throw new InputError('"address" must be an EVM address (0x + 40 hex), an ENS name / Basename (e.g. vitalik.eth, jesse.base.eth) or a Solana address (32-byte base58)');
}

async function jget(fetchImpl, url, ms = 4000, init = {}, okStatus = []) {
  try {
    const res = await withDeadline(fetchImpl(url, { ...init, headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers || {}) } }), ms, url);
    if (!res.ok && !okStatus.includes(res.status)) return null;
    return await res.json();
  } catch { return null; }
}
const hexNum = (h) => (h && h !== '0x' ? Number(BigInt(h)) : 0);
const units = (big, dec) => (big == null ? null : Number(big) / 10 ** dec);
const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);

/** Offline list checks shared by every tier and the free preview. */
export function listChecks(address, family) {
  const sdn = screenAddress(address);
  const key = family === 'evm' ? address.toLowerCase() : address;
  // a well-known protocol contract is never reported as scam-listed (lists sometimes catch addresses phishing pages reference)
  const scam = (family === 'evm' ? SCAM_EVM.has(key) : SCAM_OTHER.has(key)) && !isLabeled(key);
  const p = X402_PAYEES[key];
  return {
    sanctions: { listed: !!sdn.sanctioned, matches: (sdn.matches || []).map((m) => ({ entity: m.entity, programs: m.programs, list_date: m.list_date, listed_as: m.listed_as })), source: 'US Treasury OFAC SDN (digital currency addresses)', list_updated_at: sdn.list_updated_at },
    scam_list: { listed: scam, source: SCAM_META.source, license: SCAM_META.license, updated_at: SCAM_META.updated_at, note: SCAM_META.delay },
    x402_directory: p ? { listed: true, resources: p[0], sample_hosts: p[1], hosts: p[2], networks: p[3], ours: !!OUR_PAYEES[key], source: X402_META.source, snapshot_at: X402_META.snapshot_at } : { listed: false, source: X402_META.source, snapshot_at: X402_META.snapshot_at },
  };
}
const listedAny = (a) => { if (!a) return null; const l = listChecks(a, /^0x/.test(a) ? 'evm' : 'solana'); return l.sanctions.listed ? 'sanctions' : l.scam_list.listed ? 'scam' : null; };

// ---------------- EVM ----------------
async function evmCore(rpc, a, chain) {
  const c = CHAINS[chain];
  const call = (data, to = a) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  const res = await rpc.batch([
    { method: 'eth_blockNumber', params: [] }, { method: 'eth_getCode', params: [a, 'latest'] }, { method: 'eth_getTransactionCount', params: [a, 'latest'] }, { method: 'eth_getBalance', params: [a, 'latest'] },
    call(SEL.balanceOf + encAddr(a), c.usdc), call(SEL.symbol), call(SEL.decimals), call(SEL.totalSupply), call(SEL.getThreshold), call(SEL.getOwners), call(SEL.owner),
    { method: 'eth_getStorageAt', params: [a, IMPL_SLOT, 'latest'] }, { method: 'eth_getStorageAt', params: [a, ADMIN_SLOT, 'latest'] },
  ]);
  if (res[0].error || res[1].error || res[2].error) throw new UpstreamError(`${c.name} RPC error`);
  const ok = (i) => (res[i].error ? null : res[i].result);
  const broken = (i) => !!res[i].error && !isRevert(res[i].error);
  const code = ok(1) || '0x';
  const delegated = /^0xef0100[0-9a-f]{40}$/i.test(code);
  const isContract = code !== '0x' && !delegated;
  const out = { head: hexNum(ok(0)), code_size: (code.length - 2) / 2, kind: delegated ? 'eip7702_delegated_eoa' : isContract ? 'contract' : 'eoa', nonce: hexNum(ok(2)), native_balance: r6(units(ok(3) ? BigInt(ok(3)) : null, 18)), usdc_balance: ok(4) && ok(4).length >= 66 ? r6(units(asUint(ok(4)), 6)) : null };
  if (delegated) out.delegate = '0x' + code.slice(8).toLowerCase();
  if (isContract) {
    // token detection decides "paying a token contract" (block); if those calls failed at the endpoint, the check is incomplete
    out.failed_calls = [...([5, 6, 7].some(broken) ? ['token_check'] : []), ...([8, 9].some(broken) ? ['safe_check'] : []), ...(broken(10) ? ['owner_check'] : [])];
    const sym = ok(5) ? asString(ok(5)) : null; const dec = ok(6) && ok(6).length >= 66 ? asUint(ok(6)) : null; const ts = ok(7) && ok(7).length >= 66 ? asUint(ok(7)) : null;
    if (sym && dec != null && dec <= 36n && ts != null) out.token = { symbol: sym, decimals: Number(dec), total_supply: r6(units(ts, Number(dec))) };
    const th = ok(8) && ok(8).length === 66 ? asUint(ok(8)) : null; const owners = ok(9) ? decodeAddrArray(ok(9)) : null;
    if (th != null && th > 0n && th < 100n && owners?.length) out.safe = { threshold: Number(th), owners };
    const own = ok(10) && ok(10).length === 66 ? asAddr(ok(10)) : null; if (own) out.owner = own;
    const impl = ok(11) ? asAddr(ok(11)) : null; const adm = ok(12) ? asAddr(ok(12)) : null;
    const nz = (x) => x && !/^0x0{40}$/.test(x);
    if (nz(impl)) out.proxy = { type: 'eip1967', implementation: impl, ...(nz(adm) ? { admin: adm } : {}) };
  }
  return out;
}
function decodeAddrArray(hex) {
  try { const h = hex.replace(/^0x/, ''); const off = Number(BigInt('0x' + h.slice(0, 64))) * 2; const n = Number(BigInt('0x' + h.slice(off, off + 64))); if (n > 50) return null; const out = []; for (let i = 0; i < n; i++) out.push('0x' + h.slice(off + 64 + i * 64 + 24, off + 128 + i * 64)); return out; } catch { return null; }
}
async function presence(rpc, a) {
  const r = await rpc.batch([{ method: 'eth_getCode', params: [a, 'latest'] }, { method: 'eth_getTransactionCount', params: [a, 'latest'] }, { method: 'eth_getBalance', params: [a, 'latest'] }]);
  if (r.some((x) => x.error)) return null;
  const code = r[0].result || '0x';
  return { kind: /^0xef0100/i.test(code) ? 'eip7702_delegated_eoa' : code !== '0x' ? 'contract' : 'eoa', nonce: hexNum(r[1].result), native_balance: r6(units(BigInt(r[2].result || '0x0'), 18)) };
}
async function sourcify(fetchImpl, chainId, a) {
  const j = await jget(fetchImpl, `https://sourcify.dev/server/v2/contract/${chainId}/${a}?fields=deployment,compilation.name,proxyResolution`, 4500, {}, [404]); // 404 + {match: null} = not verified (an answer, not a failure)
  if (!j) return { ok: false };
  if (!j.match) return { ok: true, verified: false };
  return { ok: true, verified: true, match: j.match, name: j.compilation?.name || null, deployer: j.deployment?.deployer?.toLowerCase() || null, creation_block: j.deployment?.blockNumber ? Number(j.deployment.blockNumber) : null, creation_tx: j.deployment?.transactionHash || null, proxy: j.proxyResolution?.isProxy ? { type: j.proxyResolution.proxyType, implementations: (j.proxyResolution.implementations || []).map((x) => ({ address: x.address?.toLowerCase(), name: x.name || null })) } : null };
}
const res1 = (r) => { if (r?.error && !isRevert(r.error)) throw new RpcError(String(r.error.message || 'rpc error')); return r?.result; };
const ZERO = /^0x0{40}$/;
/** Forward resolution: ENS name or Basename -> address. null = no on-chain address record; throws when the RPCs fail. */
export async function resolveName(fetchImpl, name) {
  const node = namehash(name);
  const onBase = /\.base\.eth$/.test(name);
  const rpc = makeRpc({ fetchImpl, urls: CHAINS[onBase ? 'base' : 'ethereum'].rpcs, ms: 2500 });
  const registry = onBase ? BASENAME_REGISTRY : ENS_REGISTRY;
  const [r] = await rpc.batch([{ method: 'eth_call', params: [{ to: registry, data: SEL.resolver + node.slice(2) }, 'latest'] }]);
  const v = res1(r); const resolver = v ? asAddr(v) : null;
  if (!resolver || ZERO.test(resolver)) return null;
  const [f] = await rpc.batch([{ method: 'eth_call', params: [{ to: resolver, data: SEL.addr + node.slice(2) }, 'latest'] }]);
  const w = res1(f); const addr = w ? asAddr(w) : null;
  if (!addr || ZERO.test(addr)) return null;
  return { address: addr.toLowerCase(), via: onBase ? 'Basename (Base L2 registry)' : 'ENS (Ethereum registry)', resolver };
}
const labelHash = (a) => keccak256(stringToBytes(a.toLowerCase().slice(2)));
async function ensName(rpc, a) {
  const node = namehash(`${a.toLowerCase().slice(2)}.addr.reverse`);
  const [r] = await rpc.batch([{ method: 'eth_call', params: [{ to: ENS_REGISTRY, data: SEL.resolver + node.slice(2) }, 'latest'] }]);
  const rv = res1(r); const res = rv ? asAddr(rv) : null;
  if (!res || /^0x0{40}$/.test(res)) return null;
  const [n] = await rpc.batch([{ method: 'eth_call', params: [{ to: res, data: SEL.nameOf + node.slice(2) }, 'latest'] }]);
  const nv = res1(n); const name = nv ? asString(nv) : null;
  if (!name) return null;
  return verifyForward(rpc, name, a, ENS_REGISTRY);
}
async function verifyForward(rpc, name, a, registry, fixedResolver) {
  let node; try { node = namehash(name); } catch { return null; }
  let res = fixedResolver;
  if (!res) { const [r] = await rpc.batch([{ method: 'eth_call', params: [{ to: registry, data: SEL.resolver + node.slice(2) }, 'latest'] }]); const rv = res1(r); res = rv ? asAddr(rv) : null; }
  if (!res || /^0x0{40}$/.test(res)) return { name, verified: false };
  const [f] = await rpc.batch([{ method: 'eth_call', params: [{ to: res, data: SEL.addr + node.slice(2) }, 'latest'] }]);
  const fv = res1(f); const fwd = fv ? asAddr(fv) : null;
  return { name, verified: !!fwd && fwd.toLowerCase() === a.toLowerCase() };
}
async function basename(rpc, a) {
  const node = keccak256(concat([namehash('80002105.reverse'), labelHash(a)]));
  const [n] = await rpc.batch([{ method: 'eth_call', params: [{ to: BASENAME_RESOLVER, data: SEL.nameOf + node.slice(2) }, 'latest'] }]);
  const nv = res1(n); const name = nv ? asString(nv) : null;
  if (!name) return null;
  return verifyForward(rpc, name, a, null, BASENAME_RESOLVER);
}
async function blockscout(fetchImpl, chain, a, { txs = false } = {}) {
  const b = CHAINS[chain].blockscout;
  const [info, counters, list] = await Promise.all([jget(fetchImpl, `${b}/api/v2/addresses/${a}`, 4000), jget(fetchImpl, `${b}/api/v2/addresses/${a}/counters`, 4000), txs ? jget(fetchImpl, `${b}/api/v2/addresses/${a}/transactions`, 5000) : null]);
  if (!info) return { ok: false };
  const tags = [...(info.public_tags || []).map((t) => t.display_name || t.label), ...((info.metadata?.tags || []).map((t) => t.name))].filter(Boolean).slice(0, 8);
  const out = { ok: true, is_scam: !!info.is_scam, reputation: info.reputation || null, name: info.name || null, tags, ens: info.ens_domain_name || null, creator: info.creator_address_hash?.toLowerCase() || null, verified: info.is_verified ?? null, tx_count: counters ? Number(counters.transactions_count || 0) : null, token_transfer_count: counters ? Number(counters.token_transfers_count || 0) : null };
  if (txs) {
    if (!list?.items) out.txs_ok = false;
    else {
      out.txs_ok = true;
      const items = list.items.slice(0, 50);
      out.recent = { count: items.length, last_at: items[0]?.timestamp || null, oldest_in_page_at: items[items.length - 1]?.timestamp || null, failed: items.filter((t) => t.status && t.status !== 'ok').length };
      const cps = new Set(); for (const t of items) for (const x of [t.from?.hash, t.to?.hash]) if (x && x.toLowerCase() !== a) cps.add(x.toLowerCase());
      out.recent.counterparties = cps.size;
      out.recent.listed_counterparties = [...cps].map((x) => ({ address: x, list: listedAny(x) })).filter((x) => x.list).slice(0, 10);
    }
  }
  return out;
}
export async function kSearch(rpcArchive, head, probe) {
  // smallest block b in (0, head] with probe(b) true, assuming monotonic; batched 16-way search, best effort
  let lo = 0, hi = head;
  for (let round = 0; round < 9 && hi - lo > 1; round++) {
    const step = Math.max(1, Math.ceil((hi - lo) / 16)); const pts = []; for (let b = lo + step; b < hi; b += step) pts.push(b);
    if (!pts.length) break;
    const res = await rpcArchive.batch(pts.map((b) => probe.call(b)));
    if (res.some((r) => r.error)) return null;
    const idx = res.findIndex((r) => probe.test(r.result));
    if (idx === -1) lo = pts[pts.length - 1]; else { hi = pts[idx]; if (idx > 0) lo = pts[idx - 1]; }
  }
  return hi;
}
export async function evmAge(rpcArchive, a, core, knownBlock) {
  let block = knownBlock || null; let basis;
  if (core.kind === 'contract') { basis = 'contract creation block'; if (!block) block = await kSearch(rpcArchive, core.head, { call: (b) => ({ method: 'eth_getCode', params: [a, '0x' + b.toString(16)] }), test: (r) => r && r !== '0x' }); }
  else if (core.nonce > 0) { basis = 'first outgoing transaction (nonce)'; block = await kSearch(rpcArchive, core.head, { call: (b) => ({ method: 'eth_getTransactionCount', params: [a, '0x' + b.toString(16)] }), test: (r) => r && BigInt(r) > 0n }); }
  else return { known: false, basis: 'no outgoing transactions (receive-only or unused): age not determined' };
  if (!block) return null;
  const [b] = await rpcArchive.batch([{ method: 'eth_getBlockByNumber', params: ['0x' + block.toString(16), false] }]);
  const ts = b.result?.timestamp ? Number(BigInt(b.result.timestamp)) * 1000 : null;
  return ts ? { known: true, block, at: new Date(ts).toISOString(), basis } : null;
}
async function recentApprovals(rpc, a, head, span) {
  const r = await rpc.batch([{ method: 'eth_getLogs', params: [{ fromBlock: '0x' + Math.max(0, head - span).toString(16), toBlock: '0x' + head.toString(16), topics: [APPROVAL_TOPIC, null, '0x' + encAddr(a)] }] }]);
  if (r[0].error || !Array.isArray(r[0].result)) return null;
  const owners = new Set(r[0].result.map((l) => l.topics?.[1]).filter(Boolean)); const tokens = new Set(r[0].result.map((l) => l.address?.toLowerCase()));
  return { blocks: span, approvals: r[0].result.length, distinct_owners: owners.size, distinct_tokens: tokens.size };
}

/** Fallback when Blockscout is unavailable: USDC transfers in or out over the most recent blocks (public RPC logs, chunked). */
async function recentUsdc(rpc, a, head, chain, chunks = 5, span = 2000) {
  const t = '0x' + encAddr(a); const usdc = CHAINS[chain].usdc; const calls = [];
  for (let i = 0; i < chunks; i++) {
    const to = head - i * span; const from = Math.max(0, to - span + 1);
    const range = { address: usdc, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
    calls.push({ method: 'eth_getLogs', params: [{ ...range, topics: [TRANSFER_TOPIC, t] }] }, { method: 'eth_getLogs', params: [{ ...range, topics: [TRANSFER_TOPIC, null, t] }] });
  }
  const res = await rpc.batch(calls);
  if (res.some((r) => r.error || !Array.isArray(r.result))) return null;
  const logs = res.flatMap((r) => r.result);
  const cps = new Set(); let inn = 0, out = 0, last = 0;
  for (const l of logs) { const from = '0x' + l.topics[1].slice(26); const to = '0x' + l.topics[2].slice(26); if (from === a) { out++; cps.add(to); } else { inn++; cps.add(from); } last = Math.max(last, Number(BigInt(l.blockNumber))); }
  return { source: `USDC transfers in the last ${chunks * span} blocks (public RPC logs)`, blocks: chunks * span, usdc_transfers_in: inn, usdc_transfers_out: out, counterparties: cps.size, last_block: last || null, listed_counterparties: [...cps].map((x) => ({ address: x, list: listedAny(x) })).filter((x) => x.list).slice(0, 10) };
}

// ---------------- Solana ----------------
async function solRpc(fetchImpl, chainUrls, method, params, ms = 4500) {
  const errs = [];
  for (const u of chainUrls) {
    const host = new URL(u).host;
    try {
      const res = await withDeadline(fetchImpl(u, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), ms, `solana ${method}`);
      if (!res.ok) { errs.push(`${host} HTTP ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) { errs.push(`${host}: ${String(j.error.message).slice(0, 60)}`); continue; }
      return j.result;
    } catch (e) { errs.push(`${host}: ${String(e?.message || e).slice(0, 60)}`); }
  }
  throw new UpstreamError(`Solana RPC unavailable (${errs.join('; ')})`);
}
async function solanaCore(fetchImpl, a) {
  const urls = CHAINS.solana.rpcs;
  // One getMultipleAccounts call: the account itself plus its derived USDC associated token account (no indexed/paid RPC methods).
  let ataAddr = null; try { ataAddr = ataOf(a, SOLANA_USDC); } catch {}
  const res = await solRpc(fetchImpl, urls, 'getMultipleAccounts', [ataAddr ? [a, ataAddr] : [a], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const info = { value: res?.value?.[0] ?? null }; const ataAcct = ataAddr ? (res?.value?.[1] ?? null) : undefined;
  const v = info?.value;
  const out = { exists: !!v, sol_balance: v ? r6(v.lamports / 1e9) : 0, owner_program: v?.owner || null, executable: !!v?.executable };
  if (!v) out.kind = 'unused_account';
  else if (v.executable) out.kind = 'program';
  else if (v.owner === SYSTEM) out.kind = 'wallet';
  else if (v.owner === SPL_TOKEN || v.owner === SPL_TOKEN_2022) {
    const t = v.data?.parsed?.type;
    if (t === 'mint') { out.kind = 'token_mint'; out.mint = { decimals: v.data.parsed.info?.decimals, supply: v.data.parsed.info?.supply, mint_authority: v.data.parsed.info?.mintAuthority || null, freeze_authority: v.data.parsed.info?.freezeAuthority || null }; }
    else if (t === 'account') { out.kind = 'token_account'; out.token_account = { owner: v.data.parsed.info?.owner, mint: v.data.parsed.info?.mint, amount: v.data.parsed.info?.tokenAmount?.uiAmount ?? null }; }
    else out.kind = 'token_program_account';
  } else out.kind = 'program_owned_account';
  if (ataAcct === undefined) out.usdc = null;
  else out.usdc = { token_account: ataAddr, token_accounts: ataAcct ? 1 : 0, balance: ataAcct ? (ataAcct.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0) : 0 };
  return out;
}
async function solanaActivity(fetchImpl, a, pages = 1) {
  const urls = CHAINS.solana.rpcs; let before; let all = [];
  for (let p = 0; p < pages; p++) {
    const r = await solRpc(fetchImpl, urls, 'getSignaturesForAddress', [a, { limit: 1000, ...(before ? { before } : {}) }], 6000);
    all = all.concat(r || []); if (!r || r.length < 1000) break; before = r[r.length - 1].signature;
  }
  const t = (x) => (x?.blockTime ? new Date(x.blockTime * 1000).toISOString() : null);
  return { signatures: all.length, capped: all.length >= 1000 * pages, last_at: t(all[0]), oldest_seen_at: t(all[all.length - 1]), failed: all.filter((x) => x.err).length };
}

// ---------------- verdict ----------------
const SEV = { danger: 3, warn: 2, info: 1, good: 0 };
function decide(reasons) {
  const d = reasons.some((r) => r.severity === 'danger'); const w = reasons.some((r) => r.severity === 'warn');
  return d ? 'block' : w ? 'caution' : 'ok';
}
const DAY = 86400000;

/**
 * @param {{address:string, chain:string, intent:string, family:string}} input normalized (normalizeInput)
 * @param {{tier?: 'preview'|'lite'|'quick'|'full', fetchImpl?: Function, now?: number, tokenVerdict?: (token) => Promise<object|null>}} [o]
 */
export async function checkCounterparty(input, { tier = 'full', fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now(), tokenVerdict } = {}) {
  const { chain, intent, family } = input;
  let a = input.address;
  const C = CHAINS[chain];
  // failed = checks this tier's verdict depends on that did not complete. Any entry turns "ok" into "caution" with
  // confidence "low" (fail closed): a missing answer is never read as "clean". missing = everything not obtained.
  const reasons = []; const missing = []; const sources = {}; const failed = [];
  const add = (severity, code, text) => reasons.push({ severity, code, text });
  const crit = (name) => { if (!failed.includes(name)) failed.push(name); if (!missing.includes(name)) missing.push(name); };
  let resolved = null;
  if (input.name) {
    try { resolved = await withDeadline(resolveName(fetchImpl, input.name), 6000, 'name resolution'); sources.name_resolution = 'ok'; }
    catch (e) { sources.name_resolution = 'failed'; sources.rpc_error = String(e?.message || e).slice(0, 160); crit('name_resolution'); }
    if (sources.name_resolution === 'ok' && !resolved) throw new InputError(`"${input.name}" has no on-chain address record (ENS on Ethereum, or Basenames on Base; off-chain/CCIP names are not supported). Send the 0x address instead.`);
    if (!resolved) {
      add('warn', 'checks_incomplete', `Could not resolve ${input.name} (name lookup failed): nothing was checked. Retry, or send the 0x address.`);
      return finish({ a: null, C, intent, tier, family, input, reasons, missing, sources, failed, facts: { kind: 'unknown' }, checks: { name: { name: input.name, resolved: null } }, now });
    }
    a = resolved.address;
  }
  const lists = listChecks(a, family);
  sources.lists = 'ok';
  const checks = { ...lists };
  if (resolved) checks.name = { name: input.name, resolved: resolved.address, via: resolved.via };
  const label = family === 'evm' ? labelOf(C.id, a) : null;
  if (lists.sanctions.listed) add('danger', 'ofac_sdn', `Listed on the US Treasury OFAC SDN list (${lists.sanctions.matches.map((m) => `${m.entity}, ${m.programs.join('/')}`).join('; ')}). Do not pay or interact.`);
  if (lists.scam_list.listed) add('danger', 'scam_listed', 'Listed as a phishing / scam address in the ScamSniffer database.');
  if ((family === 'evm' ? BURN : SOL_BURN).has(a)) add('danger', 'burn_address', 'This is a burn / null address: anything sent here is lost.');
  if (label) { checks.label = label; add('good', 'known_label', `Known address: ${label}.`); }
  if (lists.x402_directory.listed) add('good', 'x402_payee', `Known x402 payee: receives payments for ${lists.x402_directory.resources} listed resource(s) on ${lists.x402_directory.hosts} host(s) (${lists.x402_directory.sample_hosts.join(', ')}) in the CDP x402 Bazaar.`);

  let facts;
  try {
    if (family === 'evm') facts = await evmChecks({ a, chain, intent, tier, fetchImpl, now, add, reasons, missing, sources, checks, tokenVerdict, crit });
    else facts = await solanaChecks({ a, intent, tier, fetchImpl, now, add, missing, sources, checks, crit });
  } catch (e) { // never let an unexpected error read as "no signal"
    crit('engine'); sources.rpc_error = sources.rpc_error || String(e?.message || e).slice(0, 160); facts = facts || { kind: 'unknown' };
  }
  if (failed.length) add('warn', 'checks_incomplete', `Required check(s) did not complete: ${failed.join(', ')}. The verdict is not final (fail closed): retry before relying on it.`);
  return finish({ a, C, intent, tier, family, input, reasons, missing, sources, failed, facts, checks, now });
}

function finish({ a, C, intent, tier, family, input, reasons, missing, sources, failed, facts, checks, now }) {
  reasons.sort((x, y) => SEV[y.severity] - SEV[x.severity]);
  const verdict = decide(reasons); // a failed required check adds a warn, so the floor is "caution", never "ok"
  const confidence = failed.length || sources.rpc !== 'ok' ? 'low' : missing.length === 0 ? 'high' : missing.length <= 2 ? 'medium' : 'low';
  const top = reasons.find((r) => r.severity === 'danger' || r.severity === 'warn');
  const summary = verdict === 'block' ? `BLOCK: ${top.text}` : verdict === 'caution' ? `CAUTION: ${top.text}` : `OK: no risk signal found for this ${facts.kind?.replace(/_/g, ' ') || 'address'} on ${C.name}${reasons.some((r) => r.severity === 'good') ? ` (${reasons.filter((r) => r.severity === 'good').map((r) => r.code.replace(/_/g, ' ')).join(', ')})` : ''}.`;
  return {
    address: a, ...(input.name ? { name: input.name } : {}), chain: C.key, chain_id: C.caip2, intent, tier, verdict, confidence, summary, reasons, facts, checks, sources, sources_failed: failed, missing_data: missing,
    explorer: a ? C.explorer + a : null, limits: LIMITS, disclaimer: DISCLAIMER, checked_at: new Date(now).toISOString(), engine: ENGINE_VERSION,
  };
}

async function evmChecks({ a, chain, intent, tier, fetchImpl, now, add, reasons, missing, sources, checks, tokenVerdict, crit }) {
  const C = CHAINS[chain];
  const preview = tier === 'preview';
  const rpc = makeRpc({ fetchImpl, urls: C.rpcs, ms: 2500 });
  let core;
  try { core = await withDeadline(evmCore(rpc, a, chain), 10000, `${C.name} RPC`); sources.rpc = 'ok'; } catch (e) { sources.rpc = 'failed'; sources.rpc_error = String(e?.message || e).slice(0, 160); crit('onchain'); return { kind: 'unknown' }; }
  for (const f of core.failed_calls || []) if (f === 'token_check' || !preview && tier !== 'lite') crit(f);
  const facts = { kind: core.kind, nonce: core.nonce, native_balance: core.native_balance, usdc_balance: core.usdc_balance, code_size: core.code_size };
  if (core.delegate) facts.delegate = core.delegate;
  if (core.token) facts.token = core.token;
  if (core.safe) facts.safe = core.safe;
  if (core.owner) facts.owner = core.owner;
  if (core.proxy) facts.proxy = core.proxy;
  const unused = core.kind === 'eoa' && core.nonce === 0 && !core.native_balance && !core.usdc_balance;
  // Static wrong-chain trap (every tier): a well-known contract address from another chain that has no code here,
  // e.g. Base's USDC contract address on Polygon (an EOA nobody controls that holds mistakenly sent funds).
  if (core.kind === 'eoa') {
    const elsewhere = Object.entries(CHAINS).filter(([k, x]) => k !== chain && x.id).map(([, x]) => [x, LABELS[x.id]?.[a]]).find(([, l]) => l);
    if (elsewhere) add(intent === 'pay' ? 'danger' : 'warn', 'wrong_chain_contract', `This is the address of ${elsewhere[1]} on ${elsewhere[0].name}, but on ${C.name} it has no code: funds sent here are very likely unrecoverable.`);
  }
  // intent-specific on-chain signals (lite and up)
  if (core.token && intent === 'pay') add('danger', 'token_contract', `This is the ${core.token.symbol} token contract itself, not a wallet: tokens sent to a token contract are usually lost.`);
  else if (core.token) add('info', 'token_contract', `ERC-20 token contract (${core.token.symbol}).`);
  if (core.kind === 'eoa' && intent === 'approve') add('warn', 'approve_eoa', 'Approval spender is a plain wallet (EOA), not a contract: approving an EOA lets that person move your tokens directly, a common drainer pattern.');
  if (unused && intent === 'pay') add('warn', 'no_history', `Unused address on ${C.name}: no transactions, no ETH and no USDC. Double-check it (typo, address poisoning or wrong chain) before paying.`);
  if (core.kind === 'eip7702_delegated_eoa') add('info', 'eip7702', `EOA with an EIP-7702 delegation to ${core.delegate}: its code is the delegate contract.`);
  if (core.safe) add('good', 'safe_multisig', `Safe multisig, ${core.safe.threshold}-of-${core.safe.owners.length} owners.`);
  if (core.proxy && intent !== 'pay') add('info', 'upgradeable', `Upgradeable proxy (EIP-1967): its logic can be changed by the admin${core.proxy.admin ? ` ${core.proxy.admin}` : ''}.`);
  if (!unused && core.kind === 'eoa' && core.nonce > 0) add('good', 'active', `Active wallet: ${core.nonce} outgoing transaction(s) on ${C.name}.`);
  if (preview || tier === 'lite') {
    if (core.kind === 'contract' && intent !== 'interact' && !core.token && !core.safe) add('info', 'contract', 'Contract address: make sure it is meant to receive this payment (lite tier does not check verification).');
    return facts;
  }

  // ---- quick ----
  const others = EVM_CHAINS.filter((k) => k !== chain);
  const isCode = core.kind === 'contract';
  const target = core.kind === 'eip7702_delegated_eoa' ? core.delegate : isCode ? a : null;
  const eth = makeRpc({ fetchImpl, urls: CHAINS.ethereum.rpcs, ms: 3500 }); const baseRpc = chain === 'base' ? rpc : makeRpc({ fetchImpl, urls: CHAINS.base.rpcs, ms: 3500 });
  const tasks = {
    src: target ? sourcify(fetchImpl, C.id, target) : Promise.resolve(null),
    cross: Promise.all(others.map((k) => withDeadline(presence(makeRpc({ fetchImpl, urls: CHAINS[k].rpcs, ms: 3500 }), a), 5000, k).then((p) => [k, p]).catch(() => [k, null]))),
    ens: withDeadline(ensName(eth, a), 5000, 'ens').then((x) => ({ ok: true, v: x })).catch(() => ({ ok: false })),
    basename: withDeadline(basename(baseRpc, a), 5000, 'basename').then((x) => ({ ok: true, v: x })).catch(() => ({ ok: false })),
    bs: withDeadline(blockscout(fetchImpl, chain, a, { txs: tier === 'full' }), 7000, 'blockscout').catch(() => ({ ok: false })),
  };
  if (tier === 'full') {
    const archive = makeRpc({ fetchImpl, urls: C.archive, ms: 4000 });
    tasks.approvals = isCode ? withDeadline(recentApprovals(rpc, a, core.head, chain === 'ethereum' ? 1000 : 2000), 6000, 'approvals').catch(() => null) : Promise.resolve('n/a');
    tasks.age = tasks.src.then((s) => withDeadline(evmAge(archive, a, core, isCode && s?.creation_block ? s.creation_block : null), 10000, 'age')).catch(() => null);
    tasks.usdcAct = withDeadline(recentUsdc(makeRpc({ fetchImpl, urls: C.rpcs, ms: 5000 }), a, core.head, chain), 7000, 'usdc activity').catch(() => null);
    tasks.tv = core.token && chain === 'base' && tokenVerdict ? withDeadline(tokenVerdict(a), 9000, 'tokenverdict').catch(() => null) : Promise.resolve('n/a');
  }
  const keys = Object.keys(tasks); const vals = await Promise.all(Object.values(tasks)); const T = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));

  // contract verification + deployer
  if (target) {
    let s = T.src;
    // EIP-1967 proxies (e.g. smart wallets) are usually unverified shells: judge the implementation's source instead
    if (s?.ok && !s.verified && core.proxy?.implementation) {
      const im = await withDeadline(sourcify(fetchImpl, C.id, core.proxy.implementation), 5000, 'sourcify impl').catch(() => ({ ok: false }));
      s = im.ok ? { ...s, verified: im.verified, name: im.name ? `${im.name} via EIP-1967 proxy` : 'EIP-1967 proxy implementation', via_implementation: core.proxy.implementation } : im;
    }
    if (!s?.ok) { crit('sourcify'); sources.sourcify = 'failed'; }
    else {
      sources.sourcify = 'ok';
      checks.contract = { address: target, verified: s.verified, name: s.name || null, deployer: s.deployer || null, creation_block: s.creation_block || null, proxy: s.proxy || null };
      const who = core.kind === 'eip7702_delegated_eoa' ? 'Delegate contract' : 'Contract';
      if (s.verified) add('good', 'verified', `${who} source verified on Sourcify${s.name ? ` (${s.name})` : ''}.`);
      else if (core.kind === 'eip7702_delegated_eoa') add('warn', 'unverified_delegate', 'EIP-7702 delegate contract is not verified on Sourcify: whoever controls that code controls this wallet.');
      else if (!core.token && !core.safe && intent !== 'interact') add('warn', 'unverified_contract', 'Unverified contract (no Sourcify match): you cannot see what it does with funds it receives.');
      if (s.deployer) { const l = listedAny(s.deployer); if (l) add('danger', 'deployer_listed', `Deployer ${s.deployer} is on the ${l === 'sanctions' ? 'OFAC SDN list' : 'ScamSniffer scam list'}.`); }
    }
  }
  if (core.kind === 'eip7702_delegated_eoa') { const l = listedAny(core.delegate); if (l) add('danger', 'delegate_listed', `EIP-7702 delegate ${core.delegate} is on the ${l === 'sanctions' ? 'OFAC SDN list' : 'ScamSniffer scam list'}.`); }
  if (core.safe) { const bad = core.safe.owners.map((o) => [o, listedAny(o)]).filter((x) => x[1]); if (bad.length) add('danger', 'safe_owner_listed', `Safe owner(s) on a sanctions or scam list: ${bad.map((x) => x[0]).join(', ')}.`); }
  if (core.owner) { const l = listedAny(core.owner); if (l) add('danger', 'owner_listed', `Contract owner ${core.owner} is on the ${l === 'sanctions' ? 'OFAC SDN list' : 'ScamSniffer scam list'}.`); }
  // cross-chain presence (wrong-chain protection)
  const cross = Object.fromEntries(T.cross); checks.cross_chain = cross;
  if (T.cross.every(([, p]) => p === null)) crit('cross_chain');
  else if (T.cross.some(([, p]) => p === null)) missing.push(`cross_chain:${T.cross.filter(([, p]) => p === null).map(([k]) => k).join(',')}`);
  const codeElsewhere = T.cross.filter(([, p]) => p && p.kind === 'contract').map(([k]) => CHAINS[k].name);
  const activeElsewhere = T.cross.filter(([, p]) => p && (p.nonce > 0 || p.native_balance > 0 || p.kind !== 'eoa')).map(([k]) => CHAINS[k].name);
  if (core.kind === 'eoa' && codeElsewhere.length && intent === 'pay') add('warn', 'wrong_chain', `This address is a contract on ${codeElsewhere.join(', ')} but has no code on ${C.name}. If it is a smart wallet or Safe, it may not exist here yet; funds sent on the wrong chain can be unrecoverable.`);
  else if (unused && activeElsewhere.length) {
    // A plain EOA is the same key on every EVM chain, so "unused here, active elsewhere" is not a typo/poisoning signal.
    const nh = reasons.find((r) => r.code === 'no_history');
    if (nh && !codeElsewhere.length) { nh.severity = 'info'; nh.text = `No activity on ${C.name} yet, but this plain wallet (same key on every EVM chain) is active on ${activeElsewhere.join(', ')}.`; }
    add('info', 'active_elsewhere', `No activity on ${C.name}, but active on ${activeElsewhere.join(', ')}: check you are on the intended chain.`);
  }
  // names
  checks.identity = {};
  if (!T.ens.ok) missing.push('ens'); else { checks.identity.ens = T.ens.v; if (T.ens.v?.verified) add('good', 'ens', `ENS name ${T.ens.v.name} (reverse record, forward-verified).`); }
  if (!T.basename.ok) missing.push('basename'); else { checks.identity.basename = T.basename.v; if (T.basename.v?.verified) add('good', 'basename', `Basename ${T.basename.v.name} (forward-verified).`); }
  // Blockscout (best effort)
  const bs = T.bs;
  if (!bs?.ok) { sources.blockscout = 'unavailable'; }
  else {
    sources.blockscout = 'ok';
    checks.blockscout = { is_scam: bs.is_scam, reputation: bs.reputation, name: bs.name, tags: bs.tags, tx_count: bs.tx_count, token_transfer_count: bs.token_transfer_count, creator: bs.creator };
    if (bs.is_scam || bs.reputation === 'scam') add('danger', 'explorer_scam', `Flagged as scam on ${C.name} Blockscout.`);
    if (bs.tags.length) add('info', 'explorer_tags', `Explorer tags: ${bs.tags.join(', ')}.`);
    if (!checks.identity.ens && bs.ens) checks.identity.explorer_name = bs.ens;
    if (bs.creator && !checks.contract?.deployer) { const l = listedAny(bs.creator); if (l) add('danger', 'deployer_listed', `Creator ${bs.creator} is on the ${l === 'sanctions' ? 'OFAC SDN list' : 'ScamSniffer scam list'}.`); }
  }
  if (tier !== 'full') return facts;

  // ---- full ----
  if (T.age === null) crit('age');
  else {
    checks.age = T.age;
    if (T.age.known) {
      const d = Math.floor((now - Date.parse(T.age.at)) / DAY); checks.age.days = d;
      if (d < 7) add(checks.x402_directory.listed ? 'info' : 'warn', 'new_address', `New: ${T.age.basis} only ${d} day(s) ago (${T.age.at.slice(0, 10)}).${checks.x402_directory.listed ? ' Listed as an x402 payee, so a new address is expected for a new service.' : ' Fresh addresses are common in scams and address-poisoning attacks.'}`);
      else if (d >= 180) add('good', 'established', `Established: ${T.age.basis} ${d} days ago (${T.age.at.slice(0, 10)}).`);
      else add('info', 'age', `${T.age.basis} ${d} days ago (${T.age.at.slice(0, 10)}).`);
    }
  }
  if (bs?.ok && bs.txs_ok) {
    checks.activity = bs.recent;
    if (bs.recent.listed_counterparties.length) add('warn', 'exposure', `Recent transactions with ${bs.recent.listed_counterparties.length} sanctioned or scam-listed address(es): ${bs.recent.listed_counterparties.map((x) => `${x.address} (${x.list})`).join(', ')}.`);
    if (bs.recent.last_at) { const d = Math.floor((now - Date.parse(bs.recent.last_at)) / DAY); checks.activity.last_days_ago = d; }
  }
  if (T.usdcAct) {
    checks.usdc_activity = T.usdcAct;
    const seen = new Set((checks.activity?.listed_counterparties || []).map((x) => x.address));
    const extra = T.usdcAct.listed_counterparties.filter((x) => !seen.has(x.address));
    if (extra.length) add('warn', 'exposure', `Recent USDC transfers with ${extra.length} sanctioned or scam-listed address(es): ${extra.map((x) => `${x.address} (${x.list})`).join(', ')}.`);
  }
  if (!(bs?.ok && bs.txs_ok) && !T.usdcAct) crit('activity');
  if (T.approvals !== 'n/a') {
    if (!T.approvals) crit('approvals');
    else {
      checks.approvals = T.approvals;
      const unverified = checks.contract && checks.contract.verified === false;
      if (unverified && T.approvals.distinct_owners >= 5) add('warn', 'approval_magnet', `Unverified contract that ${T.approvals.distinct_owners} different wallets approved to spend their tokens in the last ${T.approvals.blocks} blocks: a common drainer pattern.`);
      else if (T.approvals.distinct_owners) add('info', 'approvals', `${T.approvals.distinct_owners} wallet(s) approved this address to spend tokens in the last ${T.approvals.blocks} blocks.`);
    }
  }
  if (T.tv !== 'n/a') {
    if (!T.tv) missing.push('tokenverdict');
    else {
      checks.token = { tokenverdict: { verdict: T.tv.verdict, score: T.tv.score, confidence: T.tv.confidence, report: T.tv.full?.quick || null } };
      if (T.tv.verdict === 'DANGER') add(intent === 'interact' ? 'danger' : 'warn', 'token_danger', `TokenVerdict rates this token DANGER (${T.tv.score}/100).`);
      else if (T.tv.verdict === 'CAUTION') add('info', 'token_caution', `TokenVerdict rates this token CAUTION (${T.tv.score}/100).`);
    }
  }
  return facts;
}

async function solanaChecks({ a, intent, tier, fetchImpl, now, add, missing, sources, checks, crit }) {
  let core;
  try { core = await withDeadline(solanaCore(fetchImpl, a), 10000, 'Solana RPC'); sources.rpc = 'ok'; } catch (e) { sources.rpc = 'failed'; sources.rpc_error = String(e?.message || e).slice(0, 160); crit('onchain'); return { kind: 'unknown' }; }
  const facts = { kind: core.kind, sol_balance: core.sol_balance, owner_program: core.owner_program, usdc: core.usdc };
  if (core.mint) facts.mint = core.mint;
  if (core.token_account) facts.token_account = core.token_account;
  if (core.usdc === null) missing.push('usdc_token_account');
  if (core.kind === 'token_mint' && intent === 'pay') add('danger', 'token_mint', 'This is a token mint address, not a wallet: payments to a mint are lost.');
  else if (core.kind === 'token_mint') add('info', 'token_mint', 'SPL token mint.');
  if (core.kind === 'program' && intent === 'pay') add('danger', 'program_address', 'This is an executable program, not a wallet: payments to it are usually lost.');
  if (core.kind === 'token_account') {
    const isUsdc = core.token_account.mint === SOLANA_USDC;
    add(intent === 'pay' && !isUsdc ? 'warn' : 'info', 'token_account', `This is a token account (mint ${core.token_account.mint}${isUsdc ? ', USDC' : ''}) owned by ${core.token_account.owner}, not a wallet address.${isUsdc ? '' : ' Paying USDC to it will fail.'}`);
    const l = listedAny(core.token_account.owner); if (l) add('danger', 'owner_listed', `Token account owner ${core.token_account.owner} is on the ${l === 'sanctions' ? 'OFAC SDN list' : 'ScamSniffer scam list'}.`);
  }
  if (core.kind === 'unused_account' && intent === 'pay') add('warn', 'no_history', 'Unused Solana address: no SOL and no account data. Double-check it (typo or address poisoning) before paying.');
  if (core.kind === 'wallet' && core.usdc && core.usdc.token_accounts === 0 && intent === 'pay') add('warn', 'no_usdc_account', 'Wallet has no USDC token account yet: x402 USDC payments to it fail until one exists (a plain transfer would have to create it).');
  if (core.kind === 'wallet' && core.usdc?.token_accounts) add('good', 'usdc_ready', `Wallet can receive USDC (has a USDC token account${core.usdc.balance ? `, ${r6(core.usdc.balance)} USDC` : ''}).`);
  if (tier === 'preview' || tier === 'lite') return facts;
  let act;
  try { act = await withDeadline(solanaActivity(fetchImpl, a, tier === 'full' ? 3 : 1), tier === 'full' ? 12000 : 7000, 'signatures'); } catch { act = null; }
  if (!act) { if (tier === 'full') { crit('activity'); crit('age'); } else missing.push('activity'); }
  else {
    checks.activity = { ...act };
    if (act.last_at) checks.activity.last_days_ago = Math.floor((now - Date.parse(act.last_at)) / DAY);
    if (act.signatures > 0 && core.kind === 'wallet') add('good', 'active', `${act.capped ? `${act.signatures}+` : act.signatures} transaction signature(s)${act.last_at ? `, last ${act.last_at.slice(0, 10)}` : ''}.`);
    if (tier === 'full' && act.oldest_seen_at) {
      const d = Math.floor((now - Date.parse(act.oldest_seen_at)) / DAY);
      checks.age = { known: !act.capped, at: act.oldest_seen_at, days: d, basis: act.capped ? `oldest of the last ${act.signatures} signatures (lower bound)` : 'first transaction signature' };
      if (!act.capped && d < 7) add(checks.x402_directory?.listed ? 'info' : 'warn', 'new_address', `New: first transaction only ${d} day(s) ago (${act.oldest_seen_at.slice(0, 10)}).${checks.x402_directory?.listed ? ' Listed as an x402 payee, so a new address is expected for a new service.' : ''}`);
      else if (d >= 180) add('good', 'established', `Established: ${act.capped ? 'at least ' : ''}${d} days of history.`);
    } else if (tier === 'full') missing.push('age');
  }
  return facts;
}

/** Signal categories shown in the free preview (names only; the evidence is on the paid tiers). */
export const CATEGORY = { ofac_sdn: 'sanctions_list_match', scam_listed: 'scam_list_match', explorer_scam: 'scam_flag', burn_address: 'burn_address', token_contract: 'not_a_wallet', token_mint: 'not_a_wallet', program_address: 'not_a_wallet', token_account: 'not_a_wallet', no_history: 'unused_address', no_usdc_account: 'cannot_receive_usdc', approve_eoa: 'eoa_spender', wrong_chain: 'wrong_chain', wrong_chain_contract: 'wrong_chain', unverified_contract: 'unverified_contract', unverified_delegate: 'unverified_contract', deployer_listed: 'listed_deployer', delegate_listed: 'listed_delegate', safe_owner_listed: 'listed_owner', owner_listed: 'listed_owner', new_address: 'new_address', exposure: 'listed_counterparty_exposure', approval_magnet: 'approval_magnet', token_danger: 'token_danger', checks_incomplete: 'checks_incomplete' };
export function previewView(r) {
  const n = (s) => r.reasons.filter((x) => x.severity === s).length;
  const signals = [...new Set(r.reasons.filter((x) => x.severity === 'danger' || x.severity === 'warn').map((x) => CATEGORY[x.code] || x.code))];
  return { address: r.address, ...(r.name ? { name: r.name } : {}), chain: r.chain, intent: r.intent, tier: 'preview', verdict: r.verdict, confidence: r.confidence, kind: r.facts?.kind || 'unknown', flags: { danger: n('danger'), warn: n('warn'), good: n('good') }, signals, sources_failed: r.sources_failed || [], x402_payee: !!r.checks.x402_directory?.listed, ...(r.sources?.rpc_error ? { degraded: r.sources.rpc_error } : {}), disclaimer: r.disclaimer, engine: r.engine, checked_at: r.checked_at };
}
