// One prepaid credit account per API key, in a SQLite-backed Durable Object (free plan; no KV writes anywhere).
// The DO name is the SHA-256 hex of the key, so the key itself is never stored. All state is one value `a` (plus
// nothing else), read and written inside a single DO event: Durable Object input gates make every method atomic,
// so concurrent debits can never overspend (balance is checked and written with no other event in between).
// Amounts are atomic USDC units (6 decimals) as integers.
// AccountCore holds the logic over a storage object ({get, put, deleteAll}) so tests run it in Node; the Durable
// Object class (account-do.js) only delegates to it.

export const RECENT_MAX = 200;
const now = () => Date.now();

export class AccountCore {
  constructor(storage) { this.storage = storage; }
  async load() { return (await this.storage.get('a')) || null; }
  async save(a) { await this.storage.put('a', a); }

  /** Create a new active account (mint). Fails if the account already exists. */
  async create({ balance, plan, paid, payment = null }) {
    if (await this.load()) return { ok: false, reason: 'exists' };
    const a = { v: 1, status: 'active', balance: Number(balance), credited: Number(balance), spent: 0, calls: 0, refunds: 0, created: now(), last_used: null,
      plan, paid: Number(paid || 0), payment, payments: [], pending: {}, by_tool: {}, recent: [] };
    if (payment) a.payments.push({ kind: 'pack', plan, paid: Number(paid || 0), credited: Number(balance), ...payment, t: now() });
    await this.save(a);
    return { ok: true, balance: a.balance };
  }

  /** Attach settlement details (payer, tx, network) to the purchase. */
  async confirm({ kind = 'pack', ref = null, payment }) {
    const a = await this.load(); if (!a) return { ok: false, reason: 'not_found' };
    if (kind === 'pack') { a.payment = payment; a.payments.push({ kind, plan: a.plan, paid: a.paid, credited: a.credited, ...payment, t: now() }); }
    await this.save(a);
    return { ok: true, ref };
  }

  /** Delete an account whose purchase did not settle (its key was never shown to anyone). */
  async cancel() { const a = await this.load(); if (!a) return { ok: true }; if (a.calls || a.payments.length > 1) return { ok: false, reason: 'in_use' }; await this.storage.deleteAll(); return { ok: true }; }

