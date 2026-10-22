// Offline Solana RPC + DexScreener mock for engine tests (accounts shaped like real jsonParsed / base64 answers).
import { base58Decode } from '../src/b58.js';
export const RUG = 'Bm1CrbyNshvBcDCxVwsKJGrJ7Ago6LTRjbCo3aJR7YPu';   
export const T22 = 'HxxZZHoRuvNT2GHhQcoSNFVKuBM19TmoAgkmktoV6YDV';
export const NOTMINT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // a wallet
export const WALLET_A = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const b64 = (u8) => Buffer.from(u8).toString('base64');
const mintAcct = (info, program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') => ({ owner: program, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true, supply: '1000000000000', ...info } }, program: 'spl-token' } });
export const MINTS = {
  [RUG]: mintAcct({ mintAuthority: '2dSuzWz65HN8zzM3ch6VpfjbexXZxT5C1gQkEEzc1kmT', freezeAuthority: '2dSuzWz65HN8zzM3ch6VpfjbexXZxT5C1gQkEEzc1kmT' }),
  [T22]: mintAcct({ mintAuthority: null, freezeAuthority: null, extensions: [
    { extension: 'permanentDelegate', state: { delegate: 'F6YtqKFxm7fyNTj3K8h9ZfeakGEVHsDSbxsG7dYQvqo3' } },
    { extension: 'transferHook', state: { programId: 'RXGUmMm3MEgxdncrtKhG4Hm9W3CEFxtCXvmJs9233Gz', authority: null } },
    { extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: null, newerTransferFee: { epoch: 1, maximumFee: 0, transferFeeBasisPoints: 250 } } },
    { extension: 'tokenMetadata', state: { name: 'Trap', symbol: 'TRAP', uri: '', updateAuthority: null } },
  ] }, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  [NOTMINT]: { owner: '11111111111111111111111111111111', data: ['', 'base64'] },
};
export function mockFetch({ dex = {}, ray = {}, accounts = {}, holders = true, rpcDown = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('dexscreener')) {
      const mint = String(url).split('/').pop();
      if (dex[mint] === 'down') return new Response('rate limited', { status: 429 });
      return Response.json(dex[mint] || []);
    }
    if (String(url).includes('raydium')) {
      const mint = new URL(url).searchParams.get('mint1');
      if (ray[mint] === 'down' || ray[mint] === undefined) return new Response('error code: 1015', { status: 429 });
      return Response.json({ id: 'x', success: true, data: { count: ray[mint].length, data: ray[mint] } });
    }
    if (rpcDown) return new Response('down', { status: 503 });
    const { method, params } = JSON.parse(init.body);
    if (method === 'getMultipleAccounts') {
      const [addrs, opts] = params;
      if (opts.dataSlice) return Response.json({ jsonrpc: '2.0', id: 1, result: { value: addrs.map(() => ({ data: [b64(base58Decode(WALLET_A)), 'base64'] })) } });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { value: addrs.map((a) => accounts[a] || MINTS[a] || null) } });
    }
    if (method === 'getTokenLargestAccounts') {
      if (!holders) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32010, message: 'excluded from account secondary indexes' } });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { value: [{ address: '9fQ6Lp3eMmVeg2GwUh9VgC7rM3jJzv6dUcv3Bq5x9ZNF', amount: '600000000000' }, { address: 'A4HfPVkdjjst1awC1BKhZ4zcPisoGvsjn7ftSiYsy47F', amount: '100000000000' }] } });
    }
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown' } });
  };
  return { fetchImpl, calls };
}
export const pool = (mint, o = {}) => ({ chainId: 'solana', dexId: o.dex || 'raydium', pairAddress: o.pair || '3gLESRnfLgzAqu6PwGhBwsiBsnQ7BAtyWHhZ5zNcDPMF', baseToken: { address: mint, symbol: 'X' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, liquidity: { usd: o.liq ?? 50000 }, volume: { h24: 1000 }, txns: { h24: { buys: o.buys ?? 100, sells: o.sells ?? 80 } }, pairCreatedAt: o.created ?? Date.parse('2026-01-01T00:00:00Z'), url: 'https://dexscreener.com/solana/x' });
export const rayPool = (mint, o = {}) => ({ type: 'Standard', id: o.id || '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', mintA: { address: mint, symbol: 'X' }, mintB: { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL' }, tvl: o.tvl ?? 80000, day: { volume: 5000 }, openTime: String(o.open ?? 1700000000), burnPercent: 100 });
/** pump.fun BondingCurve account bytes: discriminator, 5 x u64, complete flag. */
export function curveAcct({ realSol = 12.5, complete = false } = {}) {
  const b = Buffer.alloc(49); b.writeBigUInt64LE(BigInt(Math.round(realSol * 1e9)), 32); b[48] = complete ? 1 : 0;
  return { owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', data: [b.toString('base64'), 'base64'] };
}
