// Optional paid tier for the stdio MCP server: full TokenVerdict reports (quick tier) from the hosted API, paid per call over x402
// with the user's own wallet. Only active when TOKENVERDICT_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) is set.
// Needs the optional peer dependencies @x402/fetch, @x402/evm and viem (loaded lazily; the free path never imports them).
// Spend guard: Base USDC only, at most $0.02 per payment, and only to the TokenVerdict pay-to address.
import { API_BASE } from './lite.js';

export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';
export const MAX_PER_PAYMENT = '$0.02';
export const KEY_ENVS = ['TOKENVERDICT_X402_PRIVATE_KEY', 'X402_PRIVATE_KEY'];
export const INSTALL_HINT = 'Paid mode needs @x402/fetch, @x402/evm and viem next to this package, e.g. command "npx" with args ["-y", "-p", "@agentgate-builder/tokenverdict", "-p", "@x402/fetch", "-p", "@x402/evm", "-p", "viem", "tokenverdict"].';

export function keyFromEnv(env = process.env) {
  for (const k of KEY_ENVS) { const v = (env[k] || '').trim(); if (v) return { name: k, value: v }; }
  return null;
}

/** Returns a paying client, null (no key) or { error } (never throws, never echoes the key). */
export async function createPaidClient({ env = process.env, fetchImpl = globalThis.fetch, apiBase = (env.TOKENVERDICT_API_URL || API_BASE).replace(/\/+$/, ''), payTo = PAY_TO } = {}) {
  const key = keyFromEnv(env);
  if (!key) return null;
  const hex = key.value.startsWith('0x') ? key.value : `0x${key.value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return { error: `${key.name} is set but is not a 32-byte hex private key; using the free preview.` };
  let wrap, ExactEvmScheme, privateKeyToAccount;
  try {
    ({ wrapFetchWithPaymentFromConfig: wrap } = await import('@x402/fetch'));
    ({ ExactEvmScheme } = await import('@x402/evm'));
    ({ privateKeyToAccount } = await import('viem/accounts'));
  } catch {
    return { error: `${key.name} is set, but ${INSTALL_HINT} Using the free preview.` };
  }
  let account;
  try { account = privateKeyToAccount(hex); } catch { return { error: `${key.name} could not be loaded as an EVM private key; using the free preview.` }; }
  const onlyUs = (_v, reqs) => reqs.filter((r) => r.network === NETWORK && String(r.payTo).toLowerCase() === payTo.toLowerCase());
  const pay = wrap(fetchImpl, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }], policies: [onlyUs], spendControls: { maxAmountPerPayment: MAX_PER_PAYMENT } });
  return {
    payer: account.address, apiBase,
    check: async (token, tier = 'quick') => {
      const res = await pay(`${apiBase}/v1/${tier}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ token }) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok) return { error: `paid API answered HTTP ${res.status}`, detail: json?.message || json?.error || text.slice(0, 300) };
      return { result: json, paymentResponse: res.headers.get('payment-response') || res.headers.get('x-payment-response') || null };
    },
  };
}
