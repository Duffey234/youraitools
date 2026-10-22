// PayGuard screening engine: exact-match lookup of an address against the digital currency addresses published in
// the US Treasury OFAC SDN list (bundled snapshot, see scripts/build-sdn.py). Pure and synchronous: no network.
import { SDN } from './data/sdn.js';
import { detectAddress } from './address.js';
import { DISCLAIMER, MAX_LEN, MAX_BATCH, stripScheme, normalizeAddress, invalidInput } from './normalize.js';

export { DISCLAIMER, MAX_LEN, MAX_BATCH, stripScheme, normalizeAddress, invalidInput };

export const ENGINE_VERSION = `payguard-${SDN.publish_date}`;
export const LIST = Object.freeze({
  source: SDN.source, source_url: SDN.source_url, list_updated_at: SDN.publish_date, generated_at: SDN.generated_at,
  address_count: SDN.address_count, entity_count: SDN.entity_count, by_currency: SDN.by_currency,
});

const ageDays = (iso, now) => Math.floor((now - Date.parse(`${iso}T00:00:00Z`)) / 86400000);

/** Full screen (paid tier). */
export function screenAddress(input, { now = Date.now(), data = SDN } = {}) {
  const bad = invalidInput(input);
  if (bad) return { error: 'bad_request', message: bad, status: 400 };
  const key = normalizeAddress(input);
  const hits = data.addresses[key] || [];
  const matches = hits.map(([uid, currency]) => {
    const e = data.entities[uid] || {};
    return { entity: e.name, entity_type: e.type, sdn_uid: Number(uid), programs: e.programs || [], list_date: e.list_date || null, listed_currency: currency, listed_as: `Digital Currency Address - ${currency}` };
  });
  const raw = stripScheme(input);
  const chain = detectAddress(/^0x[0-9a-f]{40}$/i.test(raw) ? raw : key);
  const age = ageDays(data.publish_date, now);
  return {
    input: String(input).trim(), address: key, sanctioned: matches.length > 0, match_count: matches.length, matches, chain,
    source: data.source, source_url: data.source_url, list_updated_at: data.publish_date, list_age_days: age,
    ...(age > 7 ? { stale_warning: `The bundled SDN snapshot is ${age} days old; check the official list for recent designations.` } : {}),
    sdn_address_count: data.address_count, match_type: 'exact (EVM hex and bech32 case-insensitive, base58 exact)',
    disclaimer: DISCLAIMER, engine: ENGINE_VERSION,
  };
}

/** Free preview: the verdict and chain guess, without entity details or checksum. */
export function previewAddress(input, opts) {
  const r = screenAddress(input, opts);
  if (r.error) return r;
  return { input: r.input, address: r.address, tier: 'preview', sanctioned: r.sanctioned, match_count: r.match_count, chain: { guess: r.chain.guess, format: r.chain.format }, source: r.source, list_updated_at: r.list_updated_at, disclaimer: r.disclaimer, engine: r.engine };
}

export function screenBatch(list, opts) {
  if (!Array.isArray(list) || !list.length) return { error: 'bad_request', message: '"addresses" must be a non-empty array of strings', status: 400 };
  if (list.length > MAX_BATCH) return { error: 'bad_request', message: `at most ${MAX_BATCH} addresses per batch`, status: 400 };
  for (const [i, a] of list.entries()) { const b = invalidInput(a); if (b) return { error: 'bad_request', message: `addresses[${i}]: ${b}`, status: 400 }; }
  const results = list.map((a) => screenAddress(a, opts));
  const { source, source_url, list_updated_at, list_age_days, disclaimer, engine } = results[0];
  return { count: results.length, sanctioned_count: results.filter((r) => r.sanctioned).length, any_sanctioned: results.some((r) => r.sanctioned), results: results.map(({ source: _s, source_url: _u, list_updated_at: _l, list_age_days: _a, disclaimer: _d, engine: _e, sdn_address_count: _c, match_type: _m, ...r }) => r), source, source_url, list_updated_at, list_age_days, sdn_address_count: SDN.address_count, disclaimer, engine };
}
