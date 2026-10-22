export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet
  price: '$0.002',                     // USDC per successful read (2000 atomic units)
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBytes: 2_000_000,                 // bytes downloaded per page
  maxHtmlChars: 1_000_000,             // HTML characters converted (CPU bound)
  timeoutMs: 10000,                    // whole fetch incl. redirects
  previewChars: 2000,                  // free tier output size
  blockedHosts: ['agentgate.workers.dev', 'api.youraitools.co', 'youraitools-api.pages.dev'],
};
export const USER_AGENT = 'WebReadBot/0.1 (+https://webread.agentgate.workers.dev; URL-to-Markdown reader for AI agents; respects robots.txt)';
export const ROBOTS_TOKEN = 'webreadbot';
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    price: env.X402_PRICE || DEFAULTS.price,
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
