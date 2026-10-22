export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet
  priceAddress: '$0.001',              // USDC per address screen (1000 atomic units)
  priceBatch: '$0.01',                 // USDC per batch of up to 50 addresses (10000 atomic units)
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 10_000,
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    priceAddress: env.X402_PRICE_ADDRESS || DEFAULTS.priceAddress,
    priceBatch: env.X402_PRICE_BATCH || DEFAULTS.priceBatch,
    payTo: env.PAY_TO || DEFAULTS.payTo,
    facilitatorUrl: env.FACILITATOR_URL || DEFAULTS.facilitatorUrl,
    // FACILITATOR=payai|cdp (default payai); CDP keys are worker secrets, only used when FACILITATOR=cdp
    facilitator: env.FACILITATOR || 'payai',
    cdpApiKeyId: env.CDP_API_KEY_ID || undefined,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET || undefined,
    solanaDevnetPayTo: env.SOLANA_DEVNET_PAY_TO || undefined,
    solanaDevnetFacilitatorUrl: env.SOLANA_DEVNET_FACILITATOR_URL || undefined,
    solanaDevnetFeePayer: env.SOLANA_DEVNET_FEE_PAYER || undefined,
    solanaDevnetPrice: env.SOLANA_DEVNET_PRICE || undefined,
    stellarTestnetPayTo: env.STELLAR_TESTNET_PAY_TO || undefined,
    stellarTestnetFacilitatorUrl: env.STELLAR_TESTNET_FACILITATOR_URL || undefined,
    stellarTestnetAmount: env.STELLAR_TESTNET_AMOUNT || undefined,
    goatTestnet3PayTo: env.GOAT_TESTNET3_PAY_TO || undefined,
    goatTestnet3FacilitatorUrl: env.GOAT_TESTNET3_FACILITATOR_URL || undefined,
    goatTestnet3FacilitatorSigner: env.GOAT_TESTNET3_FACILITATOR_SIGNER || undefined,
    goatTestnet3Amount: env.GOAT_TESTNET3_AMOUNT || undefined,
    // service binding to the goat-facilitator Worker (workers.dev -> workers.dev fetch is blocked on one account)
    goatTestnet3Fetcher: env.GOAT_FACILITATOR ? (req) => env.GOAT_FACILITATOR.fetch(req) : undefined,
    publicUrl: env.PUBLIC_URL || undefined,
    statsKv: env.STATS || undefined,
    freeLimiter: env.FREE_LIMITER || undefined,
  };
}
