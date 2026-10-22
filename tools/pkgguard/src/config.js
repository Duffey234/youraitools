export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet
  priceScan: '$0.003',                 // USDC per dependency scan (up to 500 packages)
  pricePackage: '$0.001',              // USDC per single package lookup
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 512_000,
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    priceScan: env.X402_PRICE_SCAN || DEFAULTS.priceScan,
    pricePackage: env.X402_PRICE_PACKAGE || DEFAULTS.pricePackage,
    payTo: env.PAY_TO || DEFAULTS.payTo,
    facilitatorUrl: env.FACILITATOR_URL || DEFAULTS.facilitatorUrl,
    // FACILITATOR=payai|cdp (default payai); CDP keys are worker secrets, only used when FACILITATOR=cdp
    facilitator: env.FACILITATOR || 'payai',
    cdpApiKeyId: env.CDP_API_KEY_ID || undefined,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET || undefined,
    publicUrl: env.PUBLIC_URL || undefined,
    statsKv: env.STATS || undefined,
    freeLimiter: env.FREE_LIMITER || undefined,
  };
}
