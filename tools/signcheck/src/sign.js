// SignCheck engine: decode a transaction, an EIP-712 typed-data signature request, an EIP-7702 authorization or an x402
// payment (402 terms + the payload about to be signed) into plain English and flag what can drain a wallet.
//   tier 'preview' : offline only (decode, static flags, OFAC SDN match, verdict).
//   tier 'lite'    : offline, full output (reasons, decoded args, counterparties, x402 match, SDN); no RPC.
//   tier 'full'    : + on-chain facts on Base / Ethereum / Base Sepolia (EOA vs contract, token symbol/decimals,
//                    eth_call simulation with revert reason, 4-byte lookup for unknown functions), human amounts, args.
// Read-only: it never signs, sends or stores anything.
import { decodeFunctionData, parseAbi, getAddress, isAddress } from 'viem';
import { CHAINS, CHAIN_ALIASES, PERMIT2, USDC, labelOf, tokenOf } from './known.js';
import { SDN_EVM, SDN_META } from './data/sdn-evm.js';
import { withDeadline } from './deadline.js';

export const ENGINE_VERSION = 'signcheck-0.1';
export const DISCLAIMER = 'Informational pre-sign check from public data and static rules, not a security guarantee or financial advice. A SAFE verdict means no known-bad pattern was found; always confirm the counterparty yourself.';
export const SEVERITY = { info: 0, low: 5, medium: 15, high: 35, critical: 60 };
export const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86400;

export class InputError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; this.code = 'bad_request'; } }

// ---------- function signatures ----------
const SIGS = [
  ['erc20_transfer', 'function transfer(address to, uint256 amount)'],
  ['erc20_approve', 'function approve(address spender, uint256 amount)'],
  ['transfer_from', 'function transferFrom(address from, address to, uint256 amount)'],
  ['increase_allowance', 'function increaseAllowance(address spender, uint256 addedValue)'],
  ['decrease_allowance', 'function decreaseAllowance(address spender, uint256 subtractedValue)'],
  ['set_approval_for_all', 'function setApprovalForAll(address operator, bool approved)'],
  ['nft_safe_transfer', 'function safeTransferFrom(address from, address to, uint256 tokenId)'],
  ['nft_safe_transfer', 'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)'],
  ['erc1155_transfer', 'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)'],
  ['erc1155_batch_transfer', 'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)'],
  ['erc2612_permit', 'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)'],
  ['permit2_approve', 'function approve(address token, address spender, uint160 amount, uint48 expiration)'],
  ['permit2_permit', 'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)'],
  ['eip3009_transfer', 'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)'],
  ['eip3009_transfer', 'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)'],
  ['eip3009_receive', 'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)'],
  ['multicall', 'function multicall(bytes[] data)'],
  ['multicall', 'function multicall(uint256 deadline, bytes[] data)'],
  ['multicall3', 'function aggregate3((address target, bool allowFailure, bytes callData)[] calls)'],
  ['safe_exec', 'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)'],
  ['transfer_ownership', 'function transferOwnership(address newOwner)'],
  ['renounce_ownership', 'function renounceOwnership()'],
  ['upgrade', 'function upgradeTo(address newImplementation)'],
  ['upgrade', 'function upgradeToAndCall(address newImplementation, bytes data)'],
  ['grant_role', 'function grantRole(bytes32 role, address account)'],
  ['weth_deposit', 'function deposit()'],
  ['weth_withdraw', 'function withdraw(uint256 amount)'],
];
const ABIS = SIGS.map(([action, sig]) => ({ action, abi: parseAbi([sig]), sig: sig.replace(/^function /, '') }));
export const KNOWN_SELECTOR_COUNT = ABIS.length;

/** Decode calldata against the built-in signatures: { action, fn, args } or null. Tries every candidate (same selector). */
export function decodeCall(data) {
  if (!data || data === '0x') return { action: 'native_transfer', fn: null, args: {} };
  for (const { action, abi, sig } of ABIS) {
    try {
      const r = decodeFunctionData({ abi, data });
      const inputs = abi[0].inputs; const args = {};
      inputs.forEach((inp, i) => { args[inp.name || `arg${i}`] = r.args?.[i]; });
      return { action, fn: sig, args };
    } catch { /* next */ }
  }
  return null;
}

// ---------- helpers ----------
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);
const short = (a) => (a && a.length === 42 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a));
const big = (v) => { try { if (typeof v === 'bigint') return v; if (typeof v === 'number') return BigInt(Math.trunc(v)); if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim())) return BigInt(v.trim()); } catch { /* fallthrough */ } return null; };
function fmtUnits(v, decimals) {
  if (v === null || v === undefined || decimals === null || decimals === undefined) return null;
  const d = BigInt(decimals); const neg = v < 0n; const x = neg ? -v : v; const base = 10n ** d;
  const whole = x / base; let frac = (x % base).toString().padStart(Number(d), '0').replace(/0+$/, '');
  if (frac.length > 6) frac = frac.slice(0, 6).replace(/0+$/, '');
  if (whole === 0n && !frac && x > 0n) return `${neg ? '-' : ''}<0.000001`;
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}
const isUnlimited = (v, max = MAX_UINT256) => v !== null && (v >= max / 2n || v >= (1n << 128n));
export const sdnMatch = (a) => { const m = SDN_EVM[lc(a)]; return m ? { entity: m[0], programs: m[1] ? m[1].split(',') : [], list_date: m[2] || null } : null; };

/** Parse JSON or base64(JSON) (x402 headers); returns the object or throws InputError. */
export function parseMaybe(v, what) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') throw new InputError(`"${what}" must be an object, JSON string or base64 header value`);
  const s = v.trim();
  try { return JSON.parse(s); } catch { /* maybe base64 */ }
  try { const t = typeof atob === 'function' ? atob(s.replace(/-/g, '+').replace(/_/g, '/')) : Buffer.from(s, 'base64').toString('utf8'); return JSON.parse(t); } catch { /* no */ }
  throw new InputError(`"${what}" is not valid JSON or base64-encoded JSON`);
}

function resolveChain(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return Number(v);
  const k = String(v).trim().toLowerCase();
  if (CHAIN_ALIASES[k]) return CHAIN_ALIASES[k];
  const m = /^eip155:(\d+)$/.exec(k); if (m) return Number(m[1]);
  throw new InputError(`unknown chain "${v}"; use base, ethereum, base-sepolia or a numeric chain id`);
}

/**
 * Validate and normalize the request (no network). Throws InputError (HTTP 400, never charged).
 * Accepts { chain?, tx?: {to, data?, value?, from?, chainId?, authorizationList?}, typed_data?, authorization?, payment_required?, payment_payload?, from? }
 */
