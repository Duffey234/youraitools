// SQLite-backed Durable Object: one per credits key (name = SHA-256 hex of the key). Logic lives in account.js.
import { DurableObject } from 'cloudflare:workers';
import { AccountCore } from './account.js';

export class CreditAccount extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new AccountCore(ctx.storage); }
  create(arg) { return this.core.create(arg || {}); }
  confirm(arg) { return this.core.confirm(arg || {}); }
  cancel(arg) { return this.core.cancel(arg || {}); }
  debit(arg) { return this.core.debit(arg || {}); }
  refund(arg) { return this.core.refund(arg || {}); }
  topupPending(arg) { return this.core.topupPending(arg || {}); }
  topupCommit(arg) { return this.core.topupCommit(arg || {}); }
  topupVoid(arg) { return this.core.topupVoid(arg || {}); }
  drain(arg) { return this.core.drain(arg || {}); }
  undrain(arg) { return this.core.undrain(arg || {}); }
  adopt(arg) { return this.core.adopt(arg || {}); }
  claimReserve(arg) { return this.core.claimReserve(arg || {}); }
  claimFinish(arg) { return this.core.claimFinish(arg || {}); }
  claimRelease(arg) { return this.core.claimRelease(arg || {}); }
  info(arg) { return this.core.info(arg || {}); }
}
