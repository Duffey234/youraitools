// TokenVerdict engine: Base (eip155:8453) ERC-20 safety check from free public data only.
//   On-chain (public Base RPC): bytecode, owner, EIP-1967 / beacon / EIP-1167 proxy slots, supply, LP burn,
//     and a buy -> wallet transfer -> sell simulation in a single eth_call (see sim.js; nothing is sent).
//   Sourcify: verified source ABI. On-chain: factory pools, pool balances, Chainlink ETH/USD, creation block, v4 logs.
//   DexScreener / GeckoTerminal: pools, liquidity,
//     holder distribution.
// Every source is best-effort with its own deadline: a missing source lowers confidence, it never fails the call.
import { makeRpc, ARCHIVE_RPCS, LOGS_RPCS, encAddr, asAddr, asUint, asString } from './rpc.js';
import { probePools, simulate, resolveV4Key, WETH, NATIVE } from './sim.js';
import { factoryPools, creationBlock, v4PoolsFromLogs, v4Liquidity } from './discover.js';
import { SELECTORS } from './selectors.js';
import { RECOGNIZED, BURN_ADDRS } from './known.js';
import { withDeadline } from './deadline.js';

export const ENGINE_VERSION = 'tokenverdict-0.1';
export const DISCLAIMER = 'Automated, informational risk signals from public on-chain and market data at the time of the check. Not financial advice, not an audit, no guarantee: a token that passes can still lose value or be changed later by whoever controls it.';
export const LIMITS = [
  'Sell simulation runs in one block from a contract address: tokens that block contracts, enforce cooldowns or change rules later can behave differently for a real wallet.',
  'Uniswap v4 hooks can charge fees or change behavior per swap; the simulation reflects the hook at the time of the check.',
  'Owner powers come from the verified ABI or, if unverified, from function selectors in the bytecode: renamed or hidden functions can be missed.',
  'LP lock status is only verified for burned LP tokens on v2-style pools; third-party lockers and concentrated-liquidity positions are not checked.',
  'Holder concentration comes from GeckoTerminal snapshots and can include pools, lockers and exchanges.',
];

export class InputError extends Error { constructor(msg, status = 400, code = 'bad_request') { super(msg); this.status = status; this.code = code; } }

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export function normalizeToken(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new InputError('"token" is required: a Base ERC-20 contract address, e.g. 0x532f27101965dd16442E59d40670FaF5eBB142E4');
  if (!ADDR_RE.test(s)) throw new InputError('"token" must be a 0x-prefixed 40-hex-character Base contract address');
  const a = s.toLowerCase();
  if (/^0x0{40}$/.test(a)) throw new InputError('"token" cannot be the zero address');
  return a;
}

const S = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd', owner: '0x8da5cb5b', getOwner: '0x893d20e8', balanceOf: '0x70a08231', implementation: '0x5c60da1b', hasRole: '91d14854', grantRole: '2f2ff15d' };
const SLOT = {
  impl: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  ozLegacy: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
};
const ZERO = '0x0000000000000000000000000000000000000000';
const isBurn = (a) => !a || BURN_ADDRS.includes(String(a).toLowerCase());
const ec = (to, data) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });
const ok = (r) => (r && !r.error ? r.result : null);

async function jget(fetchImpl, url, ms = 5000) {
  try {
    const res = await withDeadline(fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'TokenVerdict/0.1 (+https://api.youraitools.co/tokenverdict)' } }), ms, url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Function-name based power detection from a verified ABI. */