export function normalizeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('body must be a JSON object, e.g. {"tx": {"to": "0x…", "data": "0x…"}} or {"typed_data": {…}}');
  const out = { kind: null };
  let chainId = resolveChain(body.chain ?? body.chain_id ?? body.chainId);
  const pr = parseMaybe(body.payment_required ?? body.paymentRequired ?? body.x402_requirements, 'payment_required');
  const pp = parseMaybe(body.payment_payload ?? body.paymentPayload ?? body.x402_payment, 'payment_payload');
  const td = parseMaybe(body.typed_data ?? body.typedData ?? body.eip712, 'typed_data');
  const tx = parseMaybe(body.tx ?? body.transaction, 'tx');
  const auth = parseMaybe(body.authorization ?? body.eip7702, 'authorization');
  const given = [tx && 'tx', td && 'typed_data', auth && 'authorization', (pr || pp) && 'payment_required/payment_payload'].filter(Boolean);
  if (!given.length) throw new InputError('nothing to check: send one of "tx", "typed_data", "authorization" or "payment_required" (+ "payment_payload")');
  if (given.length > 1 && !(given.length === 2 && td && (pr || pp))) throw new InputError(`send only one of tx / typed_data / authorization / payment_required (got ${given.join(', ')}); typed_data may be combined with payment_required`);
  if (pr) out.requirements = pickRequirements(pr);
  if (pp) out.payload = pp;
  if (tx) {
    if (typeof tx !== 'object' || Array.isArray(tx)) throw new InputError('"tx" must be an object {"to": "0x…", "data": "0x…", "value": "0", "from": "0x…"}');
    if (!isAddress(String(tx.to || ''), { strict: false })) throw new InputError('"tx.to" must be a 0x address (contract creation is not supported)');
    const data = tx.data ?? tx.input ?? '0x';
    if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new InputError('"tx.data" must be 0x-prefixed hex with an even length');
    if (data.length > 200002) throw new InputError('"tx.data" is larger than 100 KB');
    const value = tx.value === undefined || tx.value === null || tx.value === '' ? 0n : big(tx.value);
    if (value === null || value < 0n) throw new InputError('"tx.value" must be a non-negative integer in wei (decimal or 0x hex)');
    const from = tx.from ?? body.from;
    if (from !== undefined && from !== null && !isAddress(String(from), { strict: false })) throw new InputError('"tx.from" must be a 0x address');
    if (chainId === null && tx.chainId !== undefined) chainId = resolveChain(big(tx.chainId)?.toString() ?? tx.chainId);
    if (tx.authorizationList !== undefined && !Array.isArray(tx.authorizationList)) throw new InputError('"tx.authorizationList" must be an array');
    Object.assign(out, { kind: 'transaction', tx: { to: tx.to, data: data.toLowerCase(), value, from: from || null, authorizationList: tx.authorizationList || [] } });
  } else if (auth) {
    if (!isAddress(String(auth.address || auth.contractAddress || ''), { strict: false })) throw new InputError('"authorization.address" (the delegate contract) must be a 0x address');
    Object.assign(out, { kind: 'eip7702_authorization', authorization: { address: auth.address || auth.contractAddress, chainId: big(auth.chainId ?? auth.chain_id ?? 0) ?? 0n, nonce: big(auth.nonce ?? 0) } });
  } else if (td) {
    validateTyped(td);
    Object.assign(out, { kind: 'typed_data', typed: td });
    if (chainId === null && td.domain?.chainId !== undefined) chainId = Number(big(td.domain.chainId) ?? NaN) || null;
  } else {
    // x402 only: rebuild the EIP-3009 typed data from the payload + requirements
    if (!out.requirements) throw new InputError('"payment_required" is needed with "payment_payload" (the 402 terms you are paying)');
    Object.assign(out, { kind: 'x402_payment' });
  }
  if (out.requirements && chainId === null) { const m = /^eip155:(\d+)$/.exec(out.requirements.network || ''); if (m) chainId = Number(m[1]); else if (out.requirements.network) chainId = CHAIN_ALIASES[String(out.requirements.network).toLowerCase()] ?? null; }
  out.chainId = chainId ?? 8453;
  return out;
}

function validateTyped(td) {
  if (!td || typeof td !== 'object' || Array.isArray(td)) throw new InputError('"typed_data" must be an EIP-712 object {domain, types, primaryType, message}');
  if (!td.message || typeof td.message !== 'object') throw new InputError('"typed_data.message" is required');
  if (typeof td.primaryType !== 'string' || !td.primaryType) throw new InputError('"typed_data.primaryType" is required');
  if (JSON.stringify(td).length > 100000) throw new InputError('"typed_data" is larger than 100 KB');
}

/** payment_required may be the full 402 body/header ({accepts:[…]}) or one requirements object. */
function pickRequirements(pr) {
  const list = Array.isArray(pr?.accepts) ? pr.accepts : Array.isArray(pr) ? pr : [pr];
  const evm = list.filter((r) => r && typeof r === 'object' && (r.scheme === 'exact' || !r.scheme) && (/^eip155:/.test(r.network || '') || CHAIN_ALIASES[String(r.network || '').toLowerCase()]));
  const r = evm[0] || list[0];
  if (!r || typeof r !== 'object' || !r.payTo) throw new InputError('"payment_required" has no EVM "exact" requirements with a payTo');
  return { ...r, amount: String(r.amount ?? r.maxAmountRequired ?? ''), _alternatives: list.length };
}

// ---------- analysis ----------
class Report {
  constructor(chainId) { this.flags = []; this.parties = new Map(); this.chainId = chainId; }
  flag(code, severity, message) { if (!this.flags.some((f) => f.code === code && f.message === message)) this.flags.push({ code, severity, message }); }
  party(address, role) {
    if (!address || !isAddress(String(address), { strict: false })) return;
    const k = lc(address); const p = this.parties.get(k) || { address: safeChecksum(address), roles: [], label: labelOf(this.chainId, k) };
    if (!p.roles.includes(role)) p.roles.push(role);
    this.parties.set(k, p);
  }
}
const safeChecksum = (a) => { try { return getAddress(a); } catch { return a; } };

function tokenFmt(chainId, token, v, meta) {
  const t = meta?.[lc(token)] || (tokenOf(chainId, token) ? { symbol: tokenOf(chainId, token)[0], decimals: tokenOf(chainId, token)[1] } : null);
  if (v === null || v === undefined) return { text: 'an amount', symbol: t?.symbol || null };
  if (isUnlimited(v)) return { text: `UNLIMITED ${t?.symbol || 'tokens'}`, symbol: t?.symbol || null, unlimited: true };
  if (t && t.decimals !== null && t.decimals !== undefined) return { text: `${fmtUnits(v, t.decimals)} ${t.symbol || ''}`.trim(), human: fmtUnits(v, t.decimals), symbol: t.symbol };
  return { text: `${v.toString()} base units of ${short(token)}`, symbol: null };
}

