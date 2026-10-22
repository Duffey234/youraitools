// Example input/outputs for the Bazaar discovery declaration, OpenAPI and landing page (BRETT on Base, checked 2026-10-22).
export const EXAMPLE_TOKEN = '0x532f27101965dd16442E59d40670FaF5eBB142E4';
export const LITE_EXAMPLE = {
  token: '0x532f27101965dd16442e59d40670faf5ebb142e4', chain: 'base', name: 'Brett', symbol: 'BRETT', verdict: 'SAFE', score: 97, confidence: 'high',
  reasons: [
    { severity: 'info', code: 'top10', text: 'Top 10 holders own 30.9% (estimate excluding pools and burn).' },
    { severity: 'good', code: 'sellable', text: 'Simulated buy and sell both worked with no token tax (round trip lost 0.42% to pool/hook fees and price impact).' },
    { severity: 'good', code: 'renounced', text: 'Ownership renounced.' },
    { severity: 'good', code: 'verified', text: 'Source verified (Sourcify).' },
  ],
  key: { sellable: true, buy_tax_pct: 0, sell_tax_pct: 0, owner_renounced: true, upgradeable: false, verified: true, liquidity_usd: 721405, top10_pct: 32.6, age_days: 899 },
  tier: 'lite',
};
export const QUICK_EXAMPLE = {
  ...LITE_EXAMPLE, tier: 'quick', key: undefined,
  checks: {
    sellability: { simulated: true, dex: 'aerodrome', pool_type: 'v3', buy_ok: true, sell_ok: true, transfer_ok: true, buy_tax_pct: 0, sell_tax_pct: 0, transfer_tax_pct: 0, round_trip_loss_pct: 0.42 },
    owner: { address: '0x0000000000000000000000000000000000000000', renounced: true, is_contract: false },
    powers: { mint: [], blacklist: [], pause: [], fees: [], trading: [], limits: [], balance: [], upgrade: [], access_control: false, source: 'verified ABI (sourcify)' },
    proxy: { upgradeable: false, type: null },
    contract: { verified: true, verified_by: 'Sourcify' },
    liquidity: { usd: 721405, pools: 1, main_pool: { dex: 'aerodrome', quote: 'WETH' }, lp: null },
    holders: { count: 909566, top10_pct: 32.6, in_pools_pct: 1.7, top10_ex_pools_est_pct: 30.9, source: 'GeckoTerminal' },
    age: { created_at: '2024-02-27T00:00:00.000Z', days: 968, source: 'first DEX pool (DexScreener)' },
  },
};
export const DEEP_EXAMPLE = { ...QUICK_EXAMPLE, tier: 'deep', deep: { simulations: ['one per pool, up to 2'], pools: ['top 10 pools'], geckoterminal: { gt_score: 76.8, is_honeypot: false, developer_holding_pct: null }, creation_block: 10983962 } };
