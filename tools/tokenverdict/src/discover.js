// On-chain market discovery, used alongside DexScreener / GeckoTerminal (whose free APIs rate-limit shared Cloudflare
// egress IPs): pools from the main Base factories, liquidity estimates from pool balances and the Chainlink ETH/USD feed,
// Uniswap v4 pools from PoolManager Initialize logs, and the token's creation block (k-ary search on historical code).
import { encAddr, encUint, asAddr, asUint } from './rpc.js';
import { WETH, NATIVE, POOL_MANAGER } from './sim.js';

export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const F = {
  uniV2: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', uniV3: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  aero: '0x420dd381b31aef6683db6b902084cb0ffece40da', slip: '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a', cakeV3: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
};
const CHAINLINK_ETH_USD = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70';
const STATE_VIEW = '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71';
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const ec = (to, data) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });
const i24 = (n) => encUint(n < 0 ? (1n << 256n) + BigInt(n) : BigInt(n));

/** Candidate pools of `token` against WETH and USDC on Uniswap v2/v3, Aerodrome (classic + Slipstream) and PancakeSwap v3. */
export async function factoryPools(rpc, token) {
  const q = [];
  for (const quote of [WETH, USDC]) {
    const a = encAddr(token) + encAddr(quote);
    q.push({ dex: 'uniswap', kind: 'v2', quote, c: ec(F.uniV2, '0xe6a43905' + a) });
    for (const fee of [100, 500, 3000, 10000]) q.push({ dex: 'uniswap', kind: 'v3', quote, c: ec(F.uniV3, '0x1698ee82' + a + encUint(fee)) });
    q.push({ dex: 'aerodrome', kind: 'solidly', quote, c: ec(F.aero, '0x79bc57d5' + a + encUint(0)) });
    for (const ts of quote === WETH ? [1, 50, 100, 200, 2000] : [1, 100, 200]) q.push({ dex: 'aerodrome', kind: 'v3', quote, c: ec(F.slip, '0x28af8d0b' + a + i24(ts)) });
    for (const fee of quote === WETH ? [100, 500, 2500, 10000] : [500, 2500]) q.push({ dex: 'pancakeswap', kind: 'v3', quote, c: ec(F.cakeV3, '0x1698ee82' + a + encUint(fee)) });
  }
  const res = await rpc.batch([...q.map((x) => x.c), ec(CHAINLINK_ETH_USD, '0xfeaf968c')]);
  const ethUsd = Number(asUint(res[q.length]?.result, 1) || 0n) / 1e8 || null;
  const found = [];
  q.forEach((x, i) => { const a = asAddr(res[i]?.result); if (a && !/^0x0{40}$/.test(a)) found.push({ address: a.toLowerCase(), dex: x.dex, kind: x.kind, quote: x.quote }); });
  if (!found.length) return { pools: [], ethUsd };
  const bal = await rpc.batch(found.map((p) => ec(p.quote, '0x70a08231' + encAddr(p.address))));
  const pools = found.map((p, i) => {
    const raw = asUint(bal[i]?.result) || 0n;
    const usd = p.quote === USDC ? Number(raw) / 1e6 : ethUsd ? (Number(raw) / 1e18) * ethUsd : 0;
    return { ...p, liquidity_usd: Math.round(usd * 2), quote_symbol: p.quote === USDC ? 'USDC' : 'WETH', source: 'on-chain factory' };
  }).filter((p) => p.liquidity_usd > 0 || p.kind === 'v2' || p.kind === 'solidly');
  return { pools, ethUsd };
}

/** First block where `token` has code (k-ary search over historical eth_getCode on an archive RPC). Null if unavailable. */
export async function creationBlock(rpcArchive, token, head) {
  let lo = 0, hi = head; // invariant: no code at lo (or lo = 0), code at hi
  for (let round = 0; round < 10 && hi - lo > 1; round++) {
    const step = Math.max(1, Math.ceil((hi - lo) / 16));
    const pts = []; for (let b = lo + step; b < hi; b += step) pts.push(b);
    if (!pts.length) break;
    const res = await rpcArchive.batch(pts.map((b) => ({ method: 'eth_getCode', params: [token, '0x' + b.toString(16)] })));
    if (res.some((r) => r.error)) return null;
    const idx = res.findIndex((r) => r.result && r.result !== '0x');
    if (idx === -1) lo = pts[pts.length - 1]; else { hi = pts[idx]; if (idx > 0) lo = pts[idx - 1]; }
  }
  return hi;
}

/** Uniswap v4 pools of `token` initialized within `span` blocks after `fromBlock` (PoolManager Initialize logs). */
export async function v4PoolsFromLogs(rpcLogs, token, fromBlock, head, span = 1900) {
  const to = Math.min(head, fromBlock + span);
  const range = { address: POOL_MANAGER, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + to.toString(16) };
  const t = '0x' + encAddr(token);
  const res = await rpcLogs.batch([{ method: 'eth_getLogs', params: [{ ...range, topics: [INIT_TOPIC, null, t] }] }, { method: 'eth_getLogs', params: [{ ...range, topics: [INIT_TOPIC, null, null, t] }] }]);
  const out = [];
  for (const r of res) for (const l of r.result || []) {
    const d = l.data.slice(2);
    let ts = BigInt('0x' + d.slice(64, 128)); if (ts >= 2n ** 255n) ts -= 2n ** 256n;
    const key = { currency0: '0x' + l.topics[2].slice(26), currency1: '0x' + l.topics[3].slice(26), fee: Number(BigInt('0x' + d.slice(0, 64))), tickSpacing: Number(ts), hooks: '0x' + d.slice(152, 192) };
    out.push({ address: l.topics[1], dex: 'uniswap', kind: 'v4', key, quote: key.currency0 === token ? key.currency1 : key.currency0, block: Number(BigInt(l.blockNumber)) });
  }
  return out.slice(0, 5);
}

/** Virtual in-range liquidity (USD) of a v4 pool from StateView slot0 + liquidity; only for ETH / WETH / USDC quotes. */
export async function v4Liquidity(rpc, pools, ethUsd) {
  if (!pools.length) return pools;
  const res = await rpc.batch(pools.flatMap((p) => [ec(STATE_VIEW, '0xc815641c' + p.address.slice(2)), ec(STATE_VIEW, '0xfa6793d5' + p.address.slice(2))]));
  return pools.map((p, i) => {
    const sp = asUint(res[2 * i]?.result, 0); const L = asUint(res[2 * i + 1]?.result, 0);
    if (!sp || !L) return { ...p, liquidity_usd: 0 };
    const sqrtP = Number(sp) / 2 ** 96; const quoteIs0 = p.key.currency0 === p.quote;
    const virt = quoteIs0 ? Number(L) / sqrtP : Number(L) * sqrtP; // raw quote units
    const usd = p.quote === USDC ? virt / 1e6 : (p.quote === WETH || p.quote === NATIVE) && ethUsd ? (virt / 1e18) * ethUsd : 0;
    return { ...p, liquidity_usd: Math.round(usd * 2), quote_symbol: p.quote === USDC ? 'USDC' : p.quote === NATIVE ? 'ETH' : p.quote === WETH ? 'WETH' : null, source: 'on-chain v4 (virtual in-range liquidity)' };
  });
}