/** Analyse one decoded call (recurses into multicall / Safe). Returns a summary sentence. */
function analyzeCall(rep, { to, data, value, from }, depth, ctx) {
  const chainId = rep.chainId; const now = ctx.now;
  rep.party(to, depth ? 'inner_call_target' : 'to');
  const d = decodeCall(data);
  const native = value && value > 0n ? `${fmtUnits(value, 18)} ${CHAINS[chainId]?.native || 'native coin'}` : null;
  if (!d) {
    const sel = data.slice(0, 10);
    ctx.unknownSelectors.add(sel);
    rep.flag('UNKNOWN_FUNCTION', 'medium', `Calls an unrecognised function ${sel} on ${short(to)}${labelOf(chainId, to) ? ` (${labelOf(chainId, to)})` : ''}; its effect cannot be decoded offline.`);
    if (native) rep.flag('VALUE_TO_UNKNOWN_CALL', 'medium', `Sends ${native} together with an undecoded call.`);
    return { action: 'unknown_call', summary: `Call ${sel} on ${short(to)}${native ? ` sending ${native}` : ''}`, selector: sel };
  }
  const a = d.args; let summary; const tok = to;
  ctx.decoded.push({ depth, to: safeChecksum(to), function: d.fn, action: d.action, args: jsonable(a) });
  switch (d.action) {
    case 'native_transfer': {
      summary = native ? `Send ${native} to ${short(to)}` : `Empty call to ${short(to)} (no data, no value)`;
      if (!native) rep.flag('EMPTY_CALL', 'low', 'The transaction has no data and no value: it does nothing except spend gas.');
      ctx.checkCode.push({ address: to, role: 'native_recipient' });
      break;
    }
    case 'erc20_transfer': {
      const f = tokenFmt(chainId, tok, a.amount, ctx.tokenMeta); ctx.tokens.add(lc(tok));
      summary = `Transfer ${f.text} to ${short(a.to)}`; rep.party(a.to, 'recipient');
      if (lc(a.to) === ZERO) rep.flag('BURN_TO_ZERO', 'critical', 'Recipient is the zero address: the tokens are destroyed.');
      if (lc(a.to) === lc(tok)) rep.flag('SENT_TO_TOKEN_CONTRACT', 'high', 'Recipient is the token contract itself: tokens sent there are usually lost forever.');
      ctx.checkCode.push({ address: tok, role: 'token', expectContract: true });
      break;
    }
    case 'transfer_from': {
      const f = tokenFmt(chainId, tok, a.amount, ctx.tokenMeta); ctx.tokens.add(lc(tok));
      summary = `Move ${f.text} (or NFT #${a.amount}) from ${short(a.from)} to ${short(a.to)}`; rep.party(a.from, 'source'); rep.party(a.to, 'recipient');
      if (from && lc(a.from) === lc(from)) rep.flag('TRANSFER_FROM_SELF', 'low', 'transferFrom pulls from your own address; a plain transfer is usual.');
      if (lc(a.to) === ZERO) rep.flag('BURN_TO_ZERO', 'critical', 'Recipient is the zero address: the assets are destroyed.');
      break;
    }
    case 'erc20_approve': case 'increase_allowance': {
      const amt = a.amount ?? a.addedValue; const f = tokenFmt(chainId, tok, amt, ctx.tokenMeta); ctx.tokens.add(lc(tok));
      summary = `${d.action === 'erc20_approve' ? 'Approve' : 'Increase the allowance of'} ${short(a.spender)}${labelOf(chainId, a.spender) ? ` (${labelOf(chainId, a.spender)})` : ''} to spend ${f.text} from your wallet`;
      rep.party(a.spender, 'spender'); ctx.spenders.push({ address: a.spender, unlimited: f.unlimited, kind: 'token allowance' });
      if (lc(a.spender) === ZERO) rep.flag('APPROVE_ZERO_ADDRESS', 'low', 'Spender is the zero address (often used to clear an NFT approval).');
      if (f.unlimited) rep.flag('UNLIMITED_APPROVAL', 'medium', `Grants an UNLIMITED allowance to ${short(a.spender)}: if that contract or key is ever compromised, every ${f.symbol || 'token'} in the wallet can be taken. Approve only the amount needed.`);
      break;
    }
    case 'decrease_allowance': summary = `Decrease the allowance of ${short(a.spender)} on ${short(tok)}`; rep.party(a.spender, 'spender'); break;
    case 'set_approval_for_all': {
      summary = a.approved ? `Give ${short(a.operator)}${labelOf(chainId, a.operator) ? ` (${labelOf(chainId, a.operator)})` : ''} control of ALL your NFTs in collection ${short(tok)}` : `Revoke ${short(a.operator)}'s operator rights on collection ${short(tok)}`;
      rep.party(a.operator, 'operator');
      if (a.approved) { ctx.spenders.push({ address: a.operator, unlimited: true, kind: 'operator (all NFTs)' }); rep.flag('SET_APPROVAL_FOR_ALL', labelOf(chainId, a.operator) ? 'low' : 'high', `setApprovalForAll(true) lets ${short(a.operator)} move every NFT you own in this collection, now and later. This is the #1 NFT drainer pattern unless the operator is a marketplace you trust.`); }
      break;
    }
    case 'nft_safe_transfer': case 'erc1155_transfer': case 'erc1155_batch_transfer':
      summary = `Transfer NFT/token id(s) ${d.action === 'erc1155_batch_transfer' ? `[${(a.ids || []).slice(0, 5).join(', ')}${(a.ids || []).length > 5 ? ', …' : ''}]` : a.tokenId ?? a.id} from ${short(a.from)} to ${short(a.to)}`;
      rep.party(a.from, 'source'); rep.party(a.to, 'recipient');
      if (lc(a.to) === ZERO) rep.flag('BURN_TO_ZERO', 'critical', 'Recipient is the zero address: the NFTs are destroyed.');
      break;
    case 'erc2612_permit': {
      const f = tokenFmt(chainId, tok, a.value, ctx.tokenMeta); ctx.tokens.add(lc(tok));
      summary = `Submit a signed permit: ${short(a.owner)} lets ${short(a.spender)} spend ${f.text}`; rep.party(a.owner, 'owner'); rep.party(a.spender, 'spender');
      ctx.spenders.push({ address: a.spender, unlimited: f.unlimited, kind: 'permit allowance' });
      if (f.unlimited) rep.flag('UNLIMITED_APPROVAL', 'medium', `The permit grants an UNLIMITED allowance to ${short(a.spender)}.`);
      deadlineFlag(rep, a.deadline, now, 'permit deadline');
      break;
    }
    case 'permit2_approve': {
      const f = tokenFmt(chainId, a.token, a.amount, ctx.tokenMeta); ctx.tokens.add(lc(a.token));
      summary = `Permit2: allow ${short(a.spender)} to pull ${isUnlimited(a.amount, MAX_UINT160) ? `UNLIMITED ${f.symbol || 'tokens'}` : f.text} of ${short(a.token)} until ${expiryText(a.expiration)}`;
      rep.party(a.spender, 'spender'); rep.party(a.token, 'token'); ctx.spenders.push({ address: a.spender, unlimited: isUnlimited(a.amount, MAX_UINT160), kind: 'Permit2 allowance' });
      if (lc(to) !== PERMIT2) rep.flag('PERMIT2_LOOKALIKE', 'high', `This is a Permit2-style approve() but ${short(to)} is not the canonical Permit2 contract.`);
      if (isUnlimited(a.amount, MAX_UINT160)) rep.flag('UNLIMITED_APPROVAL', 'medium', `Unlimited Permit2 allowance for ${short(a.spender)}.`);
      deadlineFlag(rep, a.expiration, now, 'Permit2 expiration');
      break;
    }
    case 'permit2_permit': {
      const ps = a.permitSingle; const det = ps?.details || {};
      summary = `Permit2: submit ${short(a.owner)}'s signature letting ${short(ps?.spender)} pull ${isUnlimited(big(det.amount), MAX_UINT160) ? 'UNLIMITED' : String(det.amount)} of ${short(det.token)}`;
      rep.party(a.owner, 'owner'); rep.party(ps?.spender, 'spender'); rep.party(det.token, 'token');
      ctx.spenders.push({ address: ps?.spender, unlimited: isUnlimited(big(det.amount), MAX_UINT160), kind: 'Permit2 allowance' });
      if (lc(to) !== PERMIT2) rep.flag('PERMIT2_LOOKALIKE', 'high', `Permit2-style permit() on ${short(to)}, which is not the canonical Permit2 contract.`);
      break;
    }
    case 'eip3009_transfer': case 'eip3009_receive': {
      const f = tokenFmt(chainId, tok, a.value, ctx.tokenMeta); ctx.tokens.add(lc(tok));
      summary = `Execute a signed USDC-style transfer authorization: ${f.text} from ${short(a.from)} to ${short(a.to)}`;
      rep.party(a.from, 'source'); rep.party(a.to, 'recipient');
      break;
    }
    case 'multicall': case 'multicall3': {
      const inner = d.action === 'multicall3' ? (a.calls || []).map((c) => ({ to: c.target, data: c.callData })) : (a.data || []).map((x) => ({ to, data: x }));
      summary = `Batch of ${inner.length} call(s)`;
      if (depth >= 3) { rep.flag('DEEP_NESTING', 'medium', 'Calls are nested more than 3 levels deep; inner calls were not decoded.'); break; }
      const subs = inner.slice(0, 20).map((c) => analyzeCall(rep, { to: c.to, data: String(c.data || '0x').toLowerCase(), value: 0n, from }, depth + 1, ctx).summary);
      if (inner.length > 20) rep.flag('LARGE_BATCH', 'low', `Only the first 20 of ${inner.length} inner calls were decoded.`);
      summary += `: ${subs.join('; ')}`;
      break;
    }
    case 'safe_exec': {
      summary = `Safe multisig executes ${a.operation === 1 ? 'a DELEGATECALL' : 'a call'} to ${short(a.to)}`;
      if (a.operation === 1) rep.flag('SAFE_DELEGATECALL', 'high', 'Safe transaction uses operation=1 (DELEGATECALL): the target code runs with full control of the Safe. Only acceptable for known Safe libraries (MultiSend).');
      if (depth < 3) summary += `: ${analyzeCall(rep, { to: a.to, data: String(a.data || '0x').toLowerCase(), value: a.value || 0n, from: to }, depth + 1, ctx).summary}`;
      break;
    }
    case 'transfer_ownership':
      summary = `Transfer ownership of ${short(to)} to ${short(a.newOwner)}`; rep.party(a.newOwner, 'new_owner');
      rep.flag('OWNERSHIP_CHANGE', 'high', `Hands ownership of contract ${short(to)} to ${short(a.newOwner)}. Irreversible unless the new owner gives it back.`);
      break;
    case 'renounce_ownership': summary = `Renounce ownership of ${short(to)}`; rep.flag('OWNERSHIP_CHANGE', 'high', 'Renounces ownership: admin functions become unusable forever.'); break;
    case 'upgrade':
      summary = `Upgrade proxy ${short(to)} to implementation ${short(a.newImplementation)}`; rep.party(a.newImplementation, 'new_implementation');
      rep.flag('PROXY_UPGRADE', 'high', `Replaces the code behind ${short(to)} with ${short(a.newImplementation)}: the new code gets full control of the contract's funds and state.`);
      break;
    case 'grant_role': summary = `Grant role ${String(a.role).slice(0, 10)}… on ${short(to)} to ${short(a.account)}`; rep.party(a.account, 'grantee'); rep.flag('ROLE_GRANT', 'medium', `Grants an access-control role on ${short(to)} to ${short(a.account)}.`); break;
    case 'weth_deposit': summary = `Wrap ${native || '0 ETH'} into ${labelOf(chainId, to) || short(to)}`; break;
    case 'weth_withdraw': summary = `Unwrap ${fmtUnits(a.amount, 18)} WETH from ${labelOf(chainId, to) || short(to)}`; break;
    default: summary = d.fn;
  }
  if (native && d.action !== 'native_transfer' && d.action !== 'weth_deposit') summary += ` (also sends ${native})`;
  return { action: d.action, summary };
}

