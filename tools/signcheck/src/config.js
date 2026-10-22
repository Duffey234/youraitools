export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet
  price: '$0.015',                     // USDC per full check
  litePrice: '$0.005',                 // USDC per lite (offline, no RPC) check
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 131_072,
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    price: env.X402_PRICE || DEFAULTS.price,
    litePrice: env.X402_LITE_PRICE || DEFAULTS.litePrice,
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
