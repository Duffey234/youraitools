// Input handling shared by the full engine (screen.js, Worker) and the offline preview (lite.js, npm package).
// No list data here.
export const DISCLAIMER = 'Informational screening against the public OFAC SDN list (digital currency address identifiers only). Not legal advice. A clear result does not mean an address or its owner is unsanctioned or low-risk; OFAC sanctions also apply to persons and property not listed by address.';
export const MAX_LEN = 140;
export const MAX_BATCH = 50;

/** Lookup key: EVM hex and bech32 / cashaddr are case-insensitive; base58 formats are exact. URI schemes are stripped. */
export const stripScheme = (input) => String(input ?? '').trim().replace(/^(ethereum|bitcoin|litecoin|tron|solana|dogecoin|dash|zcash|monero|ripple|xrp):/i, '').split(/[?@/]/)[0];
export function normalizeAddress(input) {
  const a = stripScheme(input);
  const low = a.toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(low)) return low;
  if (/^(bitcoincash|bchtest):/.test(low)) return low.split(':')[1];
  if (/^(bc1|tb1|ltc1|bnb1)/.test(low)) return low;
  if (/^[qp][0-9a-z]{41}$/.test(low) && (a === low || a === a.toUpperCase())) return low;
  return a;
}

/** null when the input could be an address; otherwise a reason string (used for 400s before payment). */
export function invalidInput(input) {
  if (typeof input !== 'string' || !input.trim()) return 'address (string) is required';
  const a = input.trim();
  if (a.length > MAX_LEN) return `address longer than ${MAX_LEN} characters`;
  if (!/^[A-Za-z0-9:]+$/.test(normalizeAddress(a))) return 'address may only contain letters, digits and an optional scheme prefix such as "bitcoincash:"';
  if (normalizeAddress(a).length < 20) return 'too short to be a blockchain address';
  return null;
}

