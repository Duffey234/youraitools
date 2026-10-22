// AgentGate paid API (x402 v2, official @x402/* packages).
//   GET /                      free   service info
//   GET /health                free
//   GET /lax-offer.json        free   LAX registry offer for this agent
//   GET /v1/check-agent?id=&network=   PAID $0.005 USDC on Base: Concordium Agent Registry verdict
import { prefersHtml, landingHtml } from './landing.js';
import { ResilientFacilitatorClient } from './facilitator.js';
import { selectFacilitator } from './facilitator-select.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { x402ResourceServer } from '@x402/hono';
import { paymentMiddleware } from './credits-gate.js'; // @x402/hono paymentMiddleware + prepaid credits keys (no key: unchanged x402)
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { multiNetworkRoutes, registerNetworks, supportedKinds, discoveryNetworks, networkStats } from './networks.js';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { ROUTE_META } from './service-meta.js';
import { ConcordiumPublicProvider, CachedProvider, classifyId, NETWORKS } from '../../src/registry.js';
import { DEFAULTS, USDC } from './config.js';
import { x402v1 } from './x402v1.js';
import { laxOffer } from './offer.js';
import { Stats, paidRouteStats, isSmoke, waitUntilOf } from './stats.js';
import { registerFreeRoutes, PREVIEW_PATH, MCP_PATH, STATS_PATH } from './free.js';
import { withDeadline, DeadlineError, BUDGET } from './deadline.js';
import { openapiDoc, wellKnownX402, FAVICON_ICO, FAVICON_SVG } from './discovery.js';

export const PAID_PATH = '/v1/check-agent';

export const OUTPUT_EXAMPLE = {
  id: 'Mf22soLh1NuZYFgBK8iSs', kind: 'badge', network: 'mainnet', found: true, active: true, cardHashMatches: true, verified: true,
  tokenAddress: 'Mf22soLh1NuZYFgBK8iSs', tokenId: 484, owner: '4DDvjwdcLmTy1Ar9FCKKPMiABrS261TvyXJGr4n4ypuuogXeFF',
  agentWallet: null, agentUri: 'https://tippingservice.co.uk/agents/vigilonmoltbook/.well-known/agent-card.json',
  source: 'concordium-badge-check', mock: false, issues: [],
};

