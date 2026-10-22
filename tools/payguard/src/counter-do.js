// SQLite-backed Durable Object holding the usage counters (free plan: SQLite DOs, no KV write quota involved).
// One instance ("global") per Worker; Stats.flush() sends batched {day: {event: n}} maps; upserts are atomic.
import { DurableObject } from 'cloudflare:workers';

export class StatsCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS c (day TEXT NOT NULL, ev TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ev))');
  }
  add(pending) {
    for (const [d, counts] of Object.entries(pending || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      for (const [ev, n] of Object.entries(counts || {})) {
        const k = Number(n);
        if (!/^[a-z0-9_:\-]{1,64}$/i.test(ev) || !Number.isFinite(k) || k <= 0) continue;
        this.sql.exec('INSERT INTO c (day, ev, n) VALUES (?, ?, ?) ON CONFLICT (day, ev) DO UPDATE SET n = n + excluded.n', d, ev, Math.floor(k));
      }
    }
    return true;
  }
  rows(since) {
    return this.sql.exec('SELECT day, ev, n FROM c WHERE day >= ? ORDER BY day DESC', String(since || '')).toArray();
  }
}
