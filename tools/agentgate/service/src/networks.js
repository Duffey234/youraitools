// Shared x402 network list for all YourAITools Workers (one canonical copy,
// copied verbatim into each Worker's src/, like the stats-fix templates; keep the copies identical).
// One toggle per network (`enabled`). The ENABLED_NETWORKS env var (comma list of CAIP-2 ids) overrides the toggles.
// Base mainnet is ALWAYS first and its accepts entry is passed through untouched, so Base buyers see exactly the
// same requirements and settle exactly as before. Extra networks are only added when the Worker's primary network is
// Base mainnet and createApp() got `enabledNetworks` (worker.js passes it; tests/local default to Base only).
// All networks settle through the same facilitator client (CDP supports every network here; checked with a $0
// unfunded /verify on 2026-10-22; Solana also by a SELF settlement). x402 v1 (X-PAYMENT, PayAI) stays Base-only.
import { convertToTokenAmount, parseMoney } from '@x402/core/utils';

export const BASE_MAINNET = 'eip155:8453';
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const EVM_PAYTO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';

export const NETWORKS = [
  { id: BASE_MAINNET, name: 'Base', kind: 'evm', enabled: true, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' } },
  { id: 'eip155:137', name: 'Polygon', kind: 'evm', enabled: true, asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', extra: { name: 'USD Coin', version: '2' } },
  { id: 'eip155:42161', name: 'Arbitrum One', kind: 'evm', enabled: true, asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', extra: { name: 'USD Coin', version: '2' } },
  // Solana mainnet USDC (ON since 2026-10-22: CDP verify passed + SELF settle 3jvXwsEm…). payTo = SOLANA_PAY_TO env
  // (payout wallet FH73…2Jte, USDC token account CM3JgZ…bxpAT); dropped automatically when SOLANA_PAY_TO is unset.
  // feePayer = CDP facilitator's Solana fee payer from its authenticated /supported (exact, v2), checked 2026-10-22;
  // a live /supported answer overrides it whenever the Worker fetches supported kinds.
  { id: SOLANA_MAINNET, name: 'Solana', kind: 'svm', enabled: true, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', feePayer: 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb' },
];
export const DEFAULT_ENABLED = NETWORKS.filter((n) => n.enabled).map((n) => n.id).join(',');
export const byId = (id) => NETWORKS.find((n) => n.id === id);

/** Resolve the active network list (in NETWORKS order, Base first). Networks that can't be used (Solana without a payTo) are dropped. */
export function activeNetworks(cfg = {}) {
  const primary = cfg.network || BASE_MAINNET;
  if (primary !== BASE_MAINNET || cfg.enabledNetworks === undefined || cfg.enabledNetworks === null) return [byId(primary) || { id: primary, kind: 'evm' }];
  const want = new Set(String(cfg.enabledNetworks).split(',').map((s) => s.trim()).filter(Boolean));
  want.add(BASE_MAINNET);
  return NETWORKS.filter((n) => want.has(n.id) && (n.kind !== 'svm' || cfg.solanaPayTo));
}

/** One accepts entry for an extra network, mirroring the primary entry (same price string, timeout and scheme). */
function extraAccept(primary, n, cfg) {
  const { network, payTo, price, ...rest } = primary;
  if (n.kind === 'svm') return { ...rest, network: n.id, payTo: cfg.solanaPayTo, price };
  return { ...rest, network: n.id, payTo, price };
}

/** Expand every route's accepts with the extra enabled networks. The primary (Base) entry is kept as the same object, first. */
export function multiNetworkRoutes(routes, cfg = {}) {
  const nets = activeNetworks(cfg).filter((n) => n.id !== (cfg.network || BASE_MAINNET));
  if (!nets.length) return routes;
  const out = {};
  for (const [k, r] of Object.entries(routes)) {
    const acc = Array.isArray(r.accepts) ? r.accepts : [r.accepts];
    const primary = acc[0];
    if (!primary || primary.network !== BASE_MAINNET) { out[k] = r; continue; }
    out[k] = { ...r, accepts: [...acc, ...nets.map((n) => extraAccept(primary, n, cfg))] };
  }
  return out;
}

/** Static supported kinds for the facilitator client (no I/O on Workers): one exact v2 kind per active network. */
export function supportedKinds(cfg = {}) {
  return activeNetworks(cfg).map((n) => ({ x402Version: 2, scheme: 'exact', network: n.id, ...(n.kind === 'svm' ? { extra: { feePayer: n.feePayer } } : {}) }));
}

/** Register server schemes for the extra networks on an x402ResourceServer (Base is registered by the caller as before). */
export function registerNetworks(resourceServer, cfg, EvmScheme) {
  for (const n of activeNetworks(cfg)) {
    if (n.id === (cfg.network || BASE_MAINNET)) continue;
    resourceServer.register(n.id, n.kind === 'svm' ? new ExactSvmServerScheme() : new EvmScheme());
  }
  return resourceServer;
}

/** Public network list for discovery docs and landing JSON. */
export function networkInfo(cfg = {}) {
  return activeNetworks(cfg).map((n) => ({ network: n.id, name: n.name, asset: n.asset, symbol: 'USDC', payTo: n.kind === 'svm' ? cfg.solanaPayTo : (cfg.payTo || EVM_PAYTO) }));
}

/** Hono middleware: add the network list to JSON discovery docs (/, /openapi.json, /.well-known/x402). Never breaks a response. */
export function discoveryNetworks(cfg = {}) {
  const paths = new Set(['/', '/openapi.json', '/.well-known/x402']);
  return async (c, next) => {
    await next();
    try {
      const nets = networkInfo(cfg);
      if (nets.length < 2 || !paths.has(c.req.path) || c.res.status !== 200 || !/application\/json/.test(c.res.headers.get('content-type') || '')) return;
      const doc = await c.res.clone().json();
      const label = nets.map((n) => `${n.name} (${n.network})`).join(', ');
      if (c.req.path === '/openapi.json') {
        const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (k === 'x-x402' && v && typeof v === 'object' && !Array.isArray(v)) v.networks = nets; else walk(v); } };
        walk(doc.paths);
        doc['x-x402-networks'] = nets;
      } else {
        doc.networks = nets;
        if (typeof doc.instructions === 'string') doc.instructions = doc.instructions.replace(/USDC on Base \(eip155:8453\)/g, `USDC on ${label}`);
      }
      const headers = new Headers(c.res.headers); headers.delete('content-length');
      c.res = undefined;
      c.res = new Response(JSON.stringify(doc), { status: 200, headers });
    } catch { /* keep the original response */ }
  };
}

/** Hono middleware: count settled payments per network (paid_net:<CAIP-2>) in the fail-open StatsCounter batch. */
export function networkStats(stats, { isSmoke = () => false, waitUntilOf = () => undefined } = {}) {
  return async (c, next) => {
    await next();
    try {
      if (isSmoke(c) || c.res.status !== 200) return;
      const h = c.res.headers.get('PAYMENT-RESPONSE'); if (!h) return;
      const net = JSON.parse(decodeURIComponent(escape(atob(h)))).network;
      if (net) stats.hit(`paid_net:${net}`, waitUntilOf(c));
    } catch { /* fail-open */ }
  };
}

// Server side of the SVM "exact" scheme for x402 v2, vendored from @x402/svm 2.28.0 ExactSvmScheme (server; no rpcUrl,
// so no blockhash prefetch) so Workers don't need the Solana SDK just to state the terms. Verification and settlement
// (signature, amount, recipient, fee payer) are done by the CDP facilitator.
export class ExactSvmServerScheme {
  constructor() {
    this.scheme = 'exact';
    this.defaultAssetTransferMethod = 'default';
    this.paymentFlows = { default: { supported: ['authorization', 'upfront'], default: 'authorization' } };
    this.dynamicExtraFields = ['recentBlockhash', 'lastValidBlockHeight'];
  }
  getAssetDecimals(asset, network) { return network === SOLANA_MAINNET && asset === byId(SOLANA_MAINNET).asset ? 6 : undefined; }
  async parsePrice(price, network) {
    if (typeof price === 'object' && price !== null && 'amount' in price) {
      if (!price.asset) throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }
    const n = byId(network);
    if (!n || n.kind !== 'svm') throw new Error(`No default USDC for ${network}`);
    const { amount } = parseMoney(price);
    return { amount: convertToTokenAmount(amount, 6), asset: n.asset, extra: {} };
  }
  async enhancePaymentRequirements(paymentRequirements, supportedKind) {
    return { ...paymentRequirements, extra: { ...paymentRequirements.extra, feePayer: supportedKind.extra?.feePayer } };
  }
}