function deadlineFlag(rep, v, now, what) {
  const t = big(v); if (t === null) return;
  if (t === 0n) return;
  if (t >= MAX_UINT48 || t >= 4102444800n) { rep.flag('NO_EXPIRY', 'medium', `${what} never expires in practice (${t}). A leaked signature or allowance stays usable forever.`); return; }
  const secs = Number(t) - Math.floor(now / 1000);
  if (secs < 0) rep.flag('EXPIRED', 'low', `${what} is already in the past (${new Date(Number(t) * 1000).toISOString()}); it will fail.`);
  else if (secs > 30 * DAY) rep.flag('LONG_EXPIRY', 'low', `${what} is ${Math.round(secs / DAY)} days away.`);
}
const expiryText = (v) => { const t = big(v); if (t === null || t === 0n) return 'no expiry'; if (t >= MAX_UINT48 || t >= 4102444800n) return 'never'; return new Date(Number(t) * 1000).toISOString(); };
function jsonable(x) {
  if (typeof x === 'bigint') return x.toString();
  if (Array.isArray(x)) return x.map(jsonable);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, jsonable(v)]));
  return x;
}

// ---------- typed data ----------
const DOMAIN_NAMES_USDC = /^(usd coin|usdc)$/i;
function analyzeTyped(rep, td, ctx) {
  const dom = td.domain || {}; const m = td.message || {}; const pt = td.primaryType; const chainId = rep.chainId; const now = ctx.now;
  const vc = dom.verifyingContract ? lc(dom.verifyingContract) : null;
  if (vc) rep.party(vc, 'verifying_contract');
  const domChain = dom.chainId !== undefined ? Number(big(dom.chainId)) : null;
  if (domChain !== null && ctx.requestedChain !== null && domChain !== ctx.requestedChain) rep.flag('CHAIN_MISMATCH', 'high', `The signature's domain is for chain ${domChain}, but you said you are on chain ${ctx.requestedChain}.`);
  if (domChain === null) rep.flag('NO_CHAIN_ID', 'medium', 'The EIP-712 domain has no chainId: the signature may be replayable on other chains.');
  if (dom.name && DOMAIN_NAMES_USDC.test(String(dom.name)) && vc && USDC[chainId] && vc !== USDC[chainId]) rep.flag('FAKE_TOKEN_DOMAIN', 'critical', `The domain claims to be "${dom.name}" but verifyingContract ${short(vc)} is not Circle's USDC on ${CHAINS[chainId]?.name || chainId} (${short(USDC[chainId])}).`);
  if (String(dom.name || '') === 'Permit2' && vc && vc !== PERMIT2) rep.flag('PERMIT2_LOOKALIKE', 'critical', `The domain says "Permit2" but verifyingContract ${short(vc)} is not the canonical Permit2 (${short(PERMIT2)}).`);
  let action; let summary;
  const tokenOfDomain = vc;
  if ((pt === 'TransferWithAuthorization' || pt === 'ReceiveWithAuthorization') && m.to !== undefined) {
    action = 'eip3009_authorization';
    const v = big(m.value); const f = tokenFmt(chainId, tokenOfDomain, v, ctx.tokenMeta); if (tokenOfDomain) ctx.tokens.add(tokenOfDomain);
    summary = `Sign a ${pt === 'ReceiveWithAuthorization' ? 'receive' : 'transfer'} authorization: pay ${f.text} from ${short(m.from)} to ${short(m.to)} (valid ${windowText(m.validAfter, m.validBefore, now)})`;
    rep.party(m.from, 'payer'); rep.party(m.to, 'recipient');
    ctx.eip3009 = { from: m.from, to: m.to, value: v, validAfter: big(m.validAfter), validBefore: big(m.validBefore), token: tokenOfDomain, name: dom.name, version: dom.version, chainId: domChain };
    const vb = big(m.validBefore); if (vb !== null && Number(vb) - now / 1000 > 7 * DAY) rep.flag('LONG_VALIDITY', 'medium', `The authorization stays valid for ${Math.round((Number(vb) - now / 1000) / DAY)} days; x402 payments normally expire within minutes.`);
    if (lc(m.to) === ZERO) rep.flag('BURN_TO_ZERO', 'critical', 'Recipient is the zero address.');
  } else if (pt === 'Permit' && m.spender !== undefined) {
    const dai = m.allowed !== undefined;
    const v = dai ? (m.allowed ? MAX_UINT256 : 0n) : big(m.value); const f = tokenFmt(chainId, tokenOfDomain, v, ctx.tokenMeta); if (tokenOfDomain) ctx.tokens.add(tokenOfDomain);
    action = 'erc2612_permit_signature';
    summary = `Sign an off-chain permit: let ${short(m.spender)}${labelOf(chainId, m.spender) ? ` (${labelOf(chainId, m.spender)})` : ''} spend ${f.text} of ${dom.name || short(tokenOfDomain)} from ${short(m.owner || m.holder)} until ${expiryText(m.deadline ?? m.expiry)}`;
    rep.party(m.owner || m.holder, 'owner'); rep.party(m.spender, 'spender'); ctx.spenders.push({ address: m.spender, unlimited: f.unlimited, kind: 'permit signature' });
    rep.flag('OFFCHAIN_APPROVAL', 'medium', 'Gasless permit signature: it costs nothing to sign and never shows up as a transaction, which is why phishing sites ask for it. Whoever holds the signature can submit it.');
    if (f.unlimited) rep.flag('UNLIMITED_APPROVAL', 'high', `Unlimited allowance via a signature for ${short(m.spender)}.`);
    deadlineFlag(rep, m.deadline ?? m.expiry, now, 'permit deadline');
  } else if (pt === 'PermitSingle' || pt === 'PermitBatch') {
    action = 'permit2_allowance_signature';
    const dets = pt === 'PermitSingle' ? [m.details || {}] : (m.details || []);
    const parts = dets.slice(0, 10).map((dt) => { const amt = big(dt.amount); if (dt.token) { ctx.tokens.add(lc(dt.token)); rep.party(dt.token, 'token'); } deadlineFlag(rep, dt.expiration, now, 'Permit2 allowance expiration'); return isUnlimited(amt, MAX_UINT160) ? `UNLIMITED ${tokenOf(chainId, dt.token)?.[0] || short(dt.token)}` : tokenFmt(chainId, dt.token, amt, ctx.tokenMeta).text; });
    summary = `Sign a Permit2 allowance: let ${short(m.spender)}${labelOf(chainId, m.spender) ? ` (${labelOf(chainId, m.spender)})` : ''} pull ${parts.join(', ')}`;
    rep.party(m.spender, 'spender'); const unl = dets.some((dt) => isUnlimited(big(dt.amount), MAX_UINT160)); ctx.spenders.push({ address: m.spender, unlimited: unl, kind: 'Permit2 signature' });
    rep.flag('OFFCHAIN_APPROVAL', 'medium', 'Permit2 signature: no transaction, no gas, but it authorizes token pulls. Classic phishing request.');
    if (unl) rep.flag('UNLIMITED_APPROVAL', 'high', `Unlimited Permit2 allowance for ${short(m.spender)}.`);
    if (dets.length > 1) rep.flag('MULTI_TOKEN_PERMIT', 'medium', `One signature covers ${dets.length} tokens.`);
  } else if (/^Permit(Batch)?(Witness)?TransferFrom$/.test(pt)) {
    action = 'permit2_transfer_signature';
    const perm = Array.isArray(m.permitted) ? m.permitted : [m.permitted || {}];
    const parts = perm.slice(0, 10).map((p) => { if (p.token) { ctx.tokens.add(lc(p.token)); rep.party(p.token, 'token'); } return tokenFmt(chainId, p.token, big(p.amount), ctx.tokenMeta).text; });
    summary = `Sign a Permit2 one-time transfer: let ${short(m.spender)}${labelOf(chainId, m.spender) ? ` (${labelOf(chainId, m.spender)})` : ''} take ${parts.join(', ')}${pt.includes('Witness') ? ' (with witness data)' : ''}`;
    rep.party(m.spender, 'spender'); ctx.spenders.push({ address: m.spender, unlimited: perm.some((p) => isUnlimited(big(p.amount))), kind: 'Permit2 transfer signature' });
    rep.flag('OFFCHAIN_APPROVAL', 'medium', 'Permit2 transfer signature: the spender can move these tokens once without any further prompt.');
    deadlineFlag(rep, m.deadline, now, 'Permit2 signature deadline');
    if (perm.some((p) => isUnlimited(big(p.amount)))) rep.flag('UNLIMITED_APPROVAL', 'high', 'Signature authorizes an unlimited amount.');
  } else if (pt === 'OrderComponents' && Array.isArray(m.offer)) {
    action = 'seaport_order';
    const offer = m.offer.length; const cons = Array.isArray(m.consideration) ? m.consideration : [];
    const toOfferer = cons.filter((c) => lc(c.recipient) === lc(m.offerer));
    const others = cons.filter((c) => lc(c.recipient) !== lc(m.offerer));
    summary = `Sign a Seaport order: give ${offer} item(s); in return ${cons.length} consideration item(s), ${toOfferer.length} paid to you`;
    rep.party(m.offerer, 'offerer'); for (const c of others) rep.party(c.recipient, 'consideration_recipient');
    const anyNft = m.offer.some((o) => Number(o.itemType) >= 2);
    const youGet = toOfferer.reduce((s, c) => s + (big(c.startAmount) || 0n), 0n);
    if (anyNft && (toOfferer.length === 0 || youGet === 0n)) rep.flag('ZERO_PRICE_LISTING', 'critical', 'You offer NFT(s) but receive nothing: a classic "free listing" phishing signature.');
    deadlineFlag(rep, m.endTime, now, 'order end time');
  } else {
    action = 'typed_data_unknown';
    summary = `Sign "${pt}" typed data for ${dom.name || 'an unnamed app'}${vc ? ` (contract ${short(vc)})` : ''}`;
    rep.flag('UNKNOWN_TYPED_DATA', 'low', `"${pt}" is not a known approval/transfer type; check what the app says it does.`);
    for (const [k, v] of Object.entries(m)) if (typeof v === 'string' && isAddress(v, { strict: false })) rep.party(v, `message.${k}`);
  }
  ctx.decoded.push({ primaryType: pt, domain: jsonable(dom), message: jsonable(m) });
  return { action, summary };
}
const windowText = (a, b, now) => { const vb = big(b); if (vb === null) return 'no expiry'; const s = Number(vb) - Math.floor(now / 1000); return s < 0 ? 'EXPIRED' : s < 3600 ? `for ${Math.max(1, Math.round(s / 60))} min` : s < 2 * DAY ? `for ${Math.round(s / 3600)} h` : `for ${Math.round(s / DAY)} days`; };