const NAME_RULES = {
  mint: /^(mint|mintTo|mintFor|issue|configureMinter|increaseSupply|createTokens|mintTokens)$/i,
  blacklist: /(black|bot|sniper|frozen|freeze|block(ed)?Address|setBlocked|denylist)/i,
  pause: /^(pause|unpause|setPaused|togglePause)$/i,
  fees: /^(set|update|change|reduce)\w*(fee|tax)/i,
  trading: /^(enableTrading|openTrading|startTrading|setTrading\w*|launch)$/i,
  limits: /(maxTx|maxWallet|maxTxn|removeLimits|setCooldown|maxTransaction)/i,
  balance: /^(setBalance|setBalances|adminBurn|destroyBlackFunds)$/i,
  upgrade: /^(upgradeTo|upgradeToAndCall)$/i,
};
function powersFromAbi(abi) {
  const fns = (abi || []).filter((x) => x?.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure');
  const out = {};
  for (const [k, re] of Object.entries(NAME_RULES)) out[k] = fns.filter((f) => re.test(f.name)).map((f) => `${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})`).slice(0, 8);
  out.access_control = (abi || []).some((x) => x?.type === 'function' && x.name === 'grantRole');
  return out;
}
function powersFromBytecode(code) {
  const h = (code || '').toLowerCase();
  const out = {};
  for (const [k, list] of Object.entries(SELECTORS)) {
    if (k === 'ownership') continue;
    out[k] = list.filter(([sel]) => h.includes(`63${sel}`)).map(([, sig]) => sig).slice(0, 8);
  }
  out.access_control = h.includes(`63${S.grantRole}`) && h.includes(`63${S.hasRole}`);
  return out;
}
const merge = (a, b) => { if (!b) return a; const o = { ...a }; for (const k of Object.keys(b)) o[k] = Array.isArray(a[k]) ? [...new Set([...(a[k] || []), ...(b[k] || [])])] : (a[k] || b[k]); return o; };

function minimalProxyTarget(code) {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i.exec(code || '');
  return m ? `0x${m[1].toLowerCase()}` : null;
}

/**
 * Run the analysis.
 * @param {string} token normalized lowercase address
 * @param {{tier?: 'preview'|'lite'|'quick'|'deep', fetchImpl?: Function, rpc?: any, now?: number}} [o]
 */
export async function analyzeToken(token, o = {}) {
  token = String(token).trim().toLowerCase();
  const tier = o.tier || 'quick';
  const deep = tier === 'deep';
  const fetchImpl = o.fetchImpl || ((...a) => globalThis.fetch(...a));
  const rpc = o.rpc || makeRpc({ fetchImpl });
  const rpcArchive = o.rpcArchive || (o.rpc ? o.rpc : makeRpc({ fetchImpl, urls: ARCHIVE_RPCS }));
  const rpcLogs = o.rpcLogs || (o.rpc ? o.rpc : makeRpc({ fetchImpl, urls: LOGS_RPCS }));
  const now = o.now || Date.now();
  const sources = { rpc: false, dexscreener: false, geckoterminal: false, sourcify: false, onchain_pools: false };

  // ---- round 1: chain basics + market + verification, in parallel ----
  const chainP = rpc.batch([
    { method: 'eth_getCode', params: [token, 'latest'] },
    ec(token, S.name), ec(token, S.symbol), ec(token, S.decimals), ec(token, S.totalSupply), ec(token, S.owner), ec(token, S.getOwner),
    { method: 'eth_getStorageAt', params: [token, SLOT.impl, 'latest'] }, { method: 'eth_getStorageAt', params: [token, SLOT.admin, 'latest'] },
    { method: 'eth_getStorageAt', params: [token, SLOT.beacon, 'latest'] }, { method: 'eth_getStorageAt', params: [token, SLOT.ozLegacy, 'latest'] },
    ec(token, S.balanceOf + encAddr(ZERO)), ec(token, S.balanceOf + encAddr('0x000000000000000000000000000000000000dead')),
    { method: 'eth_blockNumber', params: [] },
  ]);
  const dexP = jget(fetchImpl, `https://api.dexscreener.com/tokens/v1/base/${token}`).then((d) => d || jget(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${token}`).then((x) => (Array.isArray(x?.pairs) ? x.pairs : null)));
  const factoryP = factoryPools(rpc, token).catch((e) => { console.log(JSON.stringify({ ev: 'factory_failed', token, err: String(e?.message || e).slice(0, 160) })); return null; });
  const geckoP = jget(fetchImpl, `https://api.geckoterminal.com/api/v2/networks/base/tokens/${token}/info`);
  const srcP = jget(fetchImpl, `https://sourcify.dev/server/v2/contract/8453/${token}?fields=abi`);

  let chain;
  try { chain = await chainP; } catch (e) { const err = new InputError(`Base RPC unavailable (${e.message}). Not charged; retry shortly.`, 503, 'rpc_unavailable'); throw err; }
  sources.rpc = true;
  const [code, nameR, symR, decR, tsR, ownR, gownR, implS, adminS, beaconS, legacyS, bal0R, balDeadR, headR] = chain.map(ok);
  if (!code || code === '0x') throw new InputError('No contract at this address on Base mainnet (EOA or wrong chain). Not charged.', 422, 'not_a_contract');
  const head = headR ? Number(BigInt(headR)) : null;
  // creation block (age, and the start of the Uniswap v4 Initialize log search); archive RPC, k-ary search, best effort
  const createdP = head ? creationBlock(rpcArchive, token, head).then(async (b) => {
    if (b == null) return null;
    const blk = await rpcArchive.call('eth_getBlockByNumber', ['0x' + b.toString(16), false]).catch(() => null);
    return { block: b, ts: blk?.timestamp ? Number(BigInt(blk.timestamp)) * 1000 : null };
  }).catch(() => null) : Promise.resolve(null);
  const decimals = asUint(decR); const totalSupply = asUint(tsR);
  if (decimals == null || totalSupply == null || decimals > 255n) throw new InputError('This contract does not answer decimals() / totalSupply(), so it is not an ERC-20 token. Not charged.', 422, 'not_erc20');
  const name = asString(nameR); const symbol = asString(symR);

  // ---- proxy detection ----
  const slotAddr = (v) => { const a = asAddr(v); return a && !/^0x0{40}$/.test(a) ? a.toLowerCase() : null; };
  let proxy = { upgradeable: false, type: null, implementation: null, admin: null, admin_owner: null };
  const impl1967 = slotAddr(implS); const beacon = slotAddr(beaconS); const legacy = slotAddr(legacyS); const minimal = minimalProxyTarget(code);
  if (impl1967) proxy = { ...proxy, upgradeable: true, type: 'EIP-1967', implementation: impl1967, admin: slotAddr(adminS) };
  else if (beacon) proxy = { ...proxy, upgradeable: true, type: 'EIP-1967 beacon', beacon };
  else if (legacy) proxy = { ...proxy, upgradeable: true, type: 'OpenZeppelin legacy proxy', implementation: legacy };
  else if (minimal) proxy = { ...proxy, upgradeable: false, type: 'EIP-1167 minimal proxy (not upgradeable)', implementation: minimal };

  const burnedSupplyPctEarly = totalSupply > 0n ? Number(((asUint(bal0R) || 0n) + (asUint(balDeadR) || 0n)) * 10000n / totalSupply) / 100 : 0;
  const ownerRaw = asAddr(ownR) || asAddr(gownR);
  const owner = ownerRaw ? ownerRaw.toLowerCase() : null;

  // ---- market data: DexScreener (+ GeckoTerminal) merged with on-chain factory pools and v4 Initialize logs ----
  const [dex, gecko, src, fac, created] = await Promise.all([dexP, geckoP, srcP, factoryP, createdP]);
  const pairs = (Array.isArray(dex) ? dex : []).filter((p) => p?.chainId === 'base');
  if (Array.isArray(dex)) sources.dexscreener = true;
  const ginfo = gecko?.data?.attributes || null; if (ginfo) sources.geckoterminal = true;
  if (src?.abi) sources.sourcify = true;
  if (fac) sources.onchain_pools = true;
  let pools = pairs.map((p) => ({ address: String(p.pairAddress || ''), dex: p.dexId, labels: p.labels || [], liquidity_usd: Number(p.liquidity?.usd || 0), liquidity_quote: Number(p.liquidity?.quote || 0), quote: String(p.quoteToken?.address || '').toLowerCase(), quote_symbol: p.quoteToken?.symbol, base: String(p.baseToken?.address || '').toLowerCase(), created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null, txns_h24: p.txns?.h24 || null, volume_h24: Number(p.volume?.h24 || 0), source: 'DexScreener' }));
  const known4 = new Set(pools.map((p) => p.address.toLowerCase()));
  for (const fp of fac?.pools || []) {
    const ex = pools.find((p) => p.address.toLowerCase() === fp.address);
    if (ex) { if (!ex.liquidity_usd) { ex.liquidity_usd = fp.liquidity_usd; ex.source = 'on-chain estimate'; } }
    else pools.push({ address: fp.address, dex: fp.dex, labels: [fp.kind], liquidity_usd: fp.liquidity_usd, liquidity_quote: 0, quote: fp.quote, quote_symbol: fp.quote_symbol, base: token, created_at: null, txns_h24: null, volume_h24: null, source: 'on-chain estimate' });
  }
  // Uniswap v4 pools: DexScreener lists them by PoolId; otherwise look for Initialize logs right after creation
  let v4Logged = []; let v4SearchFailed = false;
  const hasV4 = pools.some((p) => /^0x[0-9a-fA-F]{64}$/.test(p.address));
  if (!hasV4 && created?.block && head && head - created.block < 400000) {
    try { v4Logged = await v4PoolsFromLogs(rpcLogs, token, created.block, head); }
    catch { // publicnode rate-limited (or old logs): most launchpad v4 pools are initialized within a few blocks of creation
      try { v4Logged = await v4PoolsFromLogs(rpcArchive, token, created.block, head, 9); } catch { v4SearchFailed = true; }
    }
    if (v4Logged.length) {
      try { v4Logged = await v4Liquidity(rpc, v4Logged, fac?.ethUsd); } catch { /* keep */ }
      for (const v of v4Logged) if (!known4.has(v.address.toLowerCase())) pools.push({ address: v.address, dex: 'uniswap', labels: ['v4'], liquidity_usd: v.liquidity_usd || 0, liquidity_quote: 0, quote: v.quote, quote_symbol: v.quote_symbol || null, base: token, created_at: created.ts ? new Date(created.ts).toISOString() : null, txns_h24: null, volume_h24: null, source: v.source || 'on-chain v4', key: v.key });
    }
  }
  pools = pools.sort((a, b) => b.liquidity_usd - a.liquidity_usd);
  const marketKnown = sources.dexscreener || sources.onchain_pools;
  const evmPools = pools.filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p.address));
  const probeList = evmPools.slice(0, deep ? 4 : 3).map((p) => p.address);
  const r2 = [];
  if (proxy.implementation) r2.push({ k: 'implCode', c: { method: 'eth_getCode', params: [proxy.implementation, 'latest'] } });
  if (proxy.beacon) r2.push({ k: 'beaconImpl', c: ec(proxy.beacon, S.implementation) });
  if (proxy.admin) r2.push({ k: 'adminCode', c: { method: 'eth_getCode', params: [proxy.admin, 'latest'] } }, { k: 'adminOwner', c: ec(proxy.admin, S.owner) });
  if (owner && !isBurn(owner)) r2.push({ k: 'ownerCode', c: { method: 'eth_getCode', params: [owner, 'latest'] } });
  // token balances held by pools (v2/v3 pool contracts, and the v4 PoolManager singleton) to adjust holder concentration
  const poolHolders = evmPools.slice(0, 6).map((p) => p.address.toLowerCase());
  if (pools.some((p) => /^0x[0-9a-fA-F]{64}$/.test(p.address))) poolHolders.push('0x498581ff718922c3f8e6a244956af099b2652b2b');
  poolHolders.forEach((a, i) => r2.push({ k: `pb${i}`, c: ec(token, S.balanceOf + encAddr(a)) }));
  let r2res = {}; let poolInfo = [];
  try {
    const [res, pi] = await Promise.all([rpc.batch(r2.map((x) => x.c)), probeList.length ? probePools(rpc, probeList) : []]);
    r2.forEach((x, i) => { r2res[x.k] = ok(res[i]); });
    poolInfo = pi;
  } catch (e) { console.log(JSON.stringify({ ev: "round2_failed", token, err: String(e?.message || e).slice(0, 160) })); /* partial data */ }
  if (proxy.beacon && r2res.beaconImpl) {
    proxy.implementation = slotAddr(r2res.beaconImpl);
    if (proxy.implementation) { try { r2res.implCode = await rpc.call('eth_getCode', [proxy.implementation, 'latest']); } catch { /* keep */ } }
  }
  if (proxy.admin) proxy.admin_owner = slotAddr(r2res.adminOwner) || null;
  const ownerIsContract = !!(r2res.ownerCode && r2res.ownerCode !== '0x');

  // ---- verification + powers ----
  let abiSrc = src?.abi ? 'sourcify' : null; let abi = src?.abi || null;
  let verified = !!src?.abi;
  let verifiedBy = src?.abi ? 'Sourcify' : null;
  let implAbi = null;
  if (proxy.implementation) {
    const ia = await jget(fetchImpl, `https://sourcify.dev/server/v2/contract/8453/${proxy.implementation}?fields=abi`, 4000);
    if (ia?.abi) implAbi = ia.abi;
  }
  let powers = abi ? powersFromAbi(abi) : powersFromBytecode(code);
  let powersSource = abi ? `verified ABI (${abiSrc})` : 'bytecode selectors (unverified)';
  if (proxy.implementation) {
    const ip = implAbi ? powersFromAbi(implAbi) : powersFromBytecode(r2res.implCode || '');
    powers = merge(powers, ip);
    powersSource += implAbi ? ' + implementation ABI' : r2res.implCode ? ' + implementation bytecode' : '';
    if (implAbi && !verified) { verified = true; verifiedBy = 'Sourcify (implementation)'; }
  }

  // ---- pick pools and simulate (WETH / native ETH quoted pools preferred) ----
  const known = RECOGNIZED[token] || null;
  const metaOf = (addr) => pools.find((x) => x.address.toLowerCase() === String(addr).toLowerCase());
  if (o.debug) console.error("probe", probeList, JSON.stringify(poolInfo));
  const simulatable = poolInfo.filter((p) => p.kind && (p.token0 === token || p.token1 === token));
  const v4Pools = pools.filter((p) => /^0x[0-9a-fA-F]{64}$/.test(p.address));
  const weight = (m, quote) => (m?.liquidity_usd || 0) * (quote === WETH || quote === NATIVE ? 3 : 1) + 1;
  const cands = [
    ...simulatable.map((p) => ({ p, m: metaOf(p.address), w: weight(metaOf(p.address), p.token0 === token ? p.token1 : p.token0) })),
    ...v4Pools.slice(0, 2).map((m) => ({ v4: true, m, w: weight(m, m.quote) })),
  ].sort((a, b) => b.w - a.w).slice(0, deep ? 2 : 1);
  const sims = [];
  for (const c of cands) {
    const m = c.m;
    try {
      let p = c.p; let amt;
      if (c.v4) {
        const key = m.key || await resolveV4Key(rpc, m.address, m.created_at ? Date.parse(m.created_at) : null, now);
        if (!key || (key.currency0 !== token && key.currency1 !== token)) { sims.push({ pool: m.address, pool_type: 'v4', simulated: false, reason: 'Uniswap v4 pool key not found' }); continue; }
        p = { address: m.address, kind: 'v4', key, token0: key.currency0, token1: key.currency1 };
        const quote = key.currency0 === token ? key.currency1 : key.currency0;
        const liqQ = Number(m.liquidity_quote || 0) || ((quote === NATIVE || quote === WETH) && fac?.ethUsd && m.liquidity_usd ? m.liquidity_usd / 2 / fac.ethUsd : 0);
        if (quote === NATIVE || quote === WETH) {
          const eth = Math.min(Math.max(liqQ * 0.002, 0.0001), 0.05);
          amt = BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
        } else {
          const dec = Number(asUint(await rpc.call('eth_call', [{ to: quote, data: S.decimals }, 'latest'])) ?? 18n);
          const units = liqQ * 0.002 > 0 ? liqQ * 0.002 : 0.001;
          amt = BigInt(Math.max(1, Math.round(units * 1e6))) * 10n ** BigInt(Math.max(0, dec - 6));
        }
      } else {
        const quote = p.token0 === token ? p.token1 : p.token0;
        const bal = asUint(await rpc.call('eth_call', [{ to: quote, data: S.balanceOf + encAddr(p.address) }, 'latest']));
        if (!bal || bal === 0n) { sims.push({ pool: p.address, pool_type: p.kind, simulated: false, reason: 'pool holds no quote token' }); continue; }
        amt = bal / 500n; // 0.2% of the pool's quote balance
        if (quote === WETH) { const cap = 5n * 10n ** 16n, min = 10n ** 13n; if (amt > cap) amt = cap; if (amt < min) amt = bal / 50n; }
      }
      if (!amt || amt === 0n) { sims.push({ pool: p.address, pool_type: p.kind, simulated: false, reason: 'pool too small to simulate' }); continue; }
      let s; try { s = await simulate(rpc, p, token, amt); } catch (e1) { await new Promise((r) => setTimeout(r, 400)); s = await simulate(rpc, p, token, amt); } // one retry: public RPCs rate-limit in bursts
      sims.push({ ...s, pool_type: p.kind, dex: m?.dex || null, liquidity_usd: m?.liquidity_usd ?? null });
    } catch (e) { sims.push({ pool: c.p?.address || m?.address, simulated: false, reason: `simulation unavailable: ${String(e?.message || e).slice(0, 100)}` }); }
  }
  if (o.debug) console.error("sims", cands.length, JSON.stringify(sims).slice(0, 600));
  if (!sims.some((s) => s.simulated)) console.log(JSON.stringify({ ev: "sim_unavailable", token, cands: cands.length, probed: poolInfo.length, pools: pools.length, sims: sims.map((s) => s.reason || (s.sell && s.sell.error) || null) }));
  const sim = sims.find((s) => s.simulated) || sims[0] || null;

  // ---- LP burn (v2-style main pool) ----
  let lp = null;
  const v2main = simulatable.find((p) => p.kind === 'v2' || p.kind === 'solidly');
  if (v2main) {
    try {
      const res = await rpc.batch([ec(v2main.address, S.totalSupply), ec(v2main.address, S.balanceOf + encAddr(ZERO)), ec(v2main.address, S.balanceOf + encAddr('0x000000000000000000000000000000000000dead'))]);
      const [ts, b0, bd] = res.map((r) => asUint(ok(r)));
      if (ts && ts > 0n) lp = { pool: v2main.address, pool_type: v2main.kind, burned_pct: Number(((b0 || 0n) + (bd || 0n)) * 10000n / ts) / 100, lock_checked: false, note: 'Only burned LP (sent to 0x0 / 0xdEaD) is verified; third-party lockers are not checked.' };
    } catch { /* skip */ }
  }

  // ---- holders ----
  const gh = ginfo?.holders;
  const rawTop10 = gh?.distribution_percentage?.top_10 != null ? Number(gh.distribution_percentage.top_10) : null;
  const holders = { count: gh?.count ?? null, top10_pct: rawTop10 != null && rawTop10 <= 100 ? Math.round(rawTop10 * 10) / 10 : null, source: gh ? 'GeckoTerminal' : null, includes_pools: true };
  let poolHeld = 0n; poolHolders.forEach((_, i) => { poolHeld += asUint(r2res[`pb${i}`]) || 0n; });
  holders.in_pools_pct = totalSupply > 0n ? Number(poolHeld * 10000n / totalSupply) / 100 : null;
  if (holders.top10_pct != null && holders.in_pools_pct != null) holders.top10_ex_pools_est_pct = Math.max(0, Math.round((holders.top10_pct - holders.in_pools_pct - Math.min(burnedSupplyPctEarly, holders.top10_pct)) * 10) / 10);
  // ---- age ----
  let age = null;
  if (created?.ts) age = { created_at: new Date(created.ts).toISOString(), block: created.block, source: 'contract creation (on-chain)' };
  if (!age) {
    const firstPool = pools.map((p) => p.created_at).filter(Boolean).sort()[0];
    if (firstPool) age = { created_at: firstPool, source: 'first DEX pool (DexScreener)' };
  }
  if (age) age.days = Math.max(0, Math.round((now - Date.parse(age.created_at)) / 864e3) / 100);

  // ---- liquidity ----
  const liquidityUsd = pools.reduce((s, p) => s + (p.liquidity_usd || 0), 0);
  const burnedSupplyPct = totalSupply > 0n ? Number(((asUint(bal0R) || 0n) + (asUint(balDeadR) || 0n)) * 10000n / totalSupply) / 100 : null;

  // ---- verdict ----
  const reasons = [];
  let penalty = 0; let hard = false;
  const add = (severity, code, text, p = 0, isHard = false) => { reasons.push({ severity, code, text }); penalty += p; if (isHard) hard = true; };
  const ownerLive = !!owner && !isBurn(owner);
  const controller = ownerLive || powers.access_control || (proxy.upgradeable && !isBurn(proxy.admin_owner || proxy.admin));
  const ctl = (list) => list && list.length > 0;

  if (known) add('info', 'recognized_asset', `${known.symbol} is a recognized Base asset (${known.issuer}); issuer controls below are by design.`);
  // sellability
  if (sim?.simulated) {
    const sellTax = sim.sell?.tax_pct ?? null; const buyTax = sim.buy?.tax_pct ?? null; const xferTax = sim.transfer?.tax_pct ?? null;
    if (!sim.buy.ok) add('warn', 'buy_failed', `A simulated buy on the ${sim.dex || sim.pool_type} pool failed (${sim.buy.error}). Trading may be disabled or restricted.`, 20);
    else if (sim.sell && !sim.sell.ok) {
      if (sim.pool_type === 'v3' && sim.transfer?.ok && (xferTax ?? 0) > 0) add('warn', 'fot_v3', `Selling on the concentrated-liquidity pool reverted because the token takes a ${xferTax}% transfer fee (such pools can't handle fee-on-transfer tokens).`, 15);
      else add('danger', 'honeypot', `HONEYPOT SIGNAL: a simulated buy worked but selling back failed (${sim.sell.error}).`, 60, !known);
    } else {
      const t = Math.max(buyTax || 0, sellTax || 0);
      if (t >= 30) add('danger', 'extreme_tax', `Extreme tax: buy ${buyTax}% / sell ${sellTax}%.`, 50, true);
      else if (t >= 10) add('warn', 'high_tax', `High tax: buy ${buyTax}% / sell ${sellTax}%.`, 25);
      else if (t >= 5) add('warn', 'tax', `Tax: buy ${buyTax}% / sell ${sellTax}%.`, 10);
      else if (t > 0.5) add('info', 'small_tax', `Small tax: buy ${buyTax}% / sell ${sellTax}%.`, 3);
      else add('good', 'sellable', `Simulated buy and sell both worked with no token tax (round trip lost ${sim.round_trip_loss_pct ?? '?'}% to pool/hook fees and price impact).`);
      const rt = sim.round_trip_loss_pct;
      if (rt != null && t < 10) {
        if (rt >= 30) add('danger', 'round_trip_loss', `Buying then selling right away returned ${Math.round(100 - rt)}% of the money (${rt}% lost to fees, hooks or slippage).`, 40, true);
        else if (rt >= 10) add('warn', 'round_trip_loss', `Buying then selling right away loses ${rt}% (fees, hooks or slippage).`, 12);
      }
    }
    if (sim.transfer && !sim.transfer.ok) add('danger', 'transfer_blocked', 'A simulated wallet-to-wallet transfer failed.', 40, !known);
    else if ((xferTax ?? 0) >= 10) add('warn', 'transfer_tax', `Wallet transfers lose ${xferTax}%.`, 10);
  } else if (!known) {
    add('warn', 'not_simulated', `Sellability not verified: ${sim?.reason || (pools.length ? 'no supported pool (Uniswap v2/v3/v4, Aerodrome, Pancake) with this token' : 'no DEX pool found')}.`, 10);
  }
  if (ginfo?.is_honeypot === true && !known) add('danger', 'gt_honeypot', 'GeckoTerminal flags this token as a honeypot.', 30);

  // owner powers
  if (!known) {
    if (ctl(powers.balance) && controller) add('danger', 'balance_control', `Privileged balance function present: ${powers.balance.join(', ')}.`, 40, true);
    if (ctl(powers.mint) && controller) add('warn', 'mintable', `Supply can be increased: ${powers.mint.join(', ')}${ownerLive ? ` (owner ${short(owner)})` : ''}.`, 25);
    if (ctl(powers.blacklist) && controller) add('warn', 'blacklist', `Addresses can be blocked: ${powers.blacklist.slice(0, 3).join(', ')}.`, 20);
    if (ctl(powers.pause) && controller) add('warn', 'pausable', 'Transfers can be paused.', 15);
    if (ctl(powers.fees) && controller) add('warn', 'mutable_tax', `Taxes can be changed: ${powers.fees.slice(0, 3).join(', ')}.`, 15);
    if (ctl(powers.trading) && controller) add('info', 'trading_switch', 'Owner controls a trading on/off switch.', 8);
    if (ctl(powers.limits) && controller) add('info', 'limits', 'Owner controls max-transaction / max-wallet limits.', 4);
    if (proxy.upgradeable) {
      const adm = proxy.admin_owner || proxy.admin;
      if (adm && isBurn(adm)) add('info', 'proxy_frozen', 'Upgradeable proxy, but its admin is renounced.', 3);
      else add('warn', 'upgradeable', `Upgradeable proxy (${proxy.type}): the code can be replaced${adm ? ` by ${short(adm)}` : ''}.`, 25);
    }
    if (owner && isBurn(owner)) add('good', 'renounced', 'Ownership renounced.');
    else if (ownerLive && !reasons.some((r) => ['mintable', 'blacklist', 'pausable', 'mutable_tax', 'balance_control'].includes(r.code))) add('info', 'owner_active', `Owner ${short(owner)}${ownerIsContract ? ' (a contract: multisig/timelock?)' : ''} is active but no major owner powers were found.`, 5);
    else if (!owner && !powers.access_control) add('good', 'no_owner', 'No owner function found.');
    if (powers.access_control) add('info', 'roles', 'Uses role-based access control; role holders are not enumerated.', 5);
    if (!verified) add('warn', 'unverified', 'Contract source is not verified (Sourcify): hidden logic cannot be ruled out.', 20);
    else add('good', 'verified', `Source verified (${verifiedBy}).`);
  } else {
    const ctrlNames = ['mint', 'blacklist', 'pause'].filter((k) => ctl(powers[k]));
    if (ctrlNames.length || proxy.upgradeable) add('info', 'issuer_controls', `Issuer controls present: ${[...ctrlNames, ...(proxy.upgradeable ? ['upgradeable'] : [])].join(', ')}.`);
  }
  // liquidity
  if (!known) {
    if (!marketKnown) add('warn', 'liquidity_unknown', 'Liquidity could not be measured right now (market data and on-chain pool lookups unavailable). Re-check before trading.', 15);
    else if (!pools.length && sources.dexscreener) add('danger', 'no_liquidity', 'No DEX liquidity found on Base.', 40, true);
    else if (!pools.length && v4SearchFailed) add('warn', 'liquidity_unknown', 'Liquidity could not be measured right now (market data unavailable and the Uniswap v4 pool lookup failed). Re-check before trading.', 15);
    else if (!pools.length) add('danger', 'no_liquidity_onchain', 'No pool found on the main Base DEXes (Uniswap v2/v3/v4, Aerodrome, PancakeSwap v3) against WETH/USDC; market API unavailable, so other venues were not checked.', 30);
    else if (liquidityUsd < 1000 && sources.dexscreener) add('danger', 'tiny_liquidity', `Liquidity is only $${fmt(liquidityUsd)}.`, 35, true);
    else if (liquidityUsd < 1000) add('danger', 'tiny_liquidity_est', `On-chain liquidity estimate is only $${fmt(liquidityUsd)} (market API unavailable; other venues not checked).`, 30, liquidityUsd < 100);
    else if (liquidityUsd < 10000) add('warn', 'low_liquidity', `Low liquidity: $${fmt(liquidityUsd)}.`, 20);
    else if (liquidityUsd < 50000) add('info', 'modest_liquidity', `Modest liquidity: $${fmt(liquidityUsd)}.`, 8);
    else add('good', 'liquidity', `Liquidity $${fmt(liquidityUsd)} across ${pools.length} pool${pools.length === 1 ? '' : 's'}.`);
    if (lp) {
      if (lp.burned_pct >= 95) add('good', 'lp_burned', `${lp.burned_pct}% of the main v2 LP is burned.`);
      else if (lp.burned_pct < 50) add('info', 'lp_not_burned', `Only ${lp.burned_pct}% of the main v2 LP is burned (locks not checked).`, 5);
    }
    // holders
    const t10 = holders.top10_ex_pools_pct ?? holders.top10_ex_pools_est_pct ?? holders.top10_pct;
    const t10label = holders.top10_ex_pools_pct != null ? 'excluding pools and burn' : holders.top10_ex_pools_est_pct != null ? 'estimate excluding pools and burn' : 'may include pools';
    if (t10 != null) {
      if (t10 >= 80) add('warn', 'concentrated', `Top 10 holders own ${t10}% (${t10label}).`, 20);
      else if (t10 >= 50) add('warn', 'top_heavy', `Top 10 holders own ${t10}% (${t10label}).`, 10);
      else if (t10 >= 30) add('info', 'top10', `Top 10 holders own ${t10}% (${t10label}).`, 3);
      else add('good', 'distributed', `Top 10 holders own ${t10}% (${t10label}).`);
    } else add('info', 'holders_unknown', 'Holder concentration is unavailable right now (the GeckoTerminal snapshot did not answer); re-check before trading.', 5);
    // age
    if (age) {
      if (age.days < 1) add('warn', 'brand_new', `Brand new: ${age.source} ${Math.round(age.days * 24)} h ago.`, 15);
      else if (age.days < 7) add('info', 'new', `New: ${age.source} ${Math.round(age.days)} days ago.`, 7);
      else if (age.days < 30) add('info', 'young', `${age.source} ${Math.round(age.days)} days ago.`, 3);
    }
  }
  let score = Math.max(0, Math.min(100, 100 - penalty));
  if (hard) score = Math.min(score, 20);
  if (known && !hard) score = Math.max(score, 85);
  const verdict = hard || score < 45 ? 'DANGER' : score >= 75 ? 'SAFE' : 'CAUTION';
  const missing = [...(!marketKnown || (!sources.dexscreener && v4SearchFailed) ? ['market'] : []), ...(pools.length && !sim?.simulated ? ['simulation'] : []), ...(holders.top10_pct == null && !known ? ['holders'] : [])];
  const degraded = missing.length > 0;
  let confidence = sim?.simulated && verified ? 'high' : sim?.simulated || verified ? 'medium' : 'low';
  if (degraded && confidence === 'high') confidence = 'medium';
  const sevOrder = { danger: 0, warn: 1, info: 2, good: 3 };
  reasons.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  return {
    token, chain: 'base', chain_id: 8453, name, symbol, decimals: Number(decimals), total_supply: totalSupply.toString(),
    verdict, score, confidence, degraded, ...(degraded ? { missing_data: missing } : {}), reasons,
    checks: {
      sellability: sim ? summarizeSim(sim) : { simulated: false, reason: 'no pool to simulate' },
      owner: { address: owner, renounced: owner ? isBurn(owner) : null, is_contract: ownerIsContract, has_owner_function: !!ownerRaw },
      powers: { ...powers, source: powersSource },
      proxy,
      contract: { verified, verified_by: verifiedBy, recognized: known ? known.issuer : null, burned_supply_pct: burnedSupplyPct },
      liquidity: { usd: Math.round(liquidityUsd), pools: pools.length, main_pool: pools[0] ? { address: pools[0].address, dex: pools[0].dex, quote: pools[0].quote_symbol, liquidity_usd: Math.round(pools[0].liquidity_usd), volume_h24_usd: Math.round(pools[0].volume_h24), txns_h24: pools[0].txns_h24 } : null, lp },
      holders,
      age,
    },
    ...(deep ? { deep: { simulations: sims, pools: pools.slice(0, 10), geckoterminal: ginfo ? { gt_score: ginfo.gt_score ?? null, is_honeypot: ginfo.is_honeypot ?? null, developer_address: ginfo.developer_address ?? null, developer_holding_pct: ginfo.developer_holding_percentage != null ? Number(ginfo.developer_holding_percentage) : null } : null, creation_block: created?.block ?? null } } : {}),
    sources, limits: LIMITS, disclaimer: DISCLAIMER, engine: ENGINE_VERSION, tier, checked_at: new Date(now).toISOString(),
  };
}

function summarizeSim(s) {
  if (!s.simulated) return { simulated: false, reason: s.reason };
  return {
    simulated: true, pool: s.pool, dex: s.dex, pool_type: s.pool_type, quote: s.quote, amount_in: s.amount_in,
    buy_ok: s.buy.ok, sell_ok: s.sell ? s.sell.ok : null, transfer_ok: s.transfer ? s.transfer.ok : null,
    buy_tax_pct: s.buy.tax_pct, sell_tax_pct: s.sell?.tax_pct ?? null, transfer_tax_pct: s.transfer?.tax_pct ?? null,
    round_trip_loss_pct: s.round_trip_loss_pct ?? null, buy_error: s.buy.error, sell_error: s.sell?.error ?? null,
    buy_gas: s.buy.gas, sell_gas: s.sell?.gas ?? null,
  };
}
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/** Views per tier. */
export function previewView(r) {
  const c = { danger: 0, warn: 0 }; for (const x of r.reasons) if (c[x.severity] != null) c[x.severity]++;
  return { token: r.token, chain: r.chain, name: r.name, symbol: r.symbol, verdict: r.verdict, score: r.score, confidence: r.confidence, degraded: !!r.degraded, flags: c, liquidity_usd: r.checks.liquidity.usd, sellable: r.checks.sellability.simulated ? !!(r.checks.sellability.buy_ok && r.checks.sellability.sell_ok) : null, engine: r.engine, checked_at: r.checked_at, tier: 'preview', disclaimer: r.disclaimer };
}
export function liteView(r) {
  const s = r.checks.sellability;
  return {
    token: r.token, chain: r.chain, name: r.name, symbol: r.symbol, verdict: r.verdict, score: r.score, confidence: r.confidence, degraded: !!r.degraded, ...(r.missing_data ? { missing_data: r.missing_data } : {}),
    reasons: r.reasons.map((x) => ({ severity: x.severity, code: x.code, text: x.text })),
    key: { sellable: s.simulated ? !!(s.buy_ok && s.sell_ok) : null, buy_tax_pct: s.buy_tax_pct ?? null, sell_tax_pct: s.sell_tax_pct ?? null, owner_renounced: r.checks.owner.renounced, upgradeable: r.checks.proxy.upgradeable, verified: r.checks.contract.verified, liquidity_usd: r.checks.liquidity.usd, top10_pct: r.checks.holders.top10_pct, age_days: r.checks.age?.days ?? null },
    engine: r.engine, checked_at: r.checked_at, tier: 'lite', disclaimer: r.disclaimer,
  };
}
