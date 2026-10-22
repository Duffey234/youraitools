// x402 v1 compatibility for a v2 (@x402/hono) server.
// Many deployed agents still run v1 clients (x402-fetch, x402-axios, the Python `x402` 1.x package). They read the
// payment terms from the 402 JSON *body* (`accepts[].maxAmountRequired`, network "base") and pay with an `X-PAYMENT`
// header. @x402/hono 2.x only emits the v2 `PAYMENT-REQUIRED` header (body `{}`) and only reads `PAYMENT-SIGNATURE`,
// so v1 clients could not pay. This module:
//   1. fills the 402 body with v1 PaymentRequirements (v2 clients keep using the header, which is unchanged), and
//   2. verifies/settles v1 `X-PAYMENT` payloads through the same facilitator's v1 API, settling only on success (<400).
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
const V1_NETWORK = { 'eip155:8453': 'base', 'eip155:84532': 'base-sepolia' };

import { withDeadline, BUDGET } from './deadline.js';

/**
 * @param {object} o
 * @param {string} o.path paid route path
 * @param {string} o.amount atomic USDC amount, e.g. '5000'
 * @param {string} o.asset USDC contract
 * @param {string} o.payTo
 * @param {string} o.network CAIP-2, e.g. 'eip155:8453'
 * @param {string} o.description
 * @param {string} [o.mimeType]
 * @param {object} [o.outputSchema] v1 discovery schema { input, output }
 * @param {number} [o.maxTimeoutSeconds]
 * @param {string} [o.publicUrl]
 * @param {string} o.facilitatorUrl
 * @param {(url:string, init?:object)=>Promise<Response>} [o.fetchImpl] for tests
 */
export function x402v1(o) {
  const network = V1_NETWORK[o.network];
  const f = o.fetchImpl || ((u, i) => globalThis.fetch(u, i));
  const requirements = (c) => ({
    scheme: 'exact', network, maxAmountRequired: o.amount,
    resource: `${(o.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '')}${o.path}`,
    description: o.description, mimeType: o.mimeType || 'application/json',
    ...(o.outputSchema ? { outputSchema: o.outputSchema } : {}),
    payTo: o.payTo, maxTimeoutSeconds: o.maxTimeoutSeconds || 120, asset: o.asset,
    extra: { name: 'USD Coin', version: '2' },
  });
  const paymentRequired = (c, error, status = 402) => {
    c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');
    return c.json({ x402Version: 1, error, accepts: [requirements(c)] }, status);
  };
  async function facilitator(op, paymentPayload, paymentRequirements) {
    // One deadline covers connect, headers and body; the abort frees the socket when it fires.
    const ms = op === 'settle' ? BUDGET.settleMs : BUDGET.verifyMs;
    const ctrl = new AbortController();
    return withDeadline((async () => {
      const r = await f(`${o.facilitatorUrl.replace(/\/$/, '')}/${op}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
      });
      return r.json();
    })(), ms, `facilitator /${op}`).finally(() => ctrl.abort());
  }

  /** Mount BEFORE the v2 paymentMiddleware (and wrap it with `skipIfV1`). */
  const middleware = async (c, next) => {
    if (c.req.path !== o.path || !network) return next();
    const header = c.req.header('x-payment');
    let payload = null;
    if (header && !c.req.header('payment-signature')) { try { payload = unb64(header); } catch { payload = null; } }
    if (payload && payload.x402Version === 1) {
      const req = requirements(c);
      const auth = payload.payload?.authorization;
      if (payload.scheme !== 'exact' || payload.network !== network || !auth) return paymentRequired(c, 'unsupported_scheme_or_network');
      if (String(auth.to).toLowerCase() !== o.payTo.toLowerCase() || BigInt(auth.value || 0) < BigInt(o.amount)) return paymentRequired(c, 'invalid_payment_amount_or_recipient');
      let v;
      try { v = await facilitator('verify', payload, req); } catch (e) { return paymentRequired(c, `verify_failed: ${e.message}`); }
      if (!v?.isValid) return paymentRequired(c, v?.invalidReason || 'invalid_payment');
      c.set('x402v1', true);
      await next();
      if (c.res.status >= 400) return; // never settle failed calls
      let s;
      try { s = await facilitator('settle', payload, req); } catch (e) { s = { success: false, errorReason: e.message }; }
      if (!s?.success) { c.res = undefined; return paymentRequired(c, s?.errorReason || 'settlement_failed'); }
      c.header('X-PAYMENT-RESPONSE', b64({ success: true, transaction: s.transaction, network: s.network || network, payer: s.payer || v.payer || auth.from }));
      c.header('Access-Control-Expose-Headers', 'X-PAYMENT-RESPONSE');
      return;
    }
    await next();
    // Unpaid (or v2) request answered 402 by the v2 middleware with an empty JSON body: add the v1 terms to the body.
    if (c.res.status === 402 && /application\/json/.test(c.res.headers.get('content-type') || '')) {
      let body = null;
      try { body = await c.res.clone().json(); } catch { /* keep */ }
      if (body && typeof body === 'object' && !Array.isArray(body) && !body.accepts) {
        const headers = new Headers(c.res.headers);
        const req = requirements(c);
        const merged = { ...body, x402Version: 1, error: body.error || 'X-PAYMENT header is required', accepts: [req] };
        headers.set('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');
        c.res = undefined;
        c.res = new Response(JSON.stringify(merged), { status: 402, headers });
      }
    }
  };
  /** Wraps the v2 middleware so it is skipped for requests already paid with v1. */
  const skipIfV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  return { middleware, skipIfV1, requirements };
}
