// RPC used by the tool Workers (service binding CREDITS, entrypoint CreditsGate): debit / refund a key's balance.
// Never receives or returns anything but the key, an amount and a ref; the key is hashed before any lookup.
import { KEY_RE, accountFor } from './ledger.js';

export function gateOps(ns, stats, waitUntil) {
  const hit = (ev) => { try { stats?.hit(ev, waitUntil); } catch { /* fail-open */ } };
  return {
    async debit({ key, amount, tool, route, ref } = {}) {
      if (!KEY_RE.test(String(key || ''))) return { ok: false, reason: 'invalid_key' };
      const n = Number(amount);
      if (!Number.isSafeInteger(n) || n <= 0 || n > 5000000 || !/^r_[0-9a-f]{24}$/.test(String(ref || ''))) return { ok: false, reason: 'bad_request' };
      const t = String(tool || 'unknown').slice(0, 32).replace(/[^a-z0-9-]/gi, '');
      const r = await (await accountFor(ns, key)).debit({ amount: n, tool: t, route: String(route || '').slice(0, 64), ref });
      hit(r.ok ? ['debit', `debit:${t}`] : [`debit_${r.reason}`]);
      return r.ok ? { ok: true, balance: r.balance } : { ok: false, reason: r.reason, ...(r.balance !== undefined ? { balance: r.balance } : {}) };
    },
    async refund({ key, ref } = {}) {
      if (!KEY_RE.test(String(key || '')) || !/^r_[0-9a-f]{24}$/.test(String(ref || ''))) return { ok: false, reason: 'bad_request' };
      const r = await (await accountFor(ns, key)).refund({ ref });
      if (r.ok && !r.noop) hit('refund');
      return r.ok ? { ok: true, balance: r.balance } : { ok: false, reason: r.reason };
    },
  };
}
