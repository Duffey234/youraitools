export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet
  price: '$0.003',                     // USDC per successful scan (3000 atomic units)
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxScanChars: 100_000,               // characters scanned per text (paid); longer input is truncated and flagged
  previewChars: 2000,                  // free tier: text up to this many characters
  maxTools: 100,                       // tools[] entries per paid call
  maxBodyBytes: 1_000_000,             // POST body cap
  // url= mode (same SSRF-safe reader as WebRead)
  maxBytes: 2_000_000,
  maxHtmlChars: 1_000_000,
  timeoutMs: 10000,
  blockedHosts: ['agentgate.workers.dev', 'api.youraitools.co', 'youraitools-api.pages.dev'],
};
export const USER_AGENT = 'InjectScanBot/0.1 (+https://injectscan.agentgate.workers.dev; prompt-injection scanner for AI agents; respects robots.txt)';
export const ROBOTS_TOKEN = 'injectscanbot';
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
