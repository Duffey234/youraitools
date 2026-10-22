// Honeypot / tax simulation: one eth_call that runs contracts/TVSim.sol (placed via state override at a throwaway
// address) to buy the token on a real pool, transfer a slice to a fresh wallet, and sell the rest back. No transaction
// is ever sent. Quote funding: WETH by depositing simulated ETH; any other quote token by overriding its balance slot
// (found by probing the usual Solidity / ERC-7201 layouts).
import { encodeFunctionData, decodeFunctionResult, keccak256, encodeAbiParameters } from 'viem';
import { TVSIM_RUNTIME } from './simcode.js';
import { encAddr, asUint, asAddr } from './rpc.js';

export const SIM_ADDR = '0x7e5700000000000000000000000000000000a11c';
export const WETH = '0x4200000000000000000000000000000000000006';
const SIM_ABI = [{ type: 'function', name: 'run', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'address' }, { name: 'kind', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'quote', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ name: 'r', type: 'tuple', components: [
  { name: 'funded', type: 'bool' }, { name: 'buyOk', type: 'bool' }, { name: 'transferOk', type: 'bool' }, { name: 'sellTransferOk', type: 'bool' }, { name: 'sellOk', type: 'bool' },
  { name: 'buyExpected', type: 'uint256' }, { name: 'buyReceived', type: 'uint256' }, { name: 'transferSent', type: 'uint256' }, { name: 'transferReceived', type: 'uint256' },
  { name: 'sellAmount', type: 'uint256' }, { name: 'poolReceived', type: 'uint256' }, { name: 'sellExpected', type: 'uint256' }, { name: 'sellReceived', type: 'uint256' },
  { name: 'buyGas', type: 'uint256' }, { name: 'sellGas', type: 'uint256' }, { name: 'buyErr', type: 'bytes' }, { name: 'sellErr', type: 'bytes' }] }] }];
const R_COMPONENTS = SIM_ABI[0].outputs;
SIM_ABI.push({ type: 'function', name: 'run4', stateMutability: 'nonpayable', inputs: [{ name: 'key', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'token', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: R_COMPONENTS });
const KIND = { v2: 1, solidly: 2, v3: 3 };
export const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const NATIVE = '0x0000000000000000000000000000000000000000';

/**
 * Resolve a Uniswap v4 PoolKey from its PoolId via the PoolManager Initialize event, searching around the block
 * estimated from the pool creation time (Base: 2 s blocks).
 */
export async function resolveV4Key(rpc, poolId, createdAtMs, nowMs = Date.now()) {
  const head = Number(BigInt(await rpc.call('eth_blockNumber', [])));
  const est = createdAtMs ? head - Math.floor((nowMs - createdAtMs) / 2000) : head;
  const windows = [[est - 1500, est + 1500], [est - 9000, est - 1500], [est + 1500, est + 9000]];
  for (const [a, b] of windows) {
    const from = Math.max(0, a), to = Math.min(head, b);
    if (from > to) continue;
    let logs;
    try { logs = await rpc.call('eth_getLogs', [{ address: POOL_MANAGER, topics: [INIT_TOPIC, poolId], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]); } catch { return null; }
    const l = logs && logs[0];
    if (l) {
      const d = l.data.slice(2);
      const fee = Number(BigInt('0x' + d.slice(0, 64)));
      let ts = BigInt('0x' + d.slice(64, 128)); if (ts >= 2n ** 255n) ts -= 2n ** 256n;
      return { currency0: '0x' + l.topics[2].slice(26), currency1: '0x' + l.topics[3].slice(26), fee, tickSpacing: Number(ts), hooks: '0x' + d.slice(128 + 24, 192) };
    }
  }
  return null;
}
const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', getReserves: '0x0902f1ac', stable: '0x22be3de1', slot0: '0x3850c7bd', fee: '0xddca3f43', balanceOf: '0x70a08231', totalSupply: '0x18160ddd', factory: '0xc45a0155' };
// ERC-7201 namespaced storage base of OpenZeppelin ERC20Upgradeable v5 (_balances is its first field)
const OZ7201 = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00';
const BIG = '0x' + (10n ** 30n).toString(16);

const ec = (to, data) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });
const mapSlot = (holder, slot) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, slot]));
const slotHex = (n) => '0x' + n.toString(16).padStart(64, '0');

/** Identify pool type and tokens from on-chain calls (one batch per pool list). */
export async function probePools(rpc, pools) {
  const calls = [];
  for (const p of pools) for (const s of ['token0', 'token1', 'getReserves', 'stable', 'slot0']) calls.push(ec(p, SEL[s]));
  const res = await rpc.batch(calls);
  return pools.map((p, i) => {
    const [t0, t1, rv, st, s0] = res.slice(i * 5, i * 5 + 5).map((r) => (r.error ? null : r.result));
    const token0 = asAddr(t0); const token1 = asAddr(t1);
    if (!token0 || !token1) return { address: p, kind: null };
    let kind = null;
    if (s0 && s0.length >= 130) kind = 'v3';
    else if (rv && rv.length >= 130 && st && st.length >= 66) kind = 'solidly';
    else if (rv && rv.length >= 130) kind = 'v2';
    return { address: p, kind, token0: token0.toLowerCase(), token1: token1.toLowerCase() };
  });
}

