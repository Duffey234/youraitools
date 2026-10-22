// Defaults for the public AgentGate paid endpoint. Override via environment (Node) or wrangler vars (Workers).
export const DEFAULTS = {
  // Base mainnet, CAIP-2
  network: 'eip155:8453',
  // USD price per call; the exact EVM scheme converts it to USDC atomic units (6 decimals) => 5000
  price: '$0.005',
  // Payout wallet (public address, not a secret)
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  // PayAI facilitator: Base mainnet, no API key needed for the first 1,000 credits, Bazaar catalog on /verify and /settle
  facilitatorUrl: 'https://facilitator.payai.network',
};

export const USDC = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

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
