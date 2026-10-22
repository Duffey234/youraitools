// Prepaid credits for the YourAITools x402 tools. One canonical copy, copied
// verbatim into each tool Worker's src/ (like networks.js). Drop-in replacement for @x402/hono's paymentMiddleware:
//   * No credits key on the request (or a value not in our key format, or the request also carries PAYMENT-SIGNATURE /
//     X-PAYMENT) -> the original x402 middleware handles it exactly as before: same 402 terms, same verify/settle.
//   * A key (`Authorization: Bearer yatc_...`, `X-Credits-Key: yatc_...` or `X-Credit-Token: yatc_...`) on a paid
//     route -> that route's price (its first, Base accepts entry) is debited atomically from the key's prepaid balance
//     in the credits Worker (service binding CREDITS, RPC entrypoint CreditsGate) and the request is served with no
//     on-chain payment. Any response >= 400 is not charged: the debit goes back to the balance (idempotent by ref).
//   * Unknown key, insufficient balance or credits unavailable -> the normal x402 402 response (same PAYMENT-REQUIRED
//     header), plus X-Credits-Error / X-Credits-Topup headers and a `credits` hint in the JSON body.
import { paymentMiddleware as x402PaymentMiddleware } from '@x402/hono';

export const KEY_RE = /^yatc_[A-Za-z0-9_-]{43}$/;
export const CREDITS_URL = 'https://api.youraitools.co/credits';
export const CREDIT_HEADERS = ['authorization', 'x-credits-key', 'x-credit-token'];
const RPC_MS = 4000;
const EXPOSE = 'X-Credits-Charged, X-Credits-Remaining, X-Credits-Ref, X-Credits-Error, X-Credits-Topup';

/** The credits key on a request (Hono c.req or a Fetch Request), or null. Only values in our key format count. */
export function creditsKeyOf(req) {
  const get = (n) => (typeof req.header === 'function' ? req.header(n) : req.headers?.get(n)) || '';
  const auth = get('authorization').trim();
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  for (const v of [m ? m[1] : '', get('x-credits-key').trim(), get('x-credit-token').trim()]) if (KEY_RE.test(v)) return v;
  return null;
}

/** Atomic USDC amount (6 decimals) of an accepts entry's price ('$0.001', '0.001', 0.001 or { amount }). */
export function atomicPrice(accept) {
  const p = accept?.price ?? accept?.amount;
  if (p && typeof p === 'object' && 'amount' in p) return String(p.amount);
  const s = String(p ?? '').trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return String(BigInt(i) * 1000000n + BigInt((f + '000000').slice(0, 6)));
}
export const usd = (atomic) => (Number(atomic) / 1e6).toFixed(6);

