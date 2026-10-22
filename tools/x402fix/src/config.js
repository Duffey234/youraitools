export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet (first accepts entry; Polygon, Arbitrum One, Solana added by networks.js)
  priceLite: '$0.005',                 // one URL: transport + v2 + v1 + accepts + Bazaar checks and the fix list
  priceCheck: '$0.02',                 // + CDP validate verdict and index status, discovery docs, payee checks, generated fixes
  priceSite: '$0.05',                  // one origin: up to 8 paid routes from /.well-known/x402 + /openapi.json
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 4_096,
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    priceLite: env.X402_PRICE_LITE || DEFAULTS.priceLite,
    priceCheck: env.X402_PRICE_CHECK || DEFAULTS.priceCheck,
    priceSite: env.X402_PRICE_SITE || DEFAULTS.priceSite,
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
