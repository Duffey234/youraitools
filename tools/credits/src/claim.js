// Direct-transfer purchase path for humans (POST /v1/claim). The buyer's wallet sends a plain USDC ERC-20
// transfer(payee, packAmount) (no signature, no approval, no permit), so wallets show an ordinary token send. The page
// appends a 32-byte commitment sha256(secret) after the transfer arguments (USDC ignores trailing calldata), then claims
// the key with { chain, txHash, secret }. The server re-reads the transaction from public RPCs and mints a key only if:
//   - the tx was sent to the chain's USDC contract and calls transfer(address,uint256) with the commitment suffix;
//   - recipient = our payee and amount = exactly one pack price;
//   - sha256(secret) = the commitment (so nobody who merely sees the tx on-chain can claim it first);
//   - the receipt succeeded and holds a USDC Transfer log from the tx sender to our payee for that amount
//     (this also rules out x402 settlements, which are sent by the facilitator, not by the payer);
//   - it has enough confirmations; and the txHash was never claimed (one Durable Object per tx: claim:<chain>:<hash>).
// Every RPC call races a short deadline. Nothing is written to KV.
import { withDeadline } from './deadline.js';

export const CHAINS = {
  base: { id: 'eip155:8453', name: 'Base', chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', confirmations: 5, explorer: 'https://basescan.org/tx/',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  polygon: { id: 'eip155:137', name: 'Polygon', chainId: 137, usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', confirmations: 32, explorer: 'https://polygonscan.com/tx/',
    rpcs: ['https://polygon.drpc.org', 'https://1rpc.io/matic'] },
  arbitrum: { id: 'eip155:42161', name: 'Arbitrum One', chainId: 42161, usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', confirmations: 20, explorer: 'https://arbiscan.io/tx/',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
};
export const chainOf = (v) => { const s = String(v || '').toLowerCase().trim(); return CHAINS[s] ? [s, CHAINS[s]] : Object.entries(CHAINS).find(([, c]) => c.id === s || String(c.chainId) === s) || null; };
export const TRANSFER_SELECTOR = '0xa9059cbb';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const RPC_TIMEOUT_MS = 4000;
const HEX32 = /^0x[0-9a-f]{64}$/;
const pad = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export async function sha256Hex(hex) {
  const bytes = new Uint8Array(hex.replace(/^0x/, '').match(/../g).map((b) => parseInt(b, 16)));
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return '0x' + Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON-RPC against the chain's public endpoints, first answer wins in order; each try races RPC_TIMEOUT_MS. */
export async function rpc(chain, method, params, fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS) {
  let last;
  for (const url of chain.rpcs) {
    try {
      const r = await withDeadline(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), timeoutMs, `${method} ${new URL(url).host}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await withDeadline(r.json(), timeoutMs, `${method} body`);
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) { last = e; }
  }
  throw Object.assign(new Error(`rpc unavailable: ${last && last.message}`), { code: 'rpc_unavailable' });
}

const fail = (status, error, message, extra = {}) => ({ ok: false, status, error, message, ...extra });

/**
 * Verify a direct USDC transfer. Returns { ok:true, sender, amount, pack, block, confirmations } or
 * { ok:false, status, error, message } (status 202 = not final yet, retry later).
 * @param {{chainKey:string, chain:object, txHash:string, secret:string, payee:string, packs:object[], fetchImpl?:Function}} o
 */
export async function verifyDirectTransfer({ chainKey, chain, txHash, secret, payee, packs, fetchImpl }) {
  const call = (m, p) => rpc(chain, m, p, fetchImpl);
  const [tx, receipt, head] = await Promise.all([call('eth_getTransactionByHash', [txHash]), call('eth_getTransactionReceipt', [txHash]), call('eth_blockNumber', [])]);
  if (!tx) return fail(202, 'pending', `Transaction not found on ${chain.name} yet. Retry in a few seconds.`, { retry_after: 5 });
  const input = String(tx.input || tx.data || '').toLowerCase();
  if (String(tx.to || '').toLowerCase() !== chain.usdc) return fail(400, 'wrong_token', `That transaction is not a ${chain.name} USDC transfer (it was sent to ${tx.to}, not the USDC contract ${chain.usdc}).`);
  if (!input.startsWith(TRANSFER_SELECTOR)) return fail(400, 'not_a_transfer', 'That transaction is not a plain USDC transfer(to, amount).');
  if (input.length !== 2 + 8 + 64 * 3) return fail(400, 'missing_claim_code', 'That transfer was not made from the credits page (no claim code attached), so it cannot be claimed automatically.');
  const to = '0x' + input.slice(10 + 24, 10 + 64);
  const amount = BigInt('0x' + input.slice(74, 138));
  const commitment = '0x' + input.slice(138);
  if (to !== payee.toLowerCase()) return fail(400, 'wrong_recipient', `That transfer went to ${to}, not to our payee ${payee}.`);
  const pack = packs.find((p) => BigInt(p.paid) === amount);
  if (!pack) return fail(400, 'wrong_amount', `That transfer was ${Number(amount) / 1e6} USDC, which is not a pack price (${packs.map((p) => Number(p.paid) / 1e6).join(', ')} USDC).`);
  if ((await sha256Hex(secret)) !== commitment) return fail(403, 'claim_code_mismatch', 'The claim code does not match this transaction.');
  if (!receipt) return fail(202, 'pending', 'Transaction is not mined yet. Retry in a few seconds.', { retry_after: 5 });
  if (receipt.status !== '0x1') return fail(400, 'tx_failed', 'That transaction failed on-chain (reverted); nothing was paid.');
  const sender = String(tx.from).toLowerCase();
  const log = (receipt.logs || []).find((l) => String(l.address).toLowerCase() === chain.usdc && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC
    && l.topics[1]?.toLowerCase() === pad(sender) && l.topics[2]?.toLowerCase() === pad(payee) && BigInt(l.data) === amount);
  if (!log) return fail(400, 'transfer_not_found', 'No matching USDC Transfer from the sender to our payee in that transaction.');
  const block = Number(BigInt(receipt.blockNumber)); const confirmations = Number(BigInt(head)) - block + 1;
  if (confirmations < chain.confirmations) return fail(202, 'pending', `Waiting for confirmations (${Math.max(confirmations, 0)}/${chain.confirmations}).`, { confirmations: Math.max(confirmations, 0), needed: chain.confirmations, retry_after: 4 });
  return { ok: true, sender, amount: Number(amount), pack, block, confirmations, chainKey };
}

export const validTxHash = (h) => HEX32.test(String(h || '').toLowerCase());
export const validSecret = (s) => HEX32.test(String(s || '').toLowerCase());