/** EIP-3009 typed data rebuilt from an x402 payment payload + its requirements. */
function typedFromX402(payload, req, chainId) {
  const p = payload?.payload || payload; const auth = p?.authorization;
  if (!auth || !auth.to) return null;
  return { primaryType: 'TransferWithAuthorization', domain: { name: req?.extra?.name || 'USD Coin', version: req?.extra?.version || '2', chainId, verifyingContract: req?.asset }, message: auth, types: {} };
}

function x402Match(rep, req, e, chainId, now) {
  const m = { requirements: { network: req.network, amount: req.amount, payTo: req.payTo, asset: req.asset, maxTimeoutSeconds: req.maxTimeoutSeconds ?? null, resource: req.resource ?? null } };
  if (!e) { rep.flag('X402_NO_AUTHORIZATION', 'info', 'No EIP-3009 authorization to compare: pass "payment_payload" or the typed_data your client will sign to check it matches the 402.'); m.matches = null; return m; }
  const issues = [];
  if (lc(e.to) !== lc(req.payTo)) { issues.push('pay_to'); rep.flag('X402_PAYTO_MISMATCH', 'critical', `The authorization pays ${short(e.to)}, but the 402 asked to pay ${short(req.payTo)}.`); }
  const want = big(req.amount);
  if (want !== null && e.value !== null) {
    if (e.value > want) { issues.push('amount'); rep.flag('X402_OVERPAY', 'critical', `The authorization is for ${e.value} base units but the 402 price is ${want} (${(Number(e.value) / Number(want || 1n)).toFixed(1)}x).`); }
    else if (e.value < want) { issues.push('amount'); rep.flag('X402_UNDERPAY', 'low', `The authorization (${e.value}) is below the 402 price (${want}); the seller will reject it.`); }
  }
  if (req.asset && e.token && lc(req.asset) !== lc(e.token)) { issues.push('asset'); rep.flag('X402_ASSET_MISMATCH', 'high', `The signature is for token ${short(e.token)} but the 402 asks for ${short(req.asset)}.`); }
  if (req.asset && USDC[chainId] && lc(req.asset) !== USDC[chainId] && /usd/i.test(String(req.extra?.name || ''))) rep.flag('X402_NONCANONICAL_USDC', 'high', `The 402 asks for "${req.extra?.name}" at ${short(req.asset)}, which is not Circle's USDC on ${CHAINS[chainId]?.name || chainId}.`);
  const reqChain = /^eip155:(\d+)$/.exec(req.network || '')?.[1];
  if (reqChain && e.chainId && Number(reqChain) !== e.chainId) { issues.push('network'); rep.flag('X402_NETWORK_MISMATCH', 'high', `The 402 is for chain ${reqChain} but the signature domain is chain ${e.chainId}.`); }
  if (e.validBefore !== null && req.maxTimeoutSeconds) { const s = Number(e.validBefore) - Math.floor(now / 1000); if (s > Number(req.maxTimeoutSeconds) + 600) { issues.push('validity'); rep.flag('X402_LONG_VALIDITY', 'medium', `The authorization is valid for ${Math.round(s / 60)} min, far longer than the 402's maxTimeoutSeconds (${req.maxTimeoutSeconds} s).`); } }
  const usd = (USDC[chainId] && lc(req.asset) === USDC[chainId] && want !== null) ? Number(want) / 1e6 : null;
  if (usd !== null && usd >= 1) rep.flag('X402_PRICE', usd >= 10 ? 'medium' : 'low', `This x402 payment is $${usd.toFixed(2)} USDC, well above typical per-call API prices ($0.001–$0.05). Make sure that is intended.`);
  m.matches = issues.length === 0; m.mismatches = issues; m.price_usd = usd;
  return m;
}

