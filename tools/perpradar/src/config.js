import { ROUTES } from './tool.js';
export const DEFAULTS = {
  network: 'eip155:8453',              // Base mainnet (first); more networks in networks.js
  ...Object.fromEntries(ROUTES.map((r) => [r.key, r.dflt])),
  payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F',
  facilitatorUrl: 'https://facilitator.payai.network',
  maxBodyBytes: 4_096,
};
export function configFromEnv(env = {}) {
  return {
    network: env.X402_NETWORK || DEFAULTS.network,
    ...Object.fromEntries(ROUTES.map((r) => [r.key, env[r.env] || r.dflt])),
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
