export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet (first accepts entry; Polygon, Arbitrum One, Solana added by networks.js)
  priceLite: '$0.005',                 // lists + one on-chain read: verdict and reasons
  priceQuick: '$0.015',                // + verification, deployer, names, cross-chain, explorer labels
  priceFull: '$0.05',                  // + age, recent activity and exposure, approvals, TokenVerdict for Base tokens
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 4_096,
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    priceLite: env.X402_PRICE_LITE || DEFAULTS.priceLite,
    priceQuick: env.X402_PRICE_QUICK || DEFAULTS.priceQuick,
    priceFull: env.X402_PRICE_FULL || DEFAULTS.priceFull,
    payTo: env.PAY_TO || DEFAULTS.payTo,
    facilitatorUrl: env.FACILITATOR_URL || DEFAULTS.facilitatorUrl,
    // FACILITATOR=payai|cdp (default payai); CDP keys are worker secrets, only used when FACILITATOR=cdp
    facilitator: env.FACILITATOR || 'payai',
    cdpApiKeyId: env.CDP_API_KEY_ID || undefined,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET || undefined,
    publicUrl: env.PUBLIC_URL || undefined,
    freeLimiter: env.FREE_LIMITER || undefined,
  };
}
