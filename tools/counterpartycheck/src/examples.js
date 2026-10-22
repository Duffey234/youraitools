// Example input/outputs for the Bazaar discovery declaration, OpenAPI and landing page (USDC payee check on Base, 2026-10-22).
export const EXAMPLE_ADDRESS = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const SANCTIONED_EXAMPLE_ADDRESS = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
export const LITE_EXAMPLE = {
  address: '0x098b716b8aaf21512996dc57eb0615e2383e2f96', chain: 'ethereum', intent: 'pay', tier: 'lite', verdict: 'block', confidence: 'high',
  summary: 'BLOCK: Listed on the US Treasury OFAC SDN list (LAZARUS GROUP, DPRK3). Do not pay or interact.',
  reasons: [
    { severity: 'danger', code: 'ofac_sdn', text: 'Listed on the US Treasury OFAC SDN list (LAZARUS GROUP, DPRK3). Do not pay or interact.' },
    { severity: 'good', code: 'active', text: 'Active wallet: 38 outgoing transaction(s) on Ethereum.' },
  ],
  facts: { kind: 'eoa', nonce: 38, native_balance: 101.8, usdc_balance: 0 },
};
export const QUICK_EXAMPLE = {
  address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', chain: 'ethereum', intent: 'pay', tier: 'quick', verdict: 'ok', confidence: 'high',
  summary: 'OK: no risk signal found for this eip7702 delegated eoa on Ethereum (verified, ens).',
  reasons: [
    { severity: 'info', code: 'eip7702', text: 'EOA with an EIP-7702 delegation to 0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d: its code is the delegate contract.' },
    { severity: 'good', code: 'verified', text: 'Delegate contract source verified on Sourcify.' },
    { severity: 'good', code: 'ens', text: 'ENS name vitalik.eth (reverse record, forward-verified).' },
  ],
  facts: { kind: 'eip7702_delegated_eoa', nonce: 5969, delegate: '0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d' },
  checks: { identity: { ens: { name: 'vitalik.eth', verified: true } }, cross_chain: { base: { kind: 'eoa', nonce: 0 } } },
};
export const FULL_EXAMPLE = {
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', chain: 'base', intent: 'pay', tier: 'full', verdict: 'block', confidence: 'high',
  summary: 'BLOCK: This is the USDC token contract itself, not a wallet: tokens sent to a token contract are usually lost.',
  reasons: [
    { severity: 'danger', code: 'token_contract', text: 'This is the USDC token contract itself, not a wallet: tokens sent to a token contract are usually lost.' },
    { severity: 'good', code: 'known_label', text: 'Known address: USDC (Circle, Base).' },
    { severity: 'good', code: 'verified', text: 'Contract source verified on Sourcify (FiatTokenProxy).' },
    { severity: 'good', code: 'established', text: 'Established: contract creation block 1160 days ago (2023-08-18).' },
  ],
  facts: { kind: 'contract', token: { symbol: 'USDC', decimals: 6 } },
  checks: { age: { known: true, block: 2797221, at: '2023-08-18T18:36:29.000Z', basis: 'contract creation block', days: 1160 } },
};
