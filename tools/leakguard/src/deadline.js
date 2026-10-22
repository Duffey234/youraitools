// Hard deadlines so no request can hang: every awaited network step races a timer, and the Worker entry has a
// last-resort watchdog. Budgets (paid route, worst case): verify 8 s + work <= 20 s + settle 15 s < 45 s watchdog.
export const BUDGET = { supportedMs: 3000, verifyMs: 8000, settleMs: 15000, workMs: 20000, watchdogMs: 45000 };

export class DeadlineError extends Error {
  constructor(what, ms) { super(`${what} timed out after ${ms} ms`); this.name = 'DeadlineError'; this.code = 'timeout'; }
}

/** Resolve/reject with `p`, or reject with DeadlineError after `ms`. The timer is always cleared. */
export function withDeadline(p, ms, what = 'operation') {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new DeadlineError(what, ms)), ms); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}

/** Wrap a Worker fetch handler: answer 503 (never charged, settlement only follows a 2xx) instead of hanging. */
export function watchdog(handler, ms = BUDGET.watchdogMs) {
  return (request, env, ctx) => withDeadline(Promise.resolve().then(() => handler(request, env, ctx)), ms, 'request').catch((e) => {
    console.error(`watchdog: ${request.method} ${new URL(request.url).pathname}: ${e && e.message}`);
    return new Response(JSON.stringify({ error: e instanceof DeadlineError ? 'timeout' : 'internal_error', message: 'The request took too long or failed; it was not charged. Please retry.' }), {
      status: 503, headers: { 'content-type': 'application/json', 'retry-after': '5', 'access-control-allow-origin': '*' },
    });
  });
}
