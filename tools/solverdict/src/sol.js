// SolVerdict engine: Solana SPL / Token-2022 token safety check from free public data only.
//   Solana RPC (public endpoints): mint account (mint / freeze authority, supply, Token-2022 extensions: transfer fee,
//     permanent delegate, transfer hook, default frozen state, non-transferable, pausable, close authority), Metaplex
//     metadata (name, symbol, update authority, mutable), largest token accounts and their owners (wallet vs program PDA).
//   DexScreener (public API): pools, liquidity, 24 h buys/sells and volume, first pool time.
//   Fallbacks: Raydium API v3 pools by mint (liquidity, pool age, LP burn %), pump.fun bonding-curve account (on-chain).
// Every source is best-effort with its own deadline: a missing source lowers confidence and is listed in missing_data;
// it is never read as clean. Nothing is signed or sent.
import { base58Decode, isOnCurveAddress, findProgramAddress } from './b58.js';
import { RECOGNIZED, BURN_OWNERS } from './known.js';
import { withDeadline } from './deadline.js';

export const ENGINE_VERSION = 'solverdict-0.1';
export const DISCLAIMER = 'Automated, informational risk signals from public on-chain and market data at the time of the check. Not financial advice, not an audit, no guarantee: a token that passes can still lose value or be changed later by whoever controls it.';
export const LIMITS = [
  'No swap is simulated: sell blocking is inferred from on-chain controls (freeze authority, default-frozen accounts, permanent delegate, transfer hook, pausable, non-transferable) and from recent sells on DEX pools.',
  'A transfer hook program can run arbitrary rules on every transfer; SolVerdict reports that a hook exists, not what it does.',
  'Holder concentration uses the 20 largest token accounts from a public RPC; owners that are program-derived addresses (pools, bonding curves, vaults, lockers) are separated from wallets, but exchange and team wallets look like any other wallet.',
  'Liquidity, volume and pool age come from DexScreener (or Raydium pools only when DexScreener is rate-limited, without buy/sell counts) and can lag the chain by a few minutes; LP lock status is not checked.',
];
export const RPCS = ['https://solana-rpc.publicnode.com', 'https://public.rpc.solanavibestation.com', 'https://solana.api.pocket.network'];
// getTokenLargestAccounts is refused or blocked by most free endpoints; this order worked from Workers on 2026-10-22.
export const HOLDER_RPCS = ['https://public.rpc.solanavibestation.com', 'https://solana-rpc.publicnode.com'];
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

export class InputError extends Error { constructor(msg, status = 400, code = 'bad_request') { super(msg); this.status = status; this.code = code; } }

