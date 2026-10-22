// Tiny HTTP client for the hosted AgentGate API (no dependencies).
//   preview(id)  -> free tier, rate limited, the verdict only (no wallet needed)
//   check(id)    -> paid x402 route ($0.005 USDC on Base), full record. Pass an x402-wrapped fetch
//                   (e.g. wrapFetchWithPaymentFromConfig from @x402/fetch) as `paidFetch`.
export const DEFAULT_API = 'https://agentgate.agentgate.workers.dev';

export function createAgentGateClient({ baseUrl = DEFAULT_API, fetch: f, paidFetch } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const plain = (url, init) => (f ? f(url, init) : globalThis.fetch(url, init));
  const qs = (id, network) => `id=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
  async function call(doFetch, url) {
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 402) throw Object.assign(new Error('payment required: pass an x402-wrapped fetch as paidFetch'), { status: 402, body });
    if (!res.ok) throw Object.assign(new Error(body.message || `AgentGate HTTP ${res.status}`), { status: res.status, body });
    return body;
  }
  return {
    /** Free verdict: { verified, found, active, cardHashMatches, issues, ... } */
    preview: (id, { network = 'mainnet' } = {}) => call(plain, `${base}/v1/check-agent/preview?${qs(id, network)}`),
    /** Paid full record (owner, agentWallet, agentUri, tokenId, source, ...). Requires paidFetch. */
    check: (id, { network = 'mainnet' } = {}) => call(paidFetch || plain, `${base}/v1/check-agent?${qs(id, network)}`),
    /** Uses the paid route when paidFetch is configured, otherwise the free preview. */
    verify: (id, opts) => (paidFetch ? call(paidFetch, `${base}/v1/check-agent?${qs(id, opts?.network || 'mainnet')}`) : call(plain, `${base}/v1/check-agent/preview?${qs(id, opts?.network || 'mainnet')}`)),
  };
}