export function routesConfig({ price, network, payTo, publicUrl }) {
  return {
    [`GET ${PAID_PATH}`]: {
      // A stable resource URL (no query string) so the Bazaar catalogs one entry, not one per agent id.
      ...(publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${PAID_PATH}` } : {}),
      accepts: { scheme: 'exact', price, network, payTo, maxTimeoutSeconds: 120 },
      description: 'Checks whether an AI agent is registered in the Concordium Agent Registry (CIS-8004), Active, and Verified by Concordium (Agent Card hash matches on-chain). Suited to agent marketplaces and payment flows that need to confirm a counterparty agent identity before trusting or paying it. Input: badge (CIS-2 token address) or Concordium account.',
      mimeType: 'application/json',
      ...ROUTE_META,
      extensions: {
        ...declareDiscoveryExtension({
          input: { id: 'Mf22soLh1NuZYFgBK8iSs', network: 'mainnet' },
          inputSchema: {
            properties: {
              id: { type: 'string', description: 'Badge (CIS-2 token address, short or CAIP-19 form) or Concordium account address' },
              network: { type: 'string', enum: NETWORKS, description: 'Concordium network, default mainnet' },
            },
            required: ['id'],
          },
          output: { example: OUTPUT_EXAMPLE },
        }),
      },
    },
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.payTo] @param {string} [opts.price] @param {string} [opts.network]
 * @param {string} [opts.facilitatorUrl]
 * @param {import('@x402/core/server').FacilitatorClient} [opts.facilitatorClient] inject for tests
 * @param {{check:Function}} [opts.provider] registry provider (default: cached real Concordium provider)
 * @param {string} [opts.publicUrl] public base URL, used in the LAX offer
 * @param {boolean} [opts.syncFacilitatorOnStart]
 * @param {any} [opts.statsKv] KV binding for usage counters (optional)
 * @param {{limit:Function}} [opts.freeLimiter] Workers rate-limit binding for the free tier (optional)
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const baseProvider = opts.provider || new CachedProvider(new ConcordiumPublicProvider(), { ttlMs: 60000 });
  // One hard deadline per registry lookup (covers sequential MCP calls and slow response bodies).
  const provider = { name: baseProvider.name, check: (id, o) => withDeadline(baseProvider.check(id, o), opts.workMs ?? BUDGET.workMs, 'registry lookup') };
  const fac = selectFacilitator(cfg, opts.cdpDeps); // FACILITATOR=payai|cdp; cdp without keys falls back to PayAI
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(cfg.network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme); // extra networks from networks.js (Base registered above, unchanged)

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg)); // list enabled networks in /, /openapi.json, /.well-known/x402
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf })); // paid_net:<network> counters (fail-open)
  // Browser-based x402 clients need CORS and must be able to read the payment headers.
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const rootInfo = {
    name: 'AgentGate',
    description: 'Paid x402 API: is this AI agent registered, Active and Verified by Concordium?',
    paid: { method: 'GET', path: PAID_PATH, price: cfg.price, network: cfg.network, asset: 'USDC', payTo: cfg.payTo, facilitator: fac.url },
    // Existing entries first; new free routes are appended (backward compatible).
    free: ['/health', '/lax-offer.json', PREVIEW_PATH, MCP_PATH, STATS_PATH, '/openapi.json', '/.well-known/x402'],
    freeTier: {
      preview: { method: 'GET', path: PREVIEW_PATH, limit: '20 requests/min per IP', returns: 'verdict only: verified, found, active, cardHashMatches, issues' },
      mcp: { method: 'POST', path: MCP_PATH, transport: 'streamable-http', tools: ['check_agent'], limit: '20 tool calls/min per IP' },
      stats: { method: 'GET', path: STATS_PATH, returns: 'public usage counters, last 30 days' },
    },
    mcpRegistry: 'io.github.agentgate-builder/agentgate',
    source: 'https://agentgate-source.pages.dev/agentgate/',
    checker: 'https://agentgate-source.pages.dev/agentgate/demo/',
    guide: 'https://youraitools.co/guides/x402-agent-verification',
    npm: 'https://www.npmjs.com/package/concordium-agentgate',
    allTools: 'https://youraitools.co/built-by-us',
  };
  app.get('/', (c) => {
    if (prefersHtml(c.req.header('accept'))) {
      c.header('Vary', 'Accept');
      return c.html(landingHtml({ origin: cfg.publicUrl || new URL(c.req.url).origin, info: rootInfo }));
    }
    c.header('Vary', 'Accept');
    return c.json(rootInfo);
  });
  app.get('/health', (c) => c.json({ ok: true }));
  // Discovery: OpenAPI (x402scan, agents), /.well-known/x402 manifest, favicon. All static, no I/O.
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const disc = (c) => ({ origin: origin(c), price: cfg.price, network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  app.get('/favicon.ico', (c) => c.body(FAVICON_ICO, 200, { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=86400' }));
  app.get('/favicon.svg', (c) => c.body(FAVICON_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get('/lax-offer.json', (c) => c.json(laxOffer({ baseUrl: cfg.publicUrl || new URL(c.req.url).origin, price: cfg.price })));

  // Free tier (preview, remote MCP, stats) is registered before the paywall so x402 never sees it.
  const stats = opts.stats || new Stats(opts.statsKv);
  registerFreeRoutes(app, { provider, stats, limiter: opts.freeLimiter, paidPath: PAID_PATH, publicUrl: cfg.publicUrl });
  app.use(PAID_PATH, paidRouteStats(stats));

  // x402 v1 compatibility (v1 body terms + X-PAYMENT verify/settle via the same facilitator), see x402v1.js.
  const routeCfg = routesConfig(cfg)[`GET ${PAID_PATH}`];
  const v1 = x402v1({
    path: PAID_PATH, amount: String(Math.round(Number(String(cfg.price).replace('$', '')) * 1e6)), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network,
    description: routeCfg.description, mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
    outputSchema: {
      input: { type: 'http', method: 'GET', discoverable: true, queryParams: {
        id: { type: 'string', required: true, description: 'Badge (CIS-2 token address, short or CAIP-19 form) or Concordium account address' },
        network: { type: 'string', required: false, enum: NETWORKS, description: 'Concordium network, default mainnet' },
      } },
      output: OUTPUT_EXAMPLE,
    },
  });
  app.use(v1.middleware);
  app.use(v1.skipIfV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));

  app.get(PAID_PATH, async (c) => {
    const id = c.req.query('id');
    const network = c.req.query('network') || 'mainnet';
    // Returning >= 400 makes @x402/hono skip settlement, so bad input is never charged.
    if (!id || classifyId(id).kind === 'invalid') return c.json({ error: 'invalid_id', message: 'id must be a CIS-8004 badge (CIS-2 token address) or a Concordium account address' }, 400);
    if (!NETWORKS.includes(network)) return c.json({ error: 'invalid_network', message: `network must be one of ${NETWORKS.join(', ')}` }, 400);
    try {
      return c.json(await provider.check(id, { network }));
    } catch (e) {
      if (e instanceof DeadlineError) return c.json({ error: 'registry_timeout', message: `${e.message}; not charged, please retry` }, 504);
      return c.json({ error: 'registry_unavailable', message: String(e.message || e) }, 502);
    }
  });

  return app;
}
