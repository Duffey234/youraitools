// MOCK x402 paywall for the offline demo ONLY.
// It speaks the x402 v2 header shapes (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE)
// but "verifies" payments with a fake facilitator that checks fields only - no signatures, no chain,
// no funds. In production replace it with the official x402 middleware, e.g. @x402/express
// paymentMiddleware with a real facilitator.
import { HEADERS, encodeHeader, readPaymentPayload } from '../src/x402.js';

export function mockPaywall({ price = '1000', asset = 'MOCK-USDC', payTo = 'MOCK-PAYTO', network = 'concordium:testnet' } = {}) {
  const requirements = { x402Version: 2, accepts: [{ scheme: 'exact', network, amount: price, asset, payTo, maxTimeoutSeconds: 60, extra: { mock: true } }] };
  return (req, res, next) => {
    const payment = readPaymentPayload(req);
    if (!payment) {
      res.setHeader(HEADERS.required, encodeHeader(requirements));
      return res.status(402).json({ error: 'payment_required', mock: true, ...requirements });
    }
    const a = payment.accepted || {};
    if (a.amount !== price || a.payTo !== payTo) return res.status(402).json({ error: 'invalid_payment', mock: true });
    res.setHeader(HEADERS.response, encodeHeader({ success: true, transaction: 'MOCK-TX', network, mock: true }));
    next();
  };
}