  /** Atomic debit. Returns { ok, balance } or { ok:false, reason, balance }. */
  async debit({ amount, tool = 'unknown', route = '', ref }) {
    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n <= 0 || !ref) return { ok: false, reason: 'bad_request' };
    const a = await this.load();
    if (!a || a.status !== 'active') return { ok: false, reason: 'invalid_key' };
    if (a.recent.some((r) => r.ref === ref)) return { ok: true, balance: a.balance, duplicate: true };
    if (a.balance < n) return { ok: false, reason: 'insufficient_balance', balance: a.balance };
    a.balance -= n; a.spent += n; a.calls += 1; a.last_used = now();
    const t = (a.by_tool[tool] ||= { calls: 0, spent: 0 }); t.calls += 1; t.spent += n;
    a.recent.unshift({ ref, tool, route, amount: n, t: a.last_used });
    if (a.recent.length > RECENT_MAX) a.recent.length = RECENT_MAX;
    await this.save(a);
    return { ok: true, balance: a.balance };
  }

  /** Return a debit (the call failed). Idempotent: a ref is refunded at most once; unknown refs are a no-op. */
  async refund({ ref }) {
    const a = await this.load(); if (!a) return { ok: false, reason: 'invalid_key' };
    const r = a.recent.find((x) => x.ref === ref);
    if (!r || r.refunded) return { ok: true, balance: a.balance, noop: true };
    r.refunded = true; a.balance += r.amount; a.spent -= r.amount; a.calls -= 1; a.refunds += 1;
    const t = a.by_tool[r.tool]; if (t) { t.calls -= 1; t.spent -= r.amount; }
    await this.save(a);
    return { ok: true, balance: a.balance };
  }

  /** Top-up, step 1 (inside the paid request): record it as pending; not spendable until settled. */
  async topupPending({ ref, amount, paid, plan }) {
    const a = await this.load(); if (!a || a.status !== 'active') return { ok: false, reason: 'invalid_key' };
    a.pending[ref] = { amount: Number(amount), paid: Number(paid), plan, t: now() };
    await this.save(a);
    return { ok: true, balance: a.balance };
  }
  /** Top-up, step 2 (after the x402 settlement succeeded). Idempotent by ref. */
  async topupCommit({ ref, payment = null }) {
    const a = await this.load(); if (!a) return { ok: false, reason: 'invalid_key' };
    const p = a.pending[ref]; if (!p) return { ok: true, balance: a.balance, noop: true };
    delete a.pending[ref];
    a.balance += p.amount; a.credited += p.amount;
    a.payments.push({ kind: 'topup', plan: p.plan, paid: p.paid, credited: p.amount, ref, ...(payment || {}), t: now() });
    if (a.payments.length > RECENT_MAX) a.payments.splice(1, a.payments.length - RECENT_MAX);
    await this.save(a);
    return { ok: true, balance: a.balance };
  }
  /** Top-up did not settle: drop the pending entry. */
  async topupVoid({ ref }) { const a = await this.load(); if (!a) return { ok: true }; delete a.pending[ref]; await this.save(a); return { ok: true }; }

  /** Key rotation, step 1 (old key): move the whole balance out and deactivate. */
  async drain({ to }) {
    const a = await this.load(); if (!a || a.status !== 'active') return { ok: false, reason: 'invalid_key' };
    if (Object.keys(a.pending).length) return { ok: false, reason: 'topup_pending' };
    const moved = { balance: a.balance, credited: a.credited, spent: a.spent, calls: a.calls, refunds: a.refunds, created: a.created, plan: a.plan, paid: a.paid, payment: a.payment, payments: a.payments, by_tool: a.by_tool };
    a.status = 'rotated'; a.rotated_to = to; a.balance = 0; a.rotated_at = now();
    await this.save(a);
    return { ok: true, moved };
  }
  /** Undo a drain if the new account could not be created. */
  async undrain({ moved }) { const a = await this.load(); if (!a || a.status !== 'rotated') return { ok: false }; a.status = 'active'; a.balance = moved.balance; delete a.rotated_to; await this.save(a); return { ok: true }; }
  /** Key rotation, step 2 (new key). */
  async adopt({ moved }) {
    if (await this.load()) return { ok: false, reason: 'exists' };
    const a = { v: 1, status: 'active', ...moved, last_used: null, pending: {}, recent: [], rotated_from_at: now() };
    await this.save(a);
    return { ok: true, balance: a.balance };
  }

  /** Direct-transfer claims (one object per tx, named claim:<chain>:<txHash>; stored under 'c', never 'a').
   *  Reserve is atomic (DO input gate): the first caller wins, every later call is a replay. */
  async claimReserve({ sender, amount, pack, chain, tx }) {
    const c = await this.storage.get('c');
    if (c) return { ok: false, reason: 'already_claimed', at: c.at, state: c.state };
    await this.storage.put('c', { state: 'reserved', sender, amount: Number(amount), pack, chain, tx, at: now() });
    return { ok: true };
  }
  async claimFinish({ account }) { const c = await this.storage.get('c'); if (!c) return { ok: false }; c.state = 'claimed'; c.account = account; c.done = now(); await this.storage.put('c', c); return { ok: true }; }
  /** Minting failed after the reserve: free the tx so the buyer can retry. */
  async claimRelease() { const c = await this.storage.get('c'); if (c && c.state === 'reserved') await this.storage.delete('c'); return { ok: true }; }

  /** Read-only view for GET /v1/balance (no payer data beyond what the key holder paid with). */
  async info() {
    const a = await this.load(); if (!a) return { ok: false, reason: 'invalid_key' };
    return { ok: true, status: a.status, balance: a.balance, credited: a.credited, spent: a.spent, calls: a.calls, refunds: a.refunds, created: a.created, last_used: a.last_used, plan: a.plan,
      by_tool: a.by_tool, recent: a.recent.slice(0, 20), payments: a.payments.map(({ kind, plan, paid, credited, network, transaction, t }) => ({ kind, plan, paid, credited, network, transaction, t })), pending_topups: Object.keys(a.pending).length };
  }
}
