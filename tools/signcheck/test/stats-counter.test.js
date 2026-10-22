import test from 'node:test';
import assert from 'node:assert/strict';
import { Stats } from '../src/stats.js';

// Fake Durable Object namespace with the same upsert semantics as counter-do.js
function fakeCounter({ fail = false } = {}) {
  const rows = new Map(); let calls = 0;
  const stub = {
    async add(p) { calls++; if (fail) throw new Error('quota'); for (const [d, c] of Object.entries(p)) for (const [e, n] of Object.entries(c)) rows.set(`${d}|${e}`, (rows.get(`${d}|${e}`) || 0) + n); },
    async rows(since) { if (fail) throw new Error('quota'); return [...rows].map(([k, n]) => { const [day, ev] = k.split('|'); return { day, ev, n }; }).filter((r) => r.day >= since); },
  };
  return { idFromName: () => 'id', get: () => stub, get calls() { return calls; } };
}
const kvSpy = (data = {}) => { const ops = { get: 0, put: 0 }; return { ops, async get(k) { ops.get++; return data[k] ?? null; }, async put() { ops.put++; throw new Error('KV put limit exceeded'); } }; };

test('counter path: batches, never writes KV, merges frozen KV history', async () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const kv = kvSpy({ 'd:2026-10-21': { challenge_402: 5 }, 'd:2026-10-22': { challenge_402: 2, paid: 1 } });
  const counter = fakeCounter();
  const s = new Stats(kv, { counter, flushMs: 60000, now: () => now });
  for (let i = 0; i < 10; i++) s.hit('challenge_402');
  s.hit(['paid', 'paid:/v1/x']);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(counter.calls, 1, 'only the first hit flushes inside the window');
  assert.equal(kv.ops.put, 0, 'no KV writes');
  const sum = await s.summary(30);
  assert.equal(sum.totals.challenge_402, 17);
  assert.equal(sum.totals.paid, 2);
  assert.equal(sum.days[0].day, '2026-10-25');
});

test('fail-open: storage errors never throw from hit/summary', async () => {
  const s = new Stats(kvSpy(), { counter: fakeCounter({ fail: true }), flushMs: 0 });
  assert.doesNotThrow(() => s.hit('paid'));
  await new Promise((r) => setTimeout(r, 5));
  const sum = await s.summary(30);
  assert.equal(sum.degraded, true);
  assert.equal(sum.totals.paid, 1, 'unflushed counts still reported');
  const s2 = new Stats(kvSpy(), { flushMs: 0 }); // KV-only path with a quota error on put
  assert.doesNotThrow(() => s2.hit('paid'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await s2.summary(3)).enabled, true);
});

test('no KV binding at all (SignCheck production): counter-only Stats is enabled and never touches KV', async () => {
  const counter = fakeCounter();
  const s = new Stats(undefined, { counter, flushMs: 0 });
  assert.equal(s.enabled, true);
  s.hit('challenge_402'); await new Promise((r) => setTimeout(r, 5));
  const sum = await s.summary(30); assert.equal(sum.enabled, true); assert.ok((sum.totals.challenge_402 || 0) >= 1);
});
