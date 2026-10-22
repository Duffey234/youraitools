// Minimal helpers for x402 v2 HTTP headers.
// Spec: https://github.com/coinbase/x402 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE,
// each a base64-encoded JSON document). These helpers only encode/decode; they never sign or settle.

export const HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
  legacyPayment: 'X-PAYMENT', // x402 v1
};

export function encodeHeader(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export function decodeHeader(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return null; }
}

/** Read the x402 payment payload a client sent (v2 PAYMENT-SIGNATURE, falling back to v1 X-PAYMENT). */
export function readPaymentPayload(req) {
  const h = getHeader(req, HEADERS.signature) || getHeader(req, HEADERS.legacyPayment);
  return decodeHeader(h);
}

/**
 * Best-effort extraction of the paying address from an x402 payment payload.
 * - EVM "exact" scheme: payload.authorization.from (EIP-3009)
 * - Other schemes/facilitators commonly expose `payer` or `from`.
 */
export function payerOf(payment) {
  if (!payment || typeof payment !== 'object') return null;
  const p = payment.payload || {};
  return p.authorization?.from || p.payer || p.from || payment.payer || null;
}

export function getHeader(req, name) {
  if (typeof req.get === 'function') return req.get(name) || undefined;
  const h = req.headers || {};
  return h[name.toLowerCase()] ?? h[name];
}
