// Example inputs/outputs used in the Bazaar discovery declaration, OpenAPI and landing page.
export const EXAMPLE_INPUT = {
  chain: 'base',
  tx: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', from: '0xE35E10429048b6F3409b0307E65e4797477Ed144', value: '0', data: '0x095ea7b30000000000000000000000003c1a1e01e790cd326495631b3b38bd7068f08d6fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
};
export const EXAMPLE_QUERY = { chain: 'base', to: EXAMPLE_INPUT.tx.to, from: EXAMPLE_INPUT.tx.from, data: EXAMPLE_INPUT.tx.data };
export const CHECK_EXAMPLE = {
  tier: 'full', verdict: 'DANGER', risk_score: 75, kind: 'transaction', action: 'erc20_approve',
  summary: 'Approve 0x3c1A…8d6F to spend UNLIMITED USDC from your wallet', chain: { id: 8453, name: 'Base' },
  flags: [
    { code: 'SPENDER_IS_EOA', severity: 'critical', message: 'The token allowance goes to 0x3c1A…8d6F, a plain wallet (no contract code). Legitimate apps approve contracts; approvals to wallets are how drainer kits steal funds.' },
    { code: 'UNLIMITED_APPROVAL', severity: 'medium', message: 'Grants an UNLIMITED allowance to 0x3c1A…8d6F.' },
  ],
  counterparties: [{ address: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F', roles: ['spender'], label: null, type: 'eoa' }],
  onchain: { available: true, chain: 'Base', block: 52942270, tokens: [{ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, name: 'USD Coin' }], simulation: { success: true } },
  sanctions: { list: 'US Treasury OFAC Specially Designated Nationals (SDN) list', list_date: '2026-10-21', evm_addresses: 124, matches: 0 },
  engine: 'signcheck-0.1',
};
export const PREVIEW_EXAMPLE = { tier: 'preview', verdict: 'CAUTION', risk_score: 30, kind: 'transaction', action: 'erc20_approve', summary: 'Approve 0x3c1A…8d6F to spend UNLIMITED USDC from your wallet', flags: [{ code: 'UNLIMITED_APPROVAL', severity: 'medium' }] };