// ---------- verdict ----------
export function verdictOf(flags) {
  const sev = flags.map((f) => f.severity);
  const score = Math.min(100, flags.reduce((s, f) => s + (SEVERITY[f.severity] || 0), 0));
  const verdict = sev.includes('critical') || sev.includes('high') ? 'DANGER' : sev.includes('medium') ? 'CAUTION' : 'SAFE';
  return { verdict, risk_score: verdict === 'DANGER' ? Math.max(score, 70) : verdict === 'CAUTION' ? Math.min(Math.max(score, 30), 69) : Math.min(score, 29) };
}
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/**
 * Run the check. opts: { tier: 'preview'|'lite'|'full', now, rpcFor(chainId) -> {batch, call} | null, lookupSelectors(sels) -> {sel: name} }
 */
export async function checkSign(input, { tier = 'full', now = Date.now(), rpcFor = () => null, lookupSelectors = null } = {}) {
  const chainId = input.chainId; const chain = CHAINS[chainId] || { id: chainId, name: `chain ${chainId}`, onchain: false };
  const rep = new Report(chainId);
  const ctx = { now, decoded: [], tokens: new Set(), tokenMeta: {}, spenders: [], checkCode: [], unknownSelectors: new Set(), requestedChain: input.chainId, eip3009: null };
  let main; let x402 = null;
  if (input.kind === 'transaction') {
    if (input.tx.from) rep.party(input.tx.from, 'from');
    main = analyzeCall(rep, input.tx, 0, ctx);
    for (const au of input.tx.authorizationList.slice(0, 5)) eip7702(rep, { address: au.address || au.contractAddress, chainId: big(au.chainId ?? 0) ?? 0n }, chainId);
  } else if (input.kind === 'eip7702_authorization') {
    main = eip7702(rep, input.authorization, chainId);
  } else {
    let td = input.typed;
    if (!td && input.payload) td = typedFromX402(input.payload, input.requirements, chainId);
    if (!td && !input.requirements) throw new InputError('nothing to check');
    if (td) main = analyzeTyped(rep, td, ctx);
    else main = { action: 'x402_requirements_only', summary: `x402 402 terms: pay ${input.requirements.amount} base units of ${short(input.requirements.asset)} to ${short(input.requirements.payTo)}` };
    if (input.requirements) { rep.party(input.requirements.payTo, 'x402_pay_to'); x402 = x402Match(rep, input.requirements, ctx.eip3009, chainId, now); }
  }
  // OFAC SDN (offline, both tiers)
  const sanctioned = [];
  for (const p of rep.parties.values()) { const s = sdnMatch(p.address); if (s) { p.sanctioned = s; sanctioned.push(p); rep.flag('SANCTIONED_COUNTERPARTY', 'critical', `${p.address} (${p.roles.join(', ')}) is on the US Treasury OFAC SDN list (${s.entity}).`); } }
  // spender sanity (offline): spender == owner
  for (const s of ctx.spenders) if (s.address && lc(s.address) === lc(input.tx?.from)) rep.flag('SELF_SPENDER', 'info', 'Spender is your own address.');

  let onchain = null;
  if (tier === 'full') onchain = await onchainChecks(rep, input, ctx, chain, { rpcFor, lookupSelectors });
  if (tier === 'full') main = refreshSummary(main, input, rep, ctx);
  if (tier === 'lite') onchain = { available: false, skipped: 'lite tier: offline decode, reasons, x402 match and OFAC SDN only; on-chain facts and eth_call simulation are on /v1/check' };

  rep.flags.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const v = verdictOf(rep.flags);
  const base = { tier, verdict: v.verdict, risk_score: v.risk_score, kind: input.kind, action: main.action, summary: main.summary, chain: { id: chainId, name: chain.name } };
  if (tier === 'preview') {
    return { ...base, flags: rep.flags.map(({ code, severity }) => ({ code, severity })), flag_count: rep.flags.length, ...(x402 ? { x402: { matches: x402.matches } } : {}), engine: ENGINE_VERSION, checked_at: new Date(now).toISOString(), disclaimer: DISCLAIMER };
  }
  return {
    ...base, flags: rep.flags,
    counterparties: [...rep.parties.values()],
    decoded: ctx.decoded,
    ...(x402 ? { x402 } : {}),
    onchain,
    sanctions: { list: SDN_META.source, list_date: SDN_META.publish_date, evm_addresses: SDN_META.evm_address_count, matches: sanctioned.length },
    engine: ENGINE_VERSION, checked_at: new Date(now).toISOString(), disclaimer: DISCLAIMER,
  };
}

