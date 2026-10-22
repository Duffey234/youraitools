// Which x402 facilitator settles v2 payments. FACILITATOR=payai (default) keeps today's PayAI setup; FACILITATOR=cdp
// switches to the Coinbase CDP facilitator (needed for CDP Bazaar / Agentic.Market indexing), authenticated with the
// CDP_API_KEY_ID / CDP_API_KEY_SECRET worker secrets via @coinbase/x402's createFacilitatorConfig (url +
// createAuthHeaders). If cdp is requested but a key is missing we fall back to PayAI with a warning, so a half-done
// switch can never take payments offline. The 402 path stays network-free either way (staticSupported).
// x402 v1 (X-PAYMENT) payments keep going to cfg.facilitatorUrl (PayAI); Bazaar indexing only needs v2.
import { createFacilitatorConfig } from '@coinbase/x402';

export const FACILITATORS = ['payai', 'cdp'];

/**
 * @param {{facilitator?: string, facilitatorUrl: string, cdpApiKeyId?: string, cdpApiKeySecret?: string}} cfg
 * @param {{createConfig?: typeof createFacilitatorConfig, warn?: (msg: string) => void}} [deps] injectable for tests
 * @returns {{name: 'payai'|'cdp', url: string, createAuthHeaders?: Function, warning?: string}}
 */
export function selectFacilitator(cfg, { createConfig = createFacilitatorConfig, warn = (m) => console.warn(m) } = {}) {
  const want = String(cfg.facilitator || 'payai').trim().toLowerCase();
  const payai = (warning) => { if (warning) warn(warning); return { name: 'payai', url: cfg.facilitatorUrl, ...(warning ? { warning } : {}) }; };
  if (want === 'payai') return payai();
  if (want !== 'cdp') return payai(`x402: unknown FACILITATOR=${JSON.stringify(want)}; using PayAI`);
  if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) return payai('x402: FACILITATOR=cdp but CDP_API_KEY_ID / CDP_API_KEY_SECRET is not set; falling back to PayAI');
  const { url, createAuthHeaders } = createConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret);
  return { name: 'cdp', url, createAuthHeaders };
}
