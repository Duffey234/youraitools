// PayGuard offline preview (the npm package's library and stdio MCP server): is this address in the OFAC SDN list?
// Same fields as the hosted free preview (/v1/preview): sanctioned true/false, match count and chain guess.
// SDN entity, programs, list date and checksum validation are the paid API: https://api.youraitools.co/payguard/v1/address
import { SDN_LITE } from './data/sdn-lite.js';
import { detectAddress } from './address.js';
import { DISCLAIMER, MAX_LEN, MAX_BATCH, stripScheme, normalizeAddress, invalidInput } from './normalize.js';

export { DISCLAIMER, MAX_LEN, MAX_BATCH, stripScheme, normalizeAddress, invalidInput };
export const API_BASE = 'https://api.youraitools.co/payguard';
export const FALLBACK_API_BASE = 'https://payguard.agentgate.workers.dev';
export const PAID_ADDRESS_URL = `${API_BASE}/v1/address`;
export const PAID_BATCH_URL = `${API_BASE}/v1/batch`;
export const ENGINE_VERSION = `payguard-${SDN_LITE.publish_date}`;
export const LIST = Object.freeze({
  source: SDN_LITE.source, source_url: SDN_LITE.source_url, list_updated_at: SDN_LITE.publish_date, generated_at: SDN_LITE.generated_at,
  address_count: SDN_LITE.address_count, by_currency: SDN_LITE.by_currency,
});
export const FULL_DETAILS = `Entity, programs, list date and checksum: paid API ${PAID_ADDRESS_URL} ($0.001 USDC on Base over x402), refreshed daily.`;

const ageDays = (iso, now) => Math.floor((now - Date.parse(`${iso}T00:00:00Z`)) / 86400000);

/** Offline preview of one address (bundled snapshot; see list_updated_at). */
export function previewAddress(input, { now = Date.now(), data = SDN_LITE } = {}) {
  const bad = invalidInput(input);
  if (bad) return { error: 'bad_request', message: bad, status: 400 };
  const key = normalizeAddress(input);
  const count = data.addresses[key] || 0;
  const raw = stripScheme(input);
  const chain = detectAddress(/^0x[0-9a-f]{40}$/i.test(raw) ? raw : key);
  const age = ageDays(data.publish_date, now);
  return {
    input: String(input).trim(), address: key, tier: 'preview', sanctioned: count > 0, match_count: count,
    chain: { guess: chain.guess, format: chain.format }, source: data.source, list_updated_at: data.publish_date, list_age_days: age,
    ...(age > 7 ? { stale_warning: `The bundled SDN snapshot is ${age} days old; the paid API is refreshed daily.` } : {}),
    full_details: PAID_ADDRESS_URL, disclaimer: DISCLAIMER, engine: ENGINE_VERSION,
  };
}

/** Offline preview of up to MAX_BATCH addresses. */
export function previewBatch(list, opts) {
  if (!Array.isArray(list) || !list.length) return { error: 'bad_request', message: '"addresses" must be a non-empty array of strings', status: 400 };
  if (list.length > MAX_BATCH) return { error: 'bad_request', message: `at most ${MAX_BATCH} addresses per batch`, status: 400 };
  for (const [i, a] of list.entries()) { const b = invalidInput(a); if (b) return { error: 'bad_request', message: `addresses[${i}]: ${b}`, status: 400 }; }
  const results = list.map((a) => previewAddress(a, opts));
  const { source, list_updated_at, list_age_days, stale_warning, disclaimer, engine } = results[0];
  return {
    tier: 'preview', count: results.length, sanctioned_count: results.filter((r) => r.sanctioned).length, any_sanctioned: results.some((r) => r.sanctioned),
    results: results.map(({ input, address, sanctioned, match_count, chain }) => ({ input, address, sanctioned, match_count, chain })),
    source, list_updated_at, list_age_days, ...(stale_warning ? { stale_warning } : {}), sdn_address_count: SDN_LITE.address_count,
    full_details: PAID_BATCH_URL, disclaimer, engine,
  };
}