function eip7702(rep, au, chainId) {
  rep.party(au.address, 'eip7702_delegate');
  const any = au.chainId === 0n;
  rep.flag('EIP7702_DELEGATION', labelOf(chainId, au.address) ? 'medium' : 'critical', `EIP-7702 authorization: your EOA's code is replaced by contract ${short(au.address)}${labelOf(chainId, au.address) ? ` (${labelOf(chainId, au.address)})` : ''}. That contract can then move ALL assets of the account. Only sign for your own wallet provider's delegate.`);
  if (any) rep.flag('EIP7702_ALL_CHAINS', 'critical', 'chainId 0: the delegation is valid on EVERY EVM chain.');
  return { action: 'eip7702_delegation', summary: `Delegate your account to contract ${short(au.address)}${any ? ' on all chains' : ''}` };
}

function refreshSummary(main, input, rep, ctx) {
  if (!Object.keys(ctx.tokenMeta).length) return main;
  // re-run the offline analysis with token metadata for human amounts (flags are deduplicated by code+message)
  const rep2 = new Report(rep.chainId); const ctx2 = { ...ctx, decoded: [], tokens: new Set(), spenders: [], checkCode: [], unknownSelectors: new Set() };
  try {
    if (input.kind === 'transaction') return analyzeCall(rep2, input.tx, 0, ctx2);
    const td = input.typed || (input.payload ? typedFromX402(input.payload, input.requirements, rep.chainId) : null);
    if (td) return analyzeTyped(rep2, td, ctx2);
  } catch { /* keep */ }
  return main;
}

