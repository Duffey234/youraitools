// Minimal JSON-RPC client for public Base RPCs: batched requests, per-call deadline, endpoint fallback.
import { withDeadline } from './deadline.js';

export const BASE_RPCS = ['https://base-rpc.publicnode.com', 'https://gateway.tenderly.co/public/base', 'https://base-mainnet.public.blastapi.io', 'https://base.meowrpc.com', 'https://mainnet.base.org'];
export const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
export const BASE_SEPOLIA_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
// archive-capable public endpoints (historical eth_getCode for the creation-block search)
export const ARCHIVE_RPCS = ['https://gateway.tenderly.co/public/base', 'https://base-mainnet.public.blastapi.io', 'https://base.meowrpc.com'];
// eth_getLogs over ~2000-block ranges (recent blocks)
export const LOGS_RPCS = ['https://base-rpc.publicnode.com'];

export class RpcError extends Error { constructor(msg) { super(msg); this.name = 'RpcError'; this.code = 'rpc_unavailable'; } }

/**
 * @param {{fetchImpl?: Function, urls?: string[], ms?: number}} [o]
 * @returns {{batch: (calls: {method: string, params: any[]}[]) => Promise<{result?: any, error?: any}[]>, call: Function}}
 */
export function makeRpc({ fetchImpl = (...a) => globalThis.fetch(...a), urls = BASE_RPCS, ms = 7000 } = {}) {
  let start = 0; // rotate the starting endpoint after a failure so one bad RPC doesn't slow every call
  async function batch(calls) {
    if (!calls.length) return [];
    const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params })));
    let last;
    for (let k = 0; k < Math.min(urls.length, 3); k++) {
      const url = urls[(start + k) % urls.length];
      try {
        const res = await withDeadline(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), ms, `rpc ${new URL(url).host}`);
        if (!res.ok) throw new RpcError(`rpc ${new URL(url).host} HTTP ${res.status}`);
        const j = await res.json();
        const arr = Array.isArray(j) ? j : [j];
        if (arr.length !== calls.length && arr.length === 1 && arr[0]?.error) throw new RpcError(`rpc ${new URL(url).host}: ${arr[0].error.message}`);
        const byId = new Map(arr.map((x) => [x.id, x]));
        const out = calls.map((_, i) => byId.get(i + 1) || { error: { message: 'missing response' } });
        // rate-limit answers come back per item: retry the batch elsewhere if all failed that way
        if (out.every((x) => x.error && /rate|limit|capacity|too many/i.test(x.error.message || ''))) throw new RpcError(`rpc ${new URL(url).host} rate limited`);
        return out;
      } catch (e) { last = e; start = (start + 1) % urls.length; }
    }
    throw last instanceof RpcError ? last : new RpcError(String(last?.message || last));
  }
  const call = async (method, params) => { const [r] = await batch([{ method, params }]); if (r.error) throw new RpcError(r.error.message); return r.result; };
  return { batch, call };
}

// ---- tiny ABI helpers (static types only; enough for these checks) ----
export const pad32 = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
export const encAddr = (a) => pad32(a.toLowerCase());
export const encUint = (n) => pad32(BigInt(n).toString(16));
export const word = (hex, i = 0) => { const h = (hex || '0x').replace(/^0x/, ''); return h.slice(i * 64, i * 64 + 64); };
export const asAddr = (hex, i = 0) => { const w = word(hex, i); return w.length === 64 ? `0x${w.slice(24)}` : null; };
export const asUint = (hex, i = 0) => { const w = word(hex, i); return w.length === 64 ? BigInt(`0x${w}`) : null; };
/** Decode an ABI string return (or a bytes32 string, as some old tokens use). */
export function asString(hex) {
  const h = (hex || '0x').replace(/^0x/, '');
  if (h.length < 64) return null;
  try {
    if (h.length === 64) return clean(hexToUtf8(h));
    const off = Number(BigInt(`0x${h.slice(0, 64)}`)) * 2; const len = Number(BigInt(`0x${h.slice(off, off + 64)}`));
    if (len > 200) return null;
    return clean(hexToUtf8(h.slice(off + 64, off + 64 + len * 2)));
  } catch { return null; }
}
const clean = (s) => s.replace(/\u0000/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || null;
function hexToUtf8(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return new TextDecoder().decode(b); }