function withDeadline(p, ms) {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('credits timeout')), ms); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}
const waitUntil = (c, p) => { try { c.executionCtx.waitUntil(p); } catch { /* not on Workers */ } };
const toolOf = (c) => String(c.env?.PROXY_PREFIX || '').replace(/^\//, '') || 'unknown';
const randomRef = () => `r_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Build the per-route price table from the x402 routes config ({ 'GET /v1/x': { accepts } }). */
export function priceTable(routes) {
  const out = new Map();
  for (const [k, r] of Object.entries(routes || {})) {
    const acc = Array.isArray(r?.accepts) ? r.accepts : [r?.accepts];
    const a = atomicPrice(acc[0]);
    const [method, path] = k.trim().split(/\s+/);
    if (a && method && path && !path.includes('*') && !path.includes(':')) out.set(`${method.toUpperCase()} ${path}`, a);
  }
  return out;
}

/**
 * Same signature as @x402/hono paymentMiddleware. opts.credits (tests) replaces the CREDITS service binding.
 */
export function paymentMiddleware(routes, server, paywallConfig, paywall, syncFacilitatorOnStart = true, opts = {}) {
  const x402 = x402PaymentMiddleware(routes, server, paywallConfig, paywall, syncFacilitatorOnStart);
  const prices = priceTable(routes);
  return async (c, next) => {
    const key = creditsKeyOf(c.req);
    const price = key ? prices.get(`${c.req.method} ${c.req.path}`) : undefined;
    if (!key || !price || c.req.header('payment-signature') || c.req.header('x-payment')) return x402(c, next);
    const svc = opts.credits || c.env?.CREDITS;
    const tool = toolOf(c);
    const ref = randomRef();
    let d;
    try {
      if (!svc || typeof svc.debit !== 'function') throw new Error('credits binding missing');
      d = await withDeadline(svc.debit({ key, amount: price, tool, route: `${c.req.method} ${c.req.path}`, ref }), RPC_MS);
    } catch (e) {
      console.warn(`credits: debit failed (${e && e.message}); answering with the x402 terms`);
      if (svc && typeof svc.refund === 'function') waitUntil(c, Promise.resolve().then(() => svc.refund({ key, ref })).catch(() => {})); // in case the debit landed after the timeout
      d = { ok: false, reason: 'credits_unavailable' };
    }
    if (!d?.ok) return insufficient(c, next, x402, d || {}, price);
    // Paid from credits: serve, then return the debit if the call failed (>= 400 is never charged, as with x402).
    let done; const finished = new Promise((r) => { done = r; });
    waitUntil(c, finished);
    let remaining = d.balance;
    try {
      await next();
    } finally {
      const failed = !c.res || c.res.status >= 400;
      if (failed) {
        try { const r = await withDeadline(svc.refund({ key, ref }), RPC_MS); if (r?.balance !== undefined) remaining = r.balance; }
        catch (e) { console.error(`credits: refund ${ref} failed: ${e && e.message}`); waitUntil(c, Promise.resolve().then(() => svc.refund({ key, ref })).catch(() => {})); }
      }
      try {
        if (c.res) {
          c.header('X-Credits-Charged', failed ? '0.000000' : usd(price));
          c.header('X-Credits-Remaining', usd(remaining));
          c.header('X-Credits-Ref', ref);
          c.header('Access-Control-Expose-Headers', EXPOSE);
        }
      } catch { /* headers are best-effort */ }
      done();
    }
  };
}

async function insufficient(c, next, x402, d, price) {
  const r = await x402(c, next); // the normal 402 with the unchanged PAYMENT-REQUIRED terms
  if (r instanceof Response) { c.res = undefined; c.res = r; }
  try {
    if (!c.res || c.res.status !== 402) return;
    const reason = d.reason || 'credits_unavailable';
    const topup = `${CREDITS_URL}/`;
    const message = reason === 'insufficient_balance'
      ? `Credits balance ${usd(d.balance || 0)} USDC is below this call's price ${usd(price)}. Top up the key at ${CREDITS_URL}/v1/topup/1 or /v1/topup/5, or pay this call with x402.`
      : reason === 'invalid_key' ? `Unknown or inactive credits key. Buy a pack at ${CREDITS_URL}/v1/pack/1 or /v1/pack/5, or pay this call with x402.`
        : 'Credits are temporarily unavailable; pay this call with x402 or retry shortly. Your balance was not charged.';
    const headers = new Headers(c.res.headers);
    headers.set('X-Credits-Error', reason);
    headers.set('X-Credits-Topup', topup);
    headers.set('Access-Control-Expose-Headers', [headers.get('Access-Control-Expose-Headers'), 'X-Credits-Error, X-Credits-Topup'].filter(Boolean).join(', '));
    let body = await c.res.clone().text();
    if (/application\/json/.test(headers.get('content-type') || '')) {
      try {
        const j = JSON.parse(body || '{}');
        if (j && typeof j === 'object' && !Array.isArray(j)) { j.credits = { error: reason, message, price_usd: usd(price), ...(d.balance !== undefined ? { balance_usd: usd(d.balance) } : {}), topup }; body = JSON.stringify(j); headers.delete('content-length'); }
      } catch { /* keep the body */ }
    }
    c.res = undefined;
    c.res = new Response(body, { status: 402, headers });
  } catch { /* the plain 402 stands */ }
  return c.res;
}
