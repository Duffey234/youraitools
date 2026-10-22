export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet (first); more networks in networks.js
  priceLite: '$0.005',                 // verdict, findings, redacted text
  priceScan: '$0.02',                  // + JSON payloads, leaked-wallet exposure (balances on 5 chains), actions
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    priceLite: env.X402_PRICE_LITE || DEFAULTS.priceLite,
    priceScan: env.X402_PRICE_SCAN || DEFAULTS.priceScan,
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
