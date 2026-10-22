// Well-known Base assets whose issuer controls (mint, freeze/blacklist, pause, upgrades) are documented by design.
// For these, the controls are reported as information, not as red flags. Addresses verified on-chain (symbol()).
export const RECOGNIZED = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', issuer: 'Circle (native USDC)' },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', issuer: 'Base predeploy (wrapped ETH)' },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', issuer: 'bridged USDC (Base bridge)' },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', issuer: 'Coinbase' },
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', issuer: 'Coinbase' },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', issuer: 'MakerDAO / Sky (bridged)' },
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': { symbol: 'EURC', issuer: 'Circle' },
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { symbol: 'AERO', issuer: 'Aerodrome' },
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', issuer: 'Lido (bridged)' },
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': { symbol: 'VIRTUAL', issuer: 'Virtuals Protocol' },
};
export const BURN_ADDRS = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069'];
