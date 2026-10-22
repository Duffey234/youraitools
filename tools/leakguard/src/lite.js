// LeakGuard client helpers for the npm package (library + stdio MCP server). Detection and redaction run LOCALLY with the
// zero-dependency engine (engine.js); nothing is sent anywhere. The hosted API adds JSON payload scans and live balances of
// wallets whose keys leaked (paid, see paid.js).
export const API_BASE = 'https://api.youraitools.co/leakguard';
export const FALLBACK_API_BASE = 'https://leakguard.agentgate.workers.dev';
export const PAID_URL = `${API_BASE}/v1/scan`;
export const PRICES = { lite: '$0.005', scan: '$0.02' };
export const DISCLAIMER = 'Pattern and validator based detection: it can miss secrets in unknown formats and can flag look-alikes. A clean result is not a guarantee.';
export const HOSTED = `Hosted API (x402 USDC or prepaid credits): ${API_BASE}/v1/lite (${PRICES.lite}) and ${API_BASE}/v1/scan (${PRICES.scan}: JSON payloads + live balances of wallets whose keys leaked, on Base, Ethereum, Polygon, Arbitrum One and Solana).`;
export const MAX_LOCAL_BYTES = 1_048_576;

/** Validate the text argument locally. Returns { text } or { error }. */
export function toText(args = {}) {
  const v = args.text;
  if (typeof v !== 'string' || !v.length) return { error: '"text" (string) is required' };
  if (new TextEncoder().encode(v).length > MAX_LOCAL_BYTES) return { error: `"text" is larger than ${MAX_LOCAL_BYTES} bytes` };
  return { text: v };
}