export function normalizeMint(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new InputError('"mint" is required: a Solana token mint address (base58), e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new InputError('"mint" must be a base58 Solana address (32-44 characters, no 0, O, I or l)');
  const b = base58Decode(s);
  if (!b || b.length !== 32) throw new InputError('"mint" does not decode to a 32-byte Solana address');
  return s;
}

/** Tiny JSON-RPC client with endpoint fallback and a per-call deadline (Solana public RPCs reject batches inconsistently). */
export function makeSolRpc({ fetchImpl = (...a) => globalThis.fetch(...a), urls = RPCS, ms = 4000 } = {}) {
  const tried = [];
  async function call(method, params, list = urls) {
    let last;
    for (const url of list.slice(0, 3)) {
      try {
        const res = await withDeadline(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), ms, `rpc ${new URL(url).host}`);
        if (!res.ok) throw new Error(`rpc ${new URL(url).host} HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(`rpc ${new URL(url).host}: ${String(j.error.message || j.error.code).slice(0, 80)}`);
        return j.result;
      } catch (e) { last = e; tried.push(String(e.message || e).slice(0, 120)); }
    }
    throw last || new Error('no rpc');
  }
  return { call, tried };
}

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** pump.fun BondingCurve account: 8-byte discriminator, 5 x u64 (virtual token, virtual SOL, real token, real SOL, total supply), complete bool. */
export function parsePumpCurve(acc) {
  try {
    if (!acc || acc.owner !== PUMP_PROGRAM || !Array.isArray(acc.data)) return null;
    const b = Uint8Array.from(atob(acc.data[0]), (ch) => ch.charCodeAt(0)); if (b.length < 49) return null;
    const u64 = (o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
    return { real_sol: Number(u64(32)) / 1e9, complete: b[48] === 1 };
  } catch { return null; }
}

async function jget(fetchImpl, url, ms = 5000) {
  try {
    const r = await withDeadline(fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'solverdict/0.1 (+https://api.youraitools.co/solverdict)' } }), ms, 'http');
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---- Metaplex Token Metadata (borsh, v1 layout) ----
function readStr(buf, o) { const n = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24); const s = new TextDecoder().decode(buf.subarray(o + 4, o + 4 + n)); return [s.replace(/\0+$/g, '').trim(), o + 4 + n]; }
export function parseMetaplex(b64) {
  try {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    let o = 1; // key
    const ua = buf.subarray(o, o + 32); o += 32; o += 32; // update authority, mint
    let name, symbol, uri; [name, o] = readStr(buf, o); [symbol, o] = readStr(buf, o); [uri, o] = readStr(buf, o);
    o += 2; // seller fee bps
    if (buf[o++] === 1) { const n = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24); o += 4 + n * 34; } // creators
    o += 1; // primary sale happened
    const mutable = buf[o] === 1;
    return { name, symbol, uri, update_authority: b58(ua), mutable, source: 'Metaplex metadata' };
  } catch { return null; }
}
const b58 = (bytes) => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x) break; s = '1' + s; } return s; };

function extMap(info) { const m = {}; for (const e of info?.extensions || []) m[e.extension] = e.state || {}; return m; }
const pct = (a, b) => (b > 0n ? Math.round(Number((a * 1000000n) / b) / 100) / 100 : null);
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Analyze a mint. tier: 'lite' (no holder scan unless cheap) | 'check' (everything).
 * @returns {Promise<object>} report (see README)
 */
export async function analyzeMint(mint, { tier = 'check', fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now(), rpcUrls, holderUrls } = {}) {
  const rpc = makeSolRpc({ fetchImpl, urls: rpcUrls || RPCS });
  const sources = { rpc: false, metadata: false, holders: false, dexscreener: false, raydium: false };
  const known = RECOGNIZED[mint] || null;

  const metaPda = (() => { try { return findProgramAddress([new TextEncoder().encode('metadata'), base58Decode(METAPLEX), base58Decode(mint)], METAPLEX); } catch { return null; } })();
  const curvePda = (() => { try { return findProgramAddress([new TextEncoder().encode('bonding-curve'), base58Decode(mint)], PUMP_PROGRAM); } catch { return null; } })();
  const acctP = rpc.call('getMultipleAccounts', [[mint, metaPda || mint, curvePda || mint], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const dexP = jget(fetchImpl, `https://api.dexscreener.com/tokens/v1/solana/${mint}`).then((d) => (Array.isArray(d) ? d : null));
  const largestP = tier === 'check' || tier === 'card'
    ? withDeadline(rpc.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], holderUrls || HOLDER_RPCS), 7000, 'holders').catch(() => null)
    : Promise.resolve(null);

  let accts;
  try { accts = await acctP; } catch (e) { throw new InputError(`Solana RPC unavailable (${String(e.message).slice(0, 100)}). Not charged; retry shortly.`, 503, 'rpc_unavailable'); }
  sources.rpc = true;
  const ma = accts?.value?.[0];
  if (!ma) throw new InputError('No account exists at this address on Solana mainnet (not a token mint). Not charged.', 422, 'not_a_mint');
  const program = ma.owner;
  const parsed = ma.data?.parsed;
  if (![TOKEN_PROGRAM, TOKEN_2022].includes(program) || parsed?.type !== 'mint') throw new InputError(`This address is not an SPL token mint (account owner ${program}${parsed?.type ? `, type ${parsed.type}` : ''}). Pass the token's mint address. Not charged.`, 422, 'not_a_mint');
  const info = parsed.info;
  const ext = extMap(info);
  const supply = BigInt(info.supply || '0');
  const decimals = Number(info.decimals || 0);

  // metadata: Token-2022 tokenMetadata extension, else Metaplex
  let metadata = null;
  if (ext.tokenMetadata) { metadata = { name: ext.tokenMetadata.name || null, symbol: ext.tokenMetadata.symbol || null, uri: ext.tokenMetadata.uri || null, update_authority: ext.tokenMetadata.updateAuthority || null, mutable: !!ext.tokenMetadata.updateAuthority, source: 'Token-2022 metadata extension' }; sources.metadata = true; }
  else if (metaPda && accts.value[1]?.data?.[0]) { metadata = parseMetaplex(accts.value[1].data[0]); sources.metadata = !!metadata; }
  else if (metaPda && accts.value.length > 1) { sources.metadata = true; metadata = null; } // no metadata account exists
  const curve = curvePda ? parsePumpCurve(accts.value[2]) : null; // pump.fun bonding curve (on-chain, no API)

  let [dex, largest] = await Promise.all([dexP, largestP]);
  // DexScreener rate-limits shared egress IPs at times: fall back to Raydium's public pool API (liquidity, no buy/sell counts)
  let ray = null;
  if (!dex) ray = await jget(fetchImpl, `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=10&page=1`, 4000).then((d) => (d?.success && Array.isArray(d.data?.data) ? d.data.data : null));

  // holders: owners of the largest token accounts, wallet (on-curve) vs program-derived address (pools, curves, vaults)
  let holders = { available: false };
  if (largest?.value?.length && supply > 0n) {
    const top = largest.value.slice(0, 20);
    let owners = null;
    try { const o = await withDeadline(rpc.call('getMultipleAccounts', [top.map((t) => t.address), { encoding: 'base64', dataSlice: { offset: 32, length: 32 }, commitment: 'confirmed' }]), 6000, 'owners'); owners = (o?.value || null)?.map((v) => (v?.data?.[0] ? b58(Uint8Array.from(atob(v.data[0]), (ch) => ch.charCodeAt(0))) : null)) || null; } catch { owners = null; }
    if (owners) {
      const pairSet = new Set([...(dex || []).map((p) => p.pairAddress), ...(ray || []).map((p) => p.id), ...(curvePda ? [curvePda] : [])]);
      const rows = top.map((t, i) => {
        const owner = owners[i] || null; // token account layout: mint (0..32), owner (32..64)
        const amt = BigInt(t.amount || '0');
        const kind = !owner ? 'unknown' : BURN_OWNERS.has(owner) ? 'burn' : pairSet.has(owner) ? 'pool' : isOnCurveAddress(owner) ? 'wallet' : 'program';
        return { account: t.address, owner, kind, pct: pct(amt, supply), amt };
      });
      const sum = (f) => rows.filter(f).reduce((s, r) => s + r.amt, 0n);
      const wallets = rows.filter((r) => r.kind === 'wallet');
      // one owner can hold several accounts
      const byOwner = new Map(); for (const w of wallets) byOwner.set(w.owner, (byOwner.get(w.owner) || 0n) + w.amt);
      const walletAmts = [...byOwner.values()].sort((a, b) => (b > a ? 1 : -1));
      holders = {
        available: true, source: 'getTokenLargestAccounts (20 largest accounts) + owner lookup',
        top10_pct: pct(rows.slice(0, 10).reduce((s, r) => s + r.amt, 0n), supply),
        top10_wallets_pct: pct(walletAmts.slice(0, 10).reduce((s, a) => s + a, 0n), supply),
        largest_wallet_pct: walletAmts.length ? pct(walletAmts[0], supply) : 0,
        in_programs_pct: pct(sum((r) => r.kind === 'program' || r.kind === 'pool'), supply),
        burned_pct: pct(sum((r) => r.kind === 'burn'), supply),
        top: rows.slice(0, tier === 'check' ? 20 : 10).map(({ amt, ...r }) => r),
      };
      sources.holders = true;
    }
  }

  // market
  let market = { available: false };
  if (dex) {
    sources.dexscreener = true;
    const pools = dex.filter((p) => p.chainId === 'solana' && (p.baseToken?.address === mint || p.quoteToken?.address === mint))
      .map((p) => ({ address: p.pairAddress, dex: p.dexId, labels: p.labels || [], quote: p.baseToken?.address === mint ? p.quoteToken?.symbol : p.baseToken?.symbol, liquidity_usd: Math.round(p.liquidity?.usd || 0), volume_h24_usd: Math.round(p.volume?.h24 || 0), txns_h24: p.txns?.h24 || null, txns_h1: p.txns?.h1 || null, created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null, url: p.url }))
      .sort((a, b) => b.liquidity_usd - a.liquidity_usd);
    const liq = pools.reduce((s, p) => s + p.liquidity_usd, 0);
    const buys = pools.reduce((s, p) => s + (p.txns_h24?.buys || 0), 0); const sells = pools.reduce((s, p) => s + (p.txns_h24?.sells || 0), 0);
    const first = pools.map((p) => p.created_at).filter(Boolean).sort()[0] || null;
    market = { available: true, source: 'DexScreener', liquidity_usd: liq, pools: pools.length, main_pool: pools[0] || null, volume_h24_usd: pools.reduce((s, p) => s + p.volume_h24_usd, 0), buys_h24: buys, sells_h24: sells, first_pool_at: first, bonding_curve: (pools.length > 0 && pools.every((p) => p.dex === 'pumpfun')) || !!(curve && !curve.complete), all_pools: pools.slice(0, 10) };
  } else if (ray && ray.length) {
    sources.raydium = true;
    const pools = ray.filter((p) => p.mintA?.address === mint || p.mintB?.address === mint)
      .map((p) => ({ address: p.id, dex: `raydium-${String(p.type || '').toLowerCase()}`, quote: p.mintA?.address === mint ? p.mintB?.symbol : p.mintA?.symbol, liquidity_usd: Math.round(Number(p.tvl) || 0), volume_h24_usd: Math.round(Number(p.day?.volume) || 0), lp_burned_pct: p.burnPercent ?? null, created_at: Number(p.openTime) > 0 ? new Date(Number(p.openTime) * 1000).toISOString() : null }))
      .sort((a, b) => b.liquidity_usd - a.liquidity_usd);
    const first = pools.map((p) => p.created_at).filter(Boolean).sort()[0] || null;
    market = { available: true, source: 'Raydium API v3 (DexScreener unavailable; Raydium pools only, no buy/sell counts)', partial: true, liquidity_usd: pools.reduce((s, p) => s + p.liquidity_usd, 0), pools: pools.length, main_pool: pools[0] || null, volume_h24_usd: pools.reduce((s, p) => s + p.volume_h24_usd, 0), buys_h24: null, sells_h24: null, first_pool_at: first, bonding_curve: !!(curve && !curve.complete), all_pools: pools.slice(0, 10) };
  } else if (curve && !curve.complete) {
    market = { available: true, source: 'pump.fun bonding curve account (on-chain)', partial: true, liquidity_usd: null, liquidity_sol: curve.real_sol, pools: 1, main_pool: { address: curvePda, dex: 'pumpfun', liquidity_sol: curve.real_sol }, buys_h24: null, sells_h24: null, first_pool_at: null, bonding_curve: true, all_pools: [] };
  }
  if (curve) market.pump_curve = { address: curvePda, complete: curve.complete, real_sol_reserves: curve.real_sol };
  const age = market.first_pool_at ? { created_at: market.first_pool_at, days: r2((now - Date.parse(market.first_pool_at)) / 86400000), source: `first DEX pool (${market.source.split(' ')[0]})` } : null;

  // ---- findings ----
  const reasons = []; let penalty = 0; let hard = false;
  const add = (severity, code, text, w = 0, isHard = false) => { reasons.push({ severity, code, text }); penalty += w; if (isHard) hard = true; };
  const issuer = known ? ` (${known.issuer}; issuer control by design)` : '';
  if (known) add('info', 'recognized', `Recognized asset: ${known.symbol}, ${known.issuer}.`);
  // authorities
  if (info.freezeAuthority) { if (known) add('info', 'freeze_authority', `Freeze authority is active${issuer}.`); else add('danger', 'freeze_authority', `Freeze authority is active (${short(info.freezeAuthority)}): it can freeze any holder's tokens so they cannot be sold or moved.`, 45, true); }
  else add('good', 'no_freeze', 'Freeze authority is disabled.');
  if (info.mintAuthority) { if (known) add('info', 'mint_authority', `Mint authority is active${issuer}.`); else add('danger', 'mint_authority', `Mint authority is active (${short(info.mintAuthority)}): new supply can be created at any time, diluting holders.`, 35, true); }
  else add('good', 'fixed_supply', 'Mint authority is disabled (fixed supply).');
  // Token-2022 extensions
  const t22 = program === TOKEN_2022;
  const extensions = {};
  if (t22) {
    const tf = ext.transferFeeConfig; const fee = tf ? Number((tf.newerTransferFee || tf.olderTransferFee || {}).transferFeeBasisPoints || 0) / 100 : 0;
    extensions.transfer_fee_pct = fee; extensions.transfer_fee_authority = tf?.transferFeeConfigAuthority || null;
    if (fee >= 10) add('danger', 'transfer_fee', `Transfer fee is ${fee}% on every transfer (including sells).`, 40, true);
    else if (fee > 0) add('warn', 'transfer_fee', `Transfer fee is ${fee}% on every transfer.`, 12);
    if (tf?.transferFeeConfigAuthority && !known) add('warn', 'fee_changeable', `The transfer fee can be changed by ${short(tf.transferFeeConfigAuthority)}.`, 10);
    const pd = ext.permanentDelegate?.delegate || null; extensions.permanent_delegate = pd;
    if (pd) { if (known) add('info', 'permanent_delegate', `Permanent delegate set${issuer}.`); else add('danger', 'permanent_delegate', `Permanent delegate ${short(pd)} can move or burn tokens from ANY holder's account.`, 50, true); }
    const hook = ext.transferHook?.programId || null; extensions.transfer_hook_program = hook;
    if (hook) add(known ? 'info' : 'warn', 'transfer_hook', `Transfer hook program ${short(hook)} runs on every transfer and can block transfers or sells.`, known ? 0 : 20);
    const das = ext.defaultAccountState?.accountState || null; extensions.default_account_state = das;
    if (das === 'frozen' && !known) add('danger', 'default_frozen', 'New token accounts start frozen: buyers may be unable to move or sell until unfrozen.', 45, true);
    if (ext.nonTransferable) { extensions.non_transferable = true; add('danger', 'non_transferable', 'Token is non-transferable (soulbound): it cannot be sold.', 60, true); }
    if (ext.pausableConfig) { extensions.pausable = !!ext.pausableConfig.authority; extensions.paused = !!ext.pausableConfig.paused; if (ext.pausableConfig.paused) add('danger', 'paused', 'Transfers are paused right now.', 60, true); else if (ext.pausableConfig.authority && !known) add('warn', 'pausable', `Transfers can be paused by ${short(ext.pausableConfig.authority)}.`, 15); }
    if (ext.mintCloseAuthority?.closeAuthority) extensions.mint_close_authority = ext.mintCloseAuthority.closeAuthority;
    if (ext.confidentialTransferMint) extensions.confidential_transfers = true;
    if (ext.interestBearingConfig || ext.scaledUiAmountConfig) { extensions.ui_amount_changes = true; add('info', 'ui_amount', 'Displayed balances can change over time (interest-bearing or scaled UI amount extension).'); }
    extensions.list = Object.keys(ext);
  }
  // metadata
  if (metadata?.mutable && metadata.update_authority && !known) add('info', 'mutable_metadata', `Name, symbol and image can still be changed by ${short(metadata.update_authority)}.`, 3);
  else if (metadata && !metadata.mutable) add('good', 'immutable_metadata', 'Metadata is immutable.');
  // market
  if (market.available) {
    if (!market.pools && !market.partial) add('danger', 'no_liquidity', 'No DEX pool found for this token on DexScreener.', 40, true);
    else if (!market.pools) add('info', 'no_raydium_pool', 'No Raydium pool found (DexScreener did not answer, so other DEXes were not checked).', 5);
    else {
      if (market.bonding_curve) add('info', 'bonding_curve', 'Still on the pump.fun bonding curve (not graduated to an AMM pool).', 5);
      else if (market.liquidity_usd == null) add('info', 'liquidity_unknown', 'Liquidity in USD was not available.', 5);
      else if (market.liquidity_usd < 1000) add('danger', 'tiny_liquidity', `Liquidity is only $${fmt(market.liquidity_usd)}.`, 35, true);
      else if (market.liquidity_usd < 10000) add('warn', 'low_liquidity', `Low liquidity: $${fmt(market.liquidity_usd)}.`, 15);
      else add('good', 'liquidity', `Liquidity $${fmt(market.liquidity_usd)} across ${market.pools} pool${market.pools > 1 ? 's' : ''}.`);
      if (market.sells_h24 == null) add('info', 'sells_unchecked', 'Recent buys vs sells were not available from this source; sell blocking was judged from on-chain controls only.');
      else if (market.buys_h24 >= 30 && market.sells_h24 === 0) add('danger', 'no_sells', `${market.buys_h24} buys and 0 sells in 24 h: holders may be unable to sell.`, 45, true);
      else if (market.buys_h24 >= 50 && market.sells_h24 / market.buys_h24 < 0.05) add('warn', 'few_sells', `Only ${market.sells_h24} sells vs ${market.buys_h24} buys in 24 h.`, 15);
    }
  } else add('info', 'market_unknown', 'Market data (DexScreener) did not answer; liquidity and sells were not checked.', 5);
  // holders
  if (holders.available) {
    const w = holders.top10_wallets_pct; const lw = holders.largest_wallet_pct;
    if (!known) {
      if (lw >= 20) add('danger', 'whale', `One wallet holds ${lw}% of supply.`, 25);
      else if (lw >= 10) add('warn', 'large_holder', `Largest wallet holds ${lw}% of supply.`, 10);
      if (w >= 50) add('danger', 'concentrated', `Top 10 wallets hold ${w}% of supply (pools, curves and vaults excluded).`, 25);
      else if (w >= 30) add('warn', 'top10', `Top 10 wallets hold ${w}% of supply (pools, curves and vaults excluded).`, 10);
      else add('good', 'distributed', `Top 10 wallets hold ${w}% of supply (pools, curves and vaults excluded).`);
    }
  } else if (tier !== 'lite') add('info', 'holders_unknown', 'Holder concentration is unavailable right now (public RPC refused the largest-accounts query); re-check before trading.', 5);
  if (age && !known) {
    if (age.days < 1) add('warn', 'brand_new', `Brand new: first pool ${Math.max(1, Math.round(age.days * 24))} h ago; controls can look clean while the launch is still being distributed.`, 26);
    else if (age.days < 7) add('info', 'new', `New: first pool ${Math.round(age.days)} days ago.`, 7);
  }

  const missing = [...(!market.available || (market.partial && !market.pools) ? ['market'] : []), ...(tier !== 'lite' && !holders.available && !known ? ['holders'] : []), ...(!sources.metadata ? ['metadata'] : [])];
  const degraded = missing.length > 0;
  let score = Math.max(0, Math.min(100, 100 - penalty));
  if (hard) score = Math.min(score, 20);
  if (known && !hard) score = Math.max(score, 85);
  let verdict = hard || score < 45 ? 'DANGER' : score >= 75 ? 'SAFE' : 'CAUTION';
  // A source that did not answer is never read as clean: no SAFE on incomplete data (unless a recognized issuer asset).
  if (verdict === 'SAFE' && degraded && !known) { verdict = 'CAUTION'; score = Math.min(score, 74); add('warn', 'incomplete', `Not all checks ran (${missing.join(', ')} unavailable); re-check before relying on this.`); }
  let confidence = !degraded ? 'high' : missing.includes('market') ? 'low' : 'medium';
  if (degraded && verdict === 'SAFE' && confidence !== 'high') confidence = 'low';
  const order = { danger: 0, warn: 1, info: 2, good: 3 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    mint, chain: 'solana', name: metadata?.name || null, symbol: metadata?.symbol || null, decimals, supply: supply.toString(),
    verdict, score, confidence, degraded, ...(degraded ? { missing_data: missing } : {}), reasons,
    checks: {
      authorities: { mint_authority: info.mintAuthority || null, freeze_authority: info.freezeAuthority || null },
      program: t22 ? 'token-2022' : 'spl-token', extensions: t22 ? extensions : null,
      metadata, market, holders, age, recognized: known ? known.issuer : null,
    },
    sources, limits: LIMITS, disclaimer: DISCLAIMER, engine: ENGINE_VERSION, tier, checked_at: new Date(now).toISOString(),
  };
}
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/** Views per tier. */
export function previewView(r) {
  const c = { danger: 0, warn: 0 }; for (const x of r.reasons) if (c[x.severity] != null) c[x.severity]++;
  return { mint: r.mint, chain: r.chain, name: r.name, symbol: r.symbol, verdict: r.verdict, score: r.score, confidence: r.confidence, degraded: !!r.degraded, flags: c, liquidity_usd: r.checks.market.liquidity_usd ?? null, engine: r.engine, checked_at: r.checked_at, tier: 'preview', disclaimer: r.disclaimer };
}
export function keyFacts(r) {
  const c = r.checks; const e = c.extensions || {};
  return { mint_authority_disabled: !c.authorities.mint_authority, freeze_authority_disabled: !c.authorities.freeze_authority, program: c.program, transfer_fee_pct: e.transfer_fee_pct ?? 0, permanent_delegate: !!e.permanent_delegate, transfer_hook: !!e.transfer_hook_program, metadata_mutable: c.metadata ? !!c.metadata.mutable : null, liquidity_usd: c.market.liquidity_usd ?? null, sells_h24: c.market.sells_h24 ?? null, bonding_curve: c.market.bonding_curve ?? null, top10_wallets_pct: c.holders.top10_wallets_pct ?? null, age_days: c.age?.days ?? null };
}
export function liteView(r) {
  return {
    mint: r.mint, chain: r.chain, name: r.name, symbol: r.symbol, verdict: r.verdict, score: r.score, confidence: r.confidence, degraded: !!r.degraded, ...(r.missing_data ? { missing_data: r.missing_data } : {}),
    reasons: r.reasons.map((x) => ({ severity: x.severity, code: x.code, text: x.text })), key: keyFacts(r),
    engine: r.engine, checked_at: r.checked_at, tier: 'lite', disclaimer: r.disclaimer,
  };
}
