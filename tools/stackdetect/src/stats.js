// Usage counters, free-plan safe (rewritten 2026-10-21 after the Cloudflare KV write-limit alert).
// Production: counts are batched in memory per isolate and flushed at most once per `flushMs` to a SQLite-backed
// Durable Object (binding COUNTER, class StatsCounter in counter-do.js) with an atomic upsert: no KV writes at all.
// KV (binding STATS) is now READ-ONLY here: it only supplies the frozen pre-cutover history (days <= legacyUntil).
// Without a COUNTER binding (tests/local) the old KV get+put path is used.
// Every storage call is fail-open: a quota or storage error can never throw into a request (paid routes never await it).
// Counts are approximate; on-chain USDC transfers remain the source of truth for revenue.
// Requests carrying `x-stackdetect-smoke: 1` (our own CI smoke test) are never counted.
export const EVENTS = ['challenge_402', 'paid', 'paid_failed', 'free_preview', 'free_mcp', 'free_rate_limited', 'bad_request'];

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const LEGACY_UNTIL = '2026-10-22'; // last UTC day whose counts were written to KV

export class Stats {
  /** @param {any} kv KV namespace (read-only legacy history when `counter` is set), may be undefined
   *  @param {{counter?: any, flushMs?: number, now?: () => number, legacyUntil?: string}} opts */
  constructor(kv, { counter, flushMs = 60000, now = () => Date.now(), legacyUntil = LEGACY_UNTIL } = {}) {
    this.kv = kv; this.counter = counter; this.flushMs = flushMs; this.now = now; this.legacyUntil = legacyUntil;
    this.pending = {}; this.lastFlush = 0; this.cache = null; this.legacy = null; this.errors = 0;
  }
  get enabled() { return !!(this.kv || this.counter); }

  /** Record one event (or several, counted as one batch). Never throws. */
  hit(event, waitUntil) {
    try {
      if (!this.enabled) return;
      const bucket = (this.pending[day(this.now())] ||= {});
      for (const ev of Array.isArray(event) ? event : [event]) bucket[ev] = (bucket[ev] || 0) + 1;
      if (this.now() - this.lastFlush >= this.flushMs) {
        this.lastFlush = this.now();
        const p = this.flush().catch(() => { this.errors++; });
        try { waitUntil?.(p); } catch { /* not on Workers */ }
      }
    } catch { this.errors++; }
  }

  async flush() {
    const pending = this.pending; this.pending = {};
    if (!Object.keys(pending).length) return;
    try {
      if (this.counter) {
        await this.stub().add(pending);
      } else {
        for (const [d, counts] of Object.entries(pending)) {
          const key = `d:${d}`;
          const cur = (await this.kv.get(key, 'json')) || {};
          for (const [k, v] of Object.entries(counts)) cur[k] = (cur[k] || 0) + v;
          await this.kv.put(key, JSON.stringify(cur));
        }
      }
      this.cache = null;
    } catch (e) {
      // put the counts back (bounded) so a transient error loses nothing; a hard quota error just drops them later
      for (const [d, counts] of Object.entries(pending)) {
        const b = (this.pending[d] ||= {});
        for (const [k, v] of Object.entries(counts)) b[k] = (b[k] || 0) + v;
      }
      for (const d of Object.keys(this.pending).sort().slice(0, -3)) delete this.pending[d];
      throw e;
    }
  }

  stub() { return this.counter.get(this.counter.idFromName('global')); }

  async legacyDays(days) {
    if (!this.kv || !this.counter) return {};
    if (this.legacy && this.now() - this.legacy.at < 3600000) return this.legacy.value;
    const value = {};
    for (let i = 0; i < days; i++) {
      const d = day(this.now() - i * 86400000);
      if (d > this.legacyUntil) continue;
      try { const v = await this.kv.get(`d:${d}`, 'json'); if (v) value[d] = v; } catch { /* fail-open */ }
    }
    this.legacy = { at: this.now(), value };
    return value;
  }

  /** Per-day counts for the last `days` UTC days plus totals. Cached for 60 s. Never throws. */
  async summary(days = 30) {
    if (!this.enabled) return { enabled: false };
    if (this.cache && this.now() - this.cache.at < 60000) return this.cache.value;
    const per = {}; let degraded = false;
    const add = (d, counts) => { const b = (per[d] ||= {}); for (const [k, v] of Object.entries(counts || {})) b[k] = (b[k] || 0) + Number(v || 0); };
    const since = day(this.now() - (days - 1) * 86400000);
    try {
      if (this.counter) {
        for (const r of await this.stub().rows(since)) add(r.day, { [r.ev]: r.n });
        for (const [d, v] of Object.entries(await this.legacyDays(days))) add(d, v);
      } else {
        for (let i = 0; i < days; i++) { const d = day(this.now() - i * 86400000); add(d, (await this.kv.get(`d:${d}`, 'json')) || {}); }
      }
    } catch { degraded = true; }
    for (const [d, c] of Object.entries(this.pending)) if (d >= since) add(d, c);
    const out = []; const totals = {};
    for (const d of Object.keys(per).sort().reverse()) {
      const counts = per[d]; if (!Object.keys(counts).length) continue;
      out.push({ day: d, ...counts });
      for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] || 0) + v;
    }
    const value = {
      enabled: true, window_days: days, totals, days: out,
      ...(degraded ? { degraded: true } : {}),
      note: 'Approximate counters (batched per Worker isolate). Our own CI smoke tests are excluded. Paid revenue is verifiable on-chain: USDC transfers on Base to the payTo wallet.',
      generated_at: new Date(this.now()).toISOString(),
    };
    this.cache = { at: this.now(), value };
    return value;
  }
}

export const isSmoke = (c) => c.req.header('x-stackdetect-smoke') === '1';
export const waitUntilOf = (c) => { try { const ec = c.executionCtx; return (p) => ec.waitUntil(p); } catch { return undefined; } };

/** Hono middleware for the paid route: classify the outcome after x402 has run. Mount BEFORE paymentMiddleware.
 *  Counting is fire-and-forget and can never change the paid response. */
export function paidRouteStats(stats, route) {
  return async (c, next) => {
    await next();
    try {
      if (isSmoke(c)) return;
      const s = c.res.status;
      const ev = s === 402 ? 'challenge_402'
        : s === 200 && (c.res.headers.get('PAYMENT-RESPONSE') || c.res.headers.get('X-PAYMENT-RESPONSE')) ? 'paid'
        : s === 400 ? 'bad_request'
        : s >= 400 && (c.req.header('PAYMENT-SIGNATURE') || c.req.header('X-PAYMENT')) ? 'paid_failed'
        : null;
      if (ev) stats.hit(route ? [ev, `${ev}:${route}`] : ev, waitUntilOf(c)); // one hit => one flush (no lost update)
    } catch { /* fail-open */ }
  };
}