/** Find a storage override that gives SIM_ADDR a balance of `quote` (null if none of the usual layouts work). */
export async function findBalanceSlot(rpc, quote) {
  const cands = [...Array(12).keys()].map((i) => slotHex(BigInt(i))).concat([OZ7201]);
  const calls = cands.map((slot) => ({ method: 'eth_call', params: [{ to: quote, data: SEL.balanceOf + encAddr(SIM_ADDR) }, 'latest', { [quote]: { stateDiff: { [mapSlot(SIM_ADDR, slot)]: '0x' + BigInt(BIG).toString(16).padStart(64, '0') } } }] }));
  const res = await rpc.batch(calls);
  for (let i = 0; i < res.length; i++) { const v = res[i].error ? null : asUint(res[i].result); if (v && v >= 10n ** 29n) return cands[i]; }
  return null;
}

const decodeErr = (hex) => {
  if (!hex || hex === '0x') return 'reverted without a reason';
  try {
    if (hex.startsWith('0x08c379a0')) { const len = Number(BigInt('0x' + hex.slice(74, 138))); const s = hex.slice(138, 138 + len * 2); return 'reverted: ' + new TextDecoder().decode(Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16))).slice(0, 120); }
    if (hex.startsWith('0x4e487b71')) return `panic 0x${hex.slice(-2)}`;
    return `reverted with custom error ${hex.slice(0, 10)}`;
  } catch { return 'reverted'; }
};
const bps = (exp, got) => (exp > 0n ? Number(((exp - (got > exp ? exp : got)) * 10000n) / exp) : null);

/**
 * Simulate buy, wallet transfer and sell on one pool.
 * @param {*} rpc
 * @param {{address:string, kind:string, token0:string, token1:string}} pool
 * @param {string} token lowercase
 * @param {bigint} amountIn quote units
 */
export async function simulate(rpc, pool, token, amountIn) {
  const quote = pool.token0 === token ? pool.token1 : pool.token0;
  const overrides = { [SIM_ADDR]: { code: TVSIM_RUNTIME, balance: '0x' + (amountIn * 2n + 10n ** 18n).toString(16) } };
  if (quote !== WETH && quote !== NATIVE) {
    const slot = await findBalanceSlot(rpc, quote);
    if (!slot) return { pool: pool.address, simulated: false, reason: 'quote token balance could not be simulated' };
    overrides[quote] = { stateDiff: { [mapSlot(SIM_ADDR, slot)]: '0x' + (amountIn * 4n).toString(16).padStart(64, '0') } };
  }
  const data = pool.kind === 'v4'
    ? encodeFunctionData({ abi: SIM_ABI, functionName: 'run4', args: [{ currency0: pool.key.currency0, currency1: pool.key.currency1, fee: pool.key.fee, tickSpacing: pool.key.tickSpacing, hooks: pool.key.hooks }, token, amountIn] })
    : encodeFunctionData({ abi: SIM_ABI, functionName: 'run', args: [pool.address, KIND[pool.kind], token, quote, amountIn] });
  const [r] = await rpc.batch([{ method: 'eth_call', params: [{ from: '0x000000000000000000000000000000000000dEaD', to: SIM_ADDR, data, gas: '0x2faf080' }, 'latest', overrides] }]);
  if (r.error) return { pool: pool.address, simulated: false, reason: `simulation call failed: ${String(r.error.message).slice(0, 140)}` };
  const x = decodeFunctionResult({ abi: SIM_ABI, functionName: pool.kind === 'v4' ? 'run4' : 'run', data: r.result });
  if (!x.funded) return { pool: pool.address, simulated: false, reason: 'could not fund the simulated buyer' };
  const out = {
    pool: pool.address, pool_type: pool.kind, quote, amount_in: amountIn.toString(), simulated: true,
    buy: { ok: x.buyOk, expected: x.buyExpected.toString(), received: x.buyReceived.toString(), tax_pct: x.buyOk ? pct(bps(x.buyExpected, x.buyReceived)) : null, gas: Number(x.buyGas), error: x.buyOk ? null : decodeErr(x.buyErr) },
    transfer: x.transferSent > 0n ? { ok: x.transferOk, sent: x.transferSent.toString(), received: x.transferReceived.toString(), tax_pct: x.transferOk ? pct(bps(x.transferSent, x.transferReceived)) : null } : null,
    sell: x.buyOk && x.buyReceived > 0n ? { ok: x.sellOk, amount: x.sellAmount.toString(), pool_received: x.poolReceived.toString(), transfer_tax_pct: x.sellTransferOk ? pct(bps(x.sellAmount, x.poolReceived)) : null, expected_out: x.sellExpected.toString(), received_out: x.sellReceived.toString(), tax_pct: x.sellOk ? pct(bps(x.sellAmount, x.poolReceived)) : null, gas: Number(x.sellGas), error: x.sellOk ? null : decodeErr(x.sellErr) } : null,
  };
  // round trip: quote back after buying and selling 90% of what was bought (includes pool fees and price impact)
  if (x.sellOk && amountIn > 0n) out.round_trip_loss_pct = pct(bps((amountIn * 9n) / 10n, x.sellReceived));
  return out;
}
const pct = (b) => (b == null ? null : Math.round(b) / 100);
export { SEL as POOL_SELECTORS, NATIVE };
