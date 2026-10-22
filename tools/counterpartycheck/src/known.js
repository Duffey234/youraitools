// Well-known protocol addresses (labels only: a label is not an endorsement) and our own x402 payees.
// Labels from SignCheck's known.js, plus Polygon / Arbitrum One USDC (Circle native, verified on-chain 2026-10-22).
export const LABELS = {
  '*': {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
    '0xca11bde05977b3631167028862be2a173976ca11': 'Multicall3',
    '0x0000000000000068f116a894984e2dab9d29fa94': 'Seaport 1.6 (OpenSea)',
    '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': 'Seaport 1.5 (OpenSea)',
    '0x1e0049783f008a0085193e00003d00cd54003c71': 'OpenSea Conduit',
    '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Aggregation Router v6',
    '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW Protocol Settlement',
    '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110': 'CoW Protocol Vault Relayer',
    '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': 'LI.FI Diamond',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x00000000219ab540356cbb839cbe05303d7705fa': 'Ethereum Beacon Deposit Contract',
  },
  8453: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC (Circle, Base)',
    '0x4200000000000000000000000000000000000006': 'WETH (Base)',
    '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap Universal Router v2 (Base)',
    '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap SwapRouter02 (Base)',
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome Router (Base)',
    '0xa238dd80c259a72e81d7e4664a9801593f98d1c5': 'Aave v3 Pool (Base)',
  },
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC (Circle, Ethereum)',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT (Tether, Ethereum)',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH (Ethereum)',
    '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router v2 (Ethereum)',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap SwapRouter02 (Ethereum)',
    '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave v3 Pool (Ethereum)',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  },
  137: { '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC (Circle, Polygon)' },
  42161: { '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC (Circle, Arbitrum One)' },
};
/** True when the address is a labelled well-known contract on any chain. */
export const isLabeled = (a) => !!a && Object.values(LABELS).some((m) => m[a.toLowerCase()]);
export const labelOf = (chainId, a) => (a ? LABELS[chainId]?.[a.toLowerCase()] || LABELS['*'][a.toLowerCase()] || null : null);
/** Our own x402 payout wallets (the YourAITools / AgentGate tools). */
export const OUR_PAYEES = { '0x3c1a1e01e790cd326495631b3b38bd7068f08d6f': 'YourAITools x402 tools (EVM)', FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte: 'YourAITools x402 tools (Solana)' };
