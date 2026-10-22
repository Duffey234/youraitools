export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet
  priceDomain: '$0.002',               // USDC per domain report (2000 atomic units)
  priceEmail: '$0.001',                // USDC per email check (1000 atomic units)
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 10_000,
};
export const USER_AGENT = 'DomainCheck/0.1 (+https://domaincheck.agentgate.workers.dev; domain and email trust checks for AI agents)';
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    priceDomain: env.X402_PRICE_DOMAIN || DEFAULTS.priceDomain,
    priceEmail: env.X402_PRICE_EMAIL || DEFAULTS.priceEmail,
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