export class UpstreamError extends Error { constructor(msg) { super(msg); this.name = 'UpstreamError'; this.code = 'rpc_unavailable'; this.status = 503; } }
const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567', name: '0x06fdde03' };
function abiString(hex) {
  const h = (hex || '0x').replace(/^0x/, '');
  if (h.length < 64) return null;
  try {
    let bytes;
    if (h.length === 64) bytes = h; else { const off = Number(BigInt(`0x${h.slice(0, 64)}`)) * 2; const len = Number(BigInt(`0x${h.slice(off, off + 64)}`)); if (len > 200) return null; bytes = h.slice(off + 64, off + 64 + len * 2); }
    const b = new Uint8Array(bytes.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(bytes.substr(i * 2, 2), 16);
    return new TextDecoder().decode(b).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || null;
  } catch { return null; }
}
export function revertReason(data) {
  const h = typeof data === 'string' ? data : data?.data;
  if (typeof h !== 'string' || !h.startsWith('0x')) return null;
  if (h.startsWith('0x08c379a0')) return abiString(`0x${h.slice(10)}`);
  if (h.startsWith('0x4e487b71')) return `panic 0x${BigInt(`0x${h.slice(10, 74)}`).toString(16)}`;
  return h.length > 10 ? `custom error ${h.slice(0, 10)}` : null;
}

async function onchainChecks(rep, input, ctx, chain, { rpcFor, lookupSelectors }) {
  const out = { available: false, chain: chain.name };
  const tasks = [];
  if (ctx.unknownSelectors.size && lookupSelectors) {
    tasks.push(withDeadline(lookupSelectors([...ctx.unknownSelectors]), 3000, 'selector lookup').then((r) => {
      out.selector_names = r || {};
      for (const [sel, names] of Object.entries(r || {})) if (names?.length) rep.flag('FUNCTION_NAME_GUESS', 'info', `${sel} is registered in the public 4-byte directory as ${names.slice(0, 3).join(' / ')} (names are unverified and can be spoofed).`);
    }).catch(() => { out.selector_names = null; }));
  }
  const rpc = chain.onchain ? rpcFor(chain.id) : null;
  if (!rpc) {
    rep.flag('NO_ONCHAIN_CHECKS', 'info', `On-chain checks run on Base, Ethereum and Base Sepolia; chain ${chain.id} was decoded offline only.`);
    await Promise.all(tasks); return out;
  }
  const addrs = [...new Set([...rep.parties.values()].map((p) => lc(p.address)))].filter((a) => a !== ZERO).slice(0, 25);
  const tokens = [...ctx.tokens].filter((t) => t && isAddress(t, { strict: false })).slice(0, 10);
  const calls = addrs.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] }));
  for (const t of tokens) for (const k of ['symbol', 'decimals', 'name']) calls.push({ method: 'eth_call', params: [{ to: t, data: SEL[k] }, 'latest'] });
  const sim = input.kind === 'transaction' && input.tx.from;
  if (sim) calls.push({ method: 'eth_call', params: [{ from: input.tx.from, to: input.tx.to, data: input.tx.data, value: `0x${input.tx.value.toString(16)}` }, 'latest'] });
  calls.push({ method: 'eth_blockNumber', params: [] });
  let res;
  try { res = await rpc.batch(calls); } catch (e) { throw new UpstreamError(`${chain.name} RPC unavailable: ${String(e?.message || e).slice(0, 120)}`); }
  if (res.every((r) => r.error)) throw new UpstreamError(`${chain.name} RPC returned only errors`);
  out.available = true; out.block = res.at(-1)?.result ? Number(BigInt(res.at(-1).result)) : null;
  let i = 0; const code = {};
  for (const a of addrs) { const r = res[i++]; if (!r.error && typeof r.result === 'string') code[a] = r.result; }
  for (const t of tokens) {
    const [sy, de, na] = [res[i++], res[i++], res[i++]];
    const decimals = !de.error && de.result && de.result !== '0x' ? Number(BigInt(de.result.slice(0, 66))) : null;
    ctx.tokenMeta[t] = { symbol: sy.error ? null : abiString(sy.result), decimals: decimals !== null && decimals <= 36 ? decimals : null, name: na.error ? null : abiString(na.result) };
  }
  out.tokens = Object.entries(ctx.tokenMeta).map(([address, m]) => ({ address: safeChecksum(address), ...m, label: labelOf(chain.id, address) }));
  for (const p of rep.parties.values()) {
    const c = code[lc(p.address)];
    if (c === undefined) continue;
    p.type = c === '0x' ? 'eoa' : c.startsWith('0xef0100') && c.length === 48 ? 'eip7702_delegated_eoa' : 'contract';
    if (p.type === 'eip7702_delegated_eoa') p.delegate = safeChecksum(`0x${c.slice(8)}`);
  }
  const typeOf = (a) => rep.parties.get(lc(a))?.type;
  for (const s of ctx.spenders) {
    if (!s.address || lc(s.address) === ZERO) continue;
    const t = typeOf(s.address);
    if (t === 'eoa') rep.flag('SPENDER_IS_EOA', 'critical', `The ${s.kind} goes to ${short(s.address)}, a plain wallet (no contract code). Legitimate apps approve contracts; approvals to wallets are how drainer kits steal funds.`);
    else if (t === 'contract' && !labelOf(chain.id, s.address)) rep.flag('SPENDER_UNLABELLED', 'low', `Spender ${short(s.address)} is a contract we have no label for; make sure it belongs to the app you are using.`);
  }
  if (input.kind === 'transaction') {
    const t = typeOf(input.tx.to); const tokenish = ctx.decoded[0] && ctx.decoded[0].action !== 'native_transfer';
    if (t === 'eoa' && tokenish) rep.flag('TARGET_NOT_A_CONTRACT', 'high', `${short(input.tx.to)} has no contract code, so this ${ctx.decoded[0].action} call does nothing (wrong token/contract address?).`);
    if (t === 'eoa' && !ctx.decoded[0] && input.tx.data !== '0x') rep.flag('TARGET_NOT_A_CONTRACT', 'high', `${short(input.tx.to)} has no contract code; the call data is ignored.`);
    if (sim) {
      const r = res[res.length - 2];
      if (r.error) { const why = revertReason(r.error.data) || r.error.message || 'reverted'; out.simulation = { success: false, revert_reason: String(why).slice(0, 200) }; rep.flag('SIMULATION_REVERTS', 'medium', `Simulated against the latest block, the transaction REVERTS (${String(why).slice(0, 120)}). It would fail and still cost gas.`); }
      else out.simulation = { success: true, return_data: String(r.result || '0x').slice(0, 130) };
    } else { out.simulation = null; rep.flag('NOT_SIMULATED', 'info', 'Pass "tx.from" to also simulate the call against the latest block.'); }
  }
  const vc = input.kind === 'typed_data' || input.kind === 'x402_payment' ? [...rep.parties.values()].find((p) => p.roles.includes('verifying_contract')) : null;
  if (vc && vc.type === 'eoa') rep.flag('VERIFYING_CONTRACT_NOT_DEPLOYED', 'high', `The domain's verifyingContract ${short(vc.address)} has no code on ${chain.name}: the signature targets a contract that doesn't exist there (wrong chain or fake domain).`);
  const payTo = [...rep.parties.values()].find((p) => p.roles.includes('x402_pay_to'));
  if (payTo?.type) out.pay_to_type = payTo.type;
  await Promise.all(tasks);
  return out;
}

/** Public 4-byte directory lookup (openchain.xyz). Returns { '0x12345678': ['name(types)'] }. */
export async function openchainLookup(sels, fetchImpl = (...a) => globalThis.fetch(...a)) {
  const u = `https://api.openchain.xyz/signature-database/v1/lookup?function=${sels.slice(0, 10).join(',')}&filter=true`;
  const r = await fetchImpl(u, { headers: { accept: 'application/json' } });
  if (!r.ok) return {};
  const j = await r.json();
  return Object.fromEntries(Object.entries(j?.result?.function || {}).map(([k, v]) => [k, (v || []).map((x) => x.name).slice(0, 3)]));
}
