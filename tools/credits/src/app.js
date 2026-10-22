// YourAITools Credits: prepaid credit packs for the YourAITools x402 tools. One x402 payment buys a pack and mints an
// API key with a USDC-denominated balance; the key is then accepted by every tool's paid routes
// (Authorization: Bearer <key>) instead of paying each call on-chain.
//   GET|POST /v1/pack/sample   PAID $0.005  new key with $0.005 of credits (tries the whole flow)
//   GET|POST /v1/pack/1        PAID $1      new key with $1.00 of credits
//   GET|POST /v1/pack/5        PAID $5      new key with $5.50 of credits (10% bonus)
//   GET|POST /v1/topup/1|5     PAID $1/$5   add $1.00 / $5.50 to an existing key (send the key)
//   GET  /v1/balance           free  balance and recent usage (send the key)
//   POST /v1/key/rotate        free  move the balance to a new key; the old key stops working
//   POST /v1/claim             free  key for a pack paid by a plain USDC transfer from the landing page (see claim.js)
//   GET  /v1/prices  /v1/preview?pack=  free  what a pack buys at today's prices
//   POST /mcp  GET / /health /openapi.json /.well-known/x402 /v1/stats   free
// Credits are prepaid usage of these APIs only: not money, not a token, not transferable except by sharing the key.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension, bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { multiNetworkRoutes, registerNetworks, supportedKinds, discoveryNetworks, networkStats, networkInfo } from './networks.js';
import { ROUTE_META } from './service-meta.js';
import { ResilientFacilitatorClient } from './facilitator.js';
import { selectFacilitator } from './facilitator-select.js';
import { DEFAULTS } from './config.js';
import { Stats, paidRouteStats, isSmoke, waitUntilOf } from './stats.js';
import { x402v1 } from './x402v1.js';
import { PACKS, TOPUPS, quote, usd, TOOL_ROUTES, API_BASE } from './packs.js';
import { KEY_RE, newKey, accountFor, keyFromReq } from './ledger.js';
import { openapiDoc, wellKnownX402, LOGO_SVG, TERMS } from './discovery.js';
import { prefersHtml, landingHtml } from './landing.js';
import { CHAINS, chainOf, verifyDirectTransfer, validTxHash, validSecret } from './claim.js';

export const VERSION = '0.2.0';
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-credits/';
const USDC = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const PAID = [
  { path: '/v1/pack/sample', kind: 'pack', pack: PACKS.sample },
  { path: '/v1/pack/1', kind: 'pack', pack: PACKS[1] },
  { path: '/v1/pack/5', kind: 'pack', pack: PACKS[5] },
  { path: '/v1/topup/1', kind: 'topup', pack: TOPUPS[1] },
  { path: '/v1/topup/5', kind: 'topup', pack: TOPUPS[5] },
];
export const describe = (r) => r.kind === 'pack'
  ? `Prepaid credits for the YourAITools agent APIs: one x402 payment of ${r.pack.price} USDC mints an API key holding $${usd(r.pack.credit)} of credits${r.pack.bonus ? ` ($${usd(r.pack.bonus)} bonus)` : ''}. Send it as Authorization: Bearer <key> to PayGuard, TokenVerdict, SignCheck, WebRead, InjectScan, DomainCheck, PkgGuard, StackDetect or AgentGate paid routes; each call debits its normal price instead of an on-chain payment. Key shown once. Prepaid API usage only, not refundable.`
  : `Top up an existing YourAITools credits key: one x402 payment of ${r.pack.price} USDC adds $${usd(r.pack.credit)} of credits${r.pack.bonus ? ` ($${usd(r.pack.bonus)} bonus)` : ''}. Send the key as Authorization: Bearer <key>. Prepaid API usage only, not refundable.`;
const EXAMPLE_KEY = 'yatc_EXAMPLEexampleEXAMPLEexampleEXAMPLEexampl';
export const packExample = (p) => ({ api_key: EXAMPLE_KEY, shown_once: true, pack: p.id, paid_usd: usd(p.paid), credited_usd: usd(p.credit), balance_usd: usd(p.credit), use: { header: `Authorization: Bearer ${EXAMPLE_KEY}`, example: `${API_BASE}/payguard/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96` } });

export function routesConfig({ network, payTo, publicUrl }) {
  const out = {};
  for (const r of PAID) {
    const base = { ...(publicUrl ? { resource: `${publicUrl.replace(/\/$/, '')}${r.path}` } : {}), accepts: { scheme: 'exact', price: r.pack.price, network, payTo, maxTimeoutSeconds: 120 }, description: describe(r), mimeType: 'application/json', ...ROUTE_META };
    const ex = r.kind === 'pack' ? packExample(r.pack) : { topped_up: true, pack: r.pack.id, credited_usd: usd(r.pack.credit), balance_usd: usd(r.pack.credit + 250000) };
    out[`GET ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ input: {}, output: { example: ex } }) } };
    out[`POST ${r.path}`] = { ...base, extensions: { ...declareDiscoveryExtension({ bodyType: 'json', input: {}, output: { example: ex } }) } };
  }
  return out;
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}
const bad = (c, message, status = 400, error = 'bad_request') => c.json({ error, message }, status, { 'cache-control': 'no-store' });
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
export function paymentOf(res) {
  const h = res?.headers?.get('PAYMENT-RESPONSE') || res?.headers?.get('X-PAYMENT-RESPONSE');
  if (!h) return null;
  try { const p = unb64(h); return p && p.success !== false ? { network: p.network || null, transaction: p.transaction || null, payer: p.payer || null } : null; } catch { return null; }
}
const retry = async (fn, n = 3) => { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; } } throw e; };

/**
 * @param {object} [opts] payTo, network, facilitatorUrl, publicUrl, facilitatorClient (tests), accounts (DO namespace;
 *   default c.env.ACCOUNTS), stats, freeLimiter, v1FetchImpl, staticSupported, syncFacilitatorOnStart, cdpDeps
 */
export function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const stats = opts.stats || new Stats(undefined);
  const fac = selectFacilitator(cfg, opts.cdpDeps);
  const facilitatorClient = opts.facilitatorClient || new ResilientFacilitatorClient({ url: fac.url, createAuthHeaders: fac.createAuthHeaders, name: fac.name, network: cfg.network, kinds: supportedKinds(cfg), staticSupported: opts.staticSupported ?? true });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(cfg.network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  registerNetworks(resourceServer, cfg, ExactEvmScheme);
  const origin = (c) => (cfg.publicUrl || new URL(c.req.url).origin).replace(/\/$/, '');
  const count = (c, ev) => { if (!isSmoke(c)) stats.hit(ev, waitUntilOf(c)); };
  const ns = (c) => opts.accounts || c.env?.ACCOUNTS;
  const later = (c, p) => { const w = waitUntilOf(c); if (w) w(p.catch(() => {})); else p.catch(() => {}); };

  const app = new Hono();
  app.use('*', discoveryNetworks(cfg));
  app.use('*', networkStats({ hit: (e, w) => stats.hit(e, w) }, { isSmoke, waitUntilOf }));
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Credits-Key', 'X-Credit-Token', 'PAYMENT-SIGNATURE', 'X-PAYMENT', 'Mcp-Protocol-Version'], exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'], maxAge: 86400 }));

  const info = (c) => ({
    name: 'YourAITools Credits',
    description: 'Prepaid credits for the YourAITools x402 agent APIs. Pay once over x402 ($1 or $5 USDC), get an API key, then call any of the tools with Authorization: Bearer <key>; each call debits its normal per-call price. No per-call on-chain payment, no signup.',
    packs: PAID.filter((r) => r.kind === 'pack').map((r) => ({ methods: ['GET', 'POST'], path: r.path, url: `${origin(c)}${r.path}`, price: r.pack.price, credit_usd: usd(r.pack.credit), bonus_usd: usd(r.pack.bonus), what: r.pack.label })),
    topups: PAID.filter((r) => r.kind === 'topup').map((r) => ({ methods: ['GET', 'POST'], path: r.path, url: `${origin(c)}${r.path}`, price: r.pack.price, credit_usd: usd(r.pack.credit), needs: 'Authorization: Bearer <key>' })),
    payment: { protocol: 'x402 v2 (PAYMENT-SIGNATURE) on all networks, v1 (X-PAYMENT) on Base', asset: 'USDC', networks: networkInfo(cfg).length ? networkInfo(cfg) : [{ network: cfg.network, payTo: cfg.payTo }] },
    use: { header: 'Authorization: Bearer <key>', alternatives: ['X-Credits-Key: <key>', 'X-Credit-Token: <key>'], responseHeaders: ['X-Credits-Charged', 'X-Credits-Remaining', 'X-Credits-Ref'], whenEmpty: 'the tool answers with its normal x402 402 (unchanged terms) plus X-Credits-Error: insufficient_balance and a top-up link', accepted_by: [...new Set(TOOL_ROUTES.map((r) => `${API_BASE}/${r.tool}/`))] },
    free: ['/v1/balance', '/v1/key/rotate', '/v1/claim', '/v1/prices', '/v1/preview?pack=1', '/mcp', '/health', '/openapi.json', '/.well-known/x402', '/v1/stats'],
    terms: TERMS,
    source: SOURCE_URL, allTools: 'https://youraitools.co/built-by-us', endpoint: origin(c), version: VERSION,
  });
  app.get('/', (c) => { c.header('Vary', 'Accept'); if (prefersHtml(c.req.header('accept'))) return c.html(landingHtml({ origin: origin(c), info: info(c) })); return c.json(info(c)); });
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, accounts: !!ns(c) }));
  const disc = (c) => ({ origin: origin(c), network: cfg.network, payTo: cfg.payTo, asset: USDC[cfg.network] });
  app.get('/openapi.json', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(openapiDoc(disc(c))); });
  app.get('/.well-known/x402', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json(wellKnownX402(disc(c))); });
  for (const p of ['/favicon.svg', '/favicon.ico', '/logo.svg']) app.get(p, (c) => c.body(LOGO_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));
  app.get('/v1/stats', async (c) => { c.header('Cache-Control', 'public, max-age=60'); return c.json(await stats.summary(30)); });
  const prices = (c) => { c.header('Cache-Control', 'public, max-age=300'); const pack = c.req.query('pack'); return c.json(pack ? quote(PACKS[pack] ? pack : '1') : { packs: Object.keys(PACKS).map((k) => quote(k)), terms: TERMS }); };
  app.get('/v1/prices', prices);
  app.get('/v1/preview', (c) => { count(c, 'free_preview'); c.header('Cache-Control', 'public, max-age=300'); return c.json({ ...quote(PACKS[c.req.query('pack')] ? c.req.query('pack') : '1'), buy: `${origin(c)}/v1/pack/${PACKS[c.req.query('pack')] && c.req.query('pack') !== 'sample' ? c.req.query('pack') : '1'}` }); });

  // ---- key-authenticated free routes ----
  async function account(c) {
    const key = keyFromReq(c.req);
    if (!key) return { error: bad(c, 'Send your credits key: Authorization: Bearer <key> (or X-Credits-Key).', 401, 'missing_key') };
    if (!KEY_RE.test(key)) return { error: bad(c, 'That is not a credits key (format yatc_ + 43 characters).', 401, 'invalid_key') };
    const n = ns(c); if (!n) return { error: bad(c, 'Credits storage unavailable, retry shortly.', 503, 'unavailable') };
    return { key, stub: await accountFor(n, key) };
  }
  app.get('/v1/balance', async (c) => {
    if (await limited(opts.freeLimiter, c)) { c.header('Retry-After', '60'); return bad(c, 'Rate limited (per IP per minute).', 429, 'rate_limited'); }
    const a = await account(c); if (a.error) return a.error;
    const r = await a.stub.info();
    if (!r.ok) return bad(c, 'Unknown credits key.', 404, 'invalid_key');
    count(c, 'balance');
    return c.json({ status: r.status, balance_usd: usd(r.balance), balance_atomic: String(r.balance), credited_usd: usd(r.credited), spent_usd: usd(r.spent), calls: r.calls, refunded_calls: r.refunds, created: new Date(r.created).toISOString(), last_used: r.last_used ? new Date(r.last_used).toISOString() : null,
      by_tool: Object.fromEntries(Object.entries(r.by_tool || {}).map(([k, v]) => [k, { calls: v.calls, spent_usd: usd(v.spent) }])),
      recent: r.recent.map((x) => ({ ref: x.ref, tool: x.tool, route: x.route, charged_usd: x.refunded ? '0' : usd(x.amount), refunded: !!x.refunded, at: new Date(x.t).toISOString() })),
      payments: r.payments.map((p) => ({ ...p, paid_usd: usd(p.paid), credited_usd: usd(p.credited), t: undefined, at: new Date(p.t).toISOString(), paid: undefined, credited: undefined })),
      topup: { one: `${origin(c)}/v1/topup/1`, five: `${origin(c)}/v1/topup/5` } }, 200, { 'cache-control': 'no-store' });
  });
  app.post('/v1/key/rotate', async (c) => {
    if (await limited(opts.freeLimiter, c)) { c.header('Retry-After', '60'); return bad(c, 'Rate limited (per IP per minute).', 429, 'rate_limited'); }
    const a = await account(c); if (a.error) return a.error;
    const fresh = newKey(); const target = await accountFor(ns(c), fresh);
    const d = await a.stub.drain({ to: 'rotated' });
    if (!d.ok) return bad(c, d.reason === 'topup_pending' ? 'A top-up is still settling; retry in a minute.' : 'Unknown or inactive credits key.', d.reason === 'topup_pending' ? 409 : 404, d.reason);
    let r;
    try { r = await target.adopt({ moved: d.moved }); } catch (e) { r = { ok: false }; }
    if (!r.ok) { await a.stub.undrain({ moved: d.moved }); return bad(c, 'Rotation failed; your old key still works. Retry.', 503, 'unavailable'); }
    count(c, 'key_rotated');
    return c.json({ api_key: fresh, shown_once: true, balance_usd: usd(r.balance), old_key: 'deactivated' }, 200, { 'cache-control': 'no-store' });
  });

  // ---- direct USDC transfer (humans; no signature prompt): claim the key for a confirmed transfer ----
  const CLAIM_PACKS = [PACKS[1], PACKS[5], PACKS.sample];
  app.get('/v1/claim', (c) => c.json({ error: 'method_not_allowed', message: 'POST {"chain":"base|polygon|arbitrum","txHash":"0x...","secret":"0x..."} after sending USDC from the credits page.', chains: Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [k, { network: v.id, usdc: v.usdc, confirmations: v.confirmations }])), payTo: cfg.payTo }, 405, { Allow: 'POST' }));
  app.post('/v1/claim', async (c) => {
    if (await limited(opts.freeLimiter, c)) { c.header('Retry-After', '60'); return bad(c, 'Rate limited (per IP per minute).', 429, 'rate_limited'); }
    let b; try { b = await c.req.json(); } catch { return bad(c, 'Send JSON: {"chain","txHash","secret"}.'); }
    const ch = chainOf(b?.chain); if (!ch) return bad(c, 'chain must be base, polygon or arbitrum.');
    const txHash = String(b.txHash || '').toLowerCase(); const secret = String(b.secret || '').toLowerCase();
    if (!validTxHash(txHash)) return bad(c, 'txHash must be 0x + 64 hex characters.');
    if (!validSecret(secret)) return bad(c, 'secret (the claim code the page created) must be 0x + 64 hex characters.');
    const n = ns(c); if (!n) return bad(c, 'Credits storage unavailable; retry shortly (your payment is safe, claim again later).', 503, 'unavailable');
    const [chainKey, chain] = ch;
    let v;
    try { v = await verifyDirectTransfer({ chainKey, chain, txHash, secret, payee: cfg.payTo, packs: CLAIM_PACKS, fetchImpl: opts.rpcFetch }); }
    catch (e) { return bad(c, 'Could not reach the chain right now; your payment is safe, retry the claim in a minute.', 503, 'rpc_unavailable'); }
    if (!v.ok) {
      if (v.status === 202) { c.header('Retry-After', String(v.retry_after || 5)); return c.json({ status: 'pending', error: v.error, message: v.message, ...(v.confirmations !== undefined ? { confirmations: v.confirmations, needed: v.needed } : {}) }, 202, { 'cache-control': 'no-store' }); }
      count(c, `claim_rejected:${v.error}`);
      return bad(c, v.message, v.status, v.error);
    }
    const claim = n.get(n.idFromName(`claim:${chain.id}:${txHash}`));
    const res = await claim.claimReserve({ sender: v.sender, amount: v.amount, pack: v.pack.id, chain: chain.id, tx: txHash });
    if (!res.ok) { count(c, 'claim_rejected:already_claimed'); return bad(c, 'This transaction was already claimed; a key is only issued once per payment. Lost it? Contact hello@youraitools.co with the tx hash.', 409, 'already_claimed'); }
    const key = newKey(); const stub = await accountFor(n, key);
    let made;
    try { made = await stub.create({ balance: v.pack.credit, plan: v.pack.id, paid: v.pack.paid, payment: { network: chain.id, transaction: txHash, payer: v.sender, method: 'direct_transfer' } }); } catch { made = { ok: false }; }
    if (!made.ok) { await retry(() => claim.claimRelease()); return bad(c, 'Could not create the key; your payment is safe, retry the claim.', 503, 'unavailable'); }
    later(c, retry(() => claim.claimFinish({ account: 'minted' })));
    count(c, [`pack_sold:${v.pack.id}`, `claim:${chainKey}`]);
    return c.json({ api_key: key, shown_once: true, note: 'Store this key now: it is shown only once and cannot be recovered. Anyone with the key can spend its credits; rotate it at POST /v1/key/rotate.', pack: v.pack.id, paid_usd: usd(v.pack.paid), credited_usd: usd(v.pack.credit), bonus_usd: usd(v.pack.bonus), balance_usd: usd(made.balance),
      payment: { method: 'direct_transfer', network: chain.id, transaction: txHash, payer: v.sender, confirmations: v.confirmations, explorer: chain.explorer + txHash },
      use: { header: `Authorization: Bearer ${key}`, alternatives: ['X-Credits-Key', 'X-Credit-Token'], tools: [...new Set(TOOL_ROUTES.map((x) => `${API_BASE}/${x.tool}/`))] },
      balance: `${origin(c)}/v1/balance`, terms: TERMS }, 200, { 'cache-control': 'no-store' });
  });

  // ---- remote MCP ----
  const TOOLS = [
    { name: 'credits_quote', title: 'What a YourAITools credits pack buys', description: 'Lists how many calls of each YourAITools paid API (PayGuard, TokenVerdict, SignCheck, WebRead, InjectScan, DomainCheck, PkgGuard, StackDetect, AgentGate) a $1 or $5 prepaid credits pack covers at today\'s prices, and where to buy it (x402).', inputSchema: { type: 'object', properties: { pack: { type: 'string', enum: ['1', '5', 'sample'], description: 'Pack: "1" ($1), "5" ($5, 10% bonus) or "sample" ($0.005)' } } }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
    { name: 'credits_balance', title: 'Balance of a YourAITools credits key', description: 'Returns the remaining balance, spend and recent calls of a YourAITools credits key (yatc_...).', inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Credits key (yatc_...)' } }, required: ['key'] }, annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true } },
  ];
  app.get('/mcp', (c) => c.json({ error: 'method_not_allowed', message: 'POST JSON-RPC (MCP Streamable HTTP, stateless).' }, 405, { Allow: 'POST' }));
  app.post('/mcp', async (c) => {
    let msg; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const batch = Array.isArray(msg); const replies = [];
    for (const m of batch ? msg : [msg]) { const r = await rpc(m, c); if (r) replies.push(r); }
    if (!replies.length) return c.body(null, 202);
    return c.json(batch ? replies : replies[0]);
  });
  async function rpc(m, c) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const note = m.id === undefined || m.id === null;
    const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
    const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
    switch (m.method) {
      case 'initialize': { const v = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; return ok({ protocolVersion: v.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'credits', title: 'YourAITools Credits', version: VERSION }, instructions: 'Prepaid credits for the YourAITools x402 APIs: buy a pack once over x402, then send the key as Authorization: Bearer <key> to any tool.' }); }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name; const args = m.params?.arguments || {};
        if (await limited(opts.freeLimiter, c)) return err('Free tier rate limit reached. Retry in a minute.');
        if (name === 'credits_quote') {
          const q = quote(PACKS[args.pack] ? String(args.pack) : '1'); count(c, 'free_mcp');
          const text = `${q.pack === 'sample' ? 'Sample' : `$${q.price_usd}`} pack = $${q.credit_usd} of credits${Number(q.bonus_usd) ? ` (incl. $${q.bonus_usd} bonus)` : ''}. Buy: ${origin(c)}/v1/pack/${q.pack} (x402, USDC). Covers e.g. ${q.calls.slice(0, 6).map((x) => `${x.calls} ${x.tool} ${x.route.split(' ')[1]}`).join(', ')}.`;
          return ok({ content: [{ type: 'text', text }], structuredContent: q, isError: false });
        }
        if (name === 'credits_balance') {
          const key = String(args.key || '').trim();
          if (!KEY_RE.test(key)) return err('bad_request: "key" must be a credits key (yatc_...)');
          const n = ns(c); if (!n) return err('Credits storage unavailable, retry shortly.');
          const r = await (await accountFor(n, key)).info();
          if (!r.ok) return err('Unknown credits key.');
          count(c, 'free_mcp');
          const s = { status: r.status, balance_usd: usd(r.balance), spent_usd: usd(r.spent), calls: r.calls };
          return ok({ content: [{ type: 'text', text: `Credits key ${r.status}: balance $${s.balance_usd}, spent $${s.spent_usd} over ${s.calls} calls. Top up: ${origin(c)}/v1/topup/1` }], structuredContent: s, isError: false });
        }
        return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      default: return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  // ---- paid routes ----
  const v1s = [];
  for (const r of PAID) {
    // Outermost: after x402 has settled (or not), finalise the purchase. A key is only revealed in a settled response.
    app.use(r.path, async (c, next) => {
      await next();
      const m = c.get('minted'); const t = c.get('topup');
      if (!m && !t) return;
      const pay = c.res && c.res.status === 200 ? paymentOf(c.res) : null;
      if (m) {
        if (pay) { count(c, [`pack_sold:${r.pack.id}`]); later(c, m.stub.confirm({ kind: 'pack', payment: pay })); }
        else later(c, retry(() => m.stub.cancel()));
      } else if (t) {
        if (pay) {
          try { await retry(() => t.stub.topupCommit({ ref: t.ref, payment: pay })); count(c, [`topup:${r.pack.id}`]); }
          catch (e) { console.error(`credits: topup ${t.ref} settled (${pay.transaction}) but commit failed: ${e && e.message}`); later(c, retry(() => t.stub.topupCommit({ ref: t.ref, payment: pay }), 5)); }
        } else later(c, retry(() => t.stub.topupVoid({ ref: t.ref })));
      }
    });
    app.use(r.path, paidRouteStats(stats, r.kind === 'pack' ? `pack_${r.pack.id}` : `topup_${r.pack.id}`));
    v1s.push(x402v1({ path: r.path, amount: String(r.pack.paid), asset: USDC[cfg.network], payTo: cfg.payTo, network: cfg.network, description: describe(r), mimeType: 'application/json', publicUrl: cfg.publicUrl, facilitatorUrl: cfg.facilitatorUrl, fetchImpl: opts.v1FetchImpl,
      outputSchema: { input: { type: 'http', method: 'POST', discoverable: true, bodyType: 'json', bodyFields: {} }, output: r.kind === 'pack' ? packExample(r.pack) : { topped_up: true } } }));
    // Validate before payment (top-ups): a key that is present must be a live account, else 400 (never charged).
    app.use(r.path, async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'POST') return next();
      if (r.kind !== 'topup') return next();
      const key = keyFromReq(c.req);
      if (!key) return next(); // bare URL: 402 terms; the handler 400s (never settled) if paid without a key
      if (!KEY_RE.test(key)) return bad(c, 'Not a credits key (yatc_ + 43 characters). Buy a new pack at /v1/pack/1 instead.');
      const n = ns(c); if (!n) return bad(c, 'Credits storage unavailable, retry shortly.', 503, 'unavailable');
      const stub = await accountFor(n, key);
      const i = await stub.info();
      if (!i.ok || i.status !== 'active') return bad(c, 'Unknown or inactive credits key; nothing was charged. Buy a new pack at /v1/pack/1.', 400, 'invalid_key');
      c.set('topupStub', stub);
      return next();
    });
  }
  for (const v of v1s) app.use(v.middleware);
  const skipV1 = (mw) => (c, next) => (c.get('x402v1') ? next() : mw(c, next));
  app.use(skipV1(paymentMiddleware(multiNetworkRoutes(routesConfig(cfg), cfg), resourceServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true)));
  for (const r of PAID) {
    app.on(['GET', 'POST'], r.path, async (c) => {
      const n = ns(c); if (!n) return bad(c, 'Credits storage unavailable; not charged. Retry shortly.', 503, 'unavailable');
      if (r.kind === 'pack') {
        const key = newKey(); const stub = await accountFor(n, key);
        const res = await stub.create({ balance: r.pack.credit, plan: r.pack.id, paid: r.pack.paid });
        if (!res.ok) return bad(c, 'Could not create the key; not charged. Retry.', 503, 'unavailable');
        c.set('minted', { stub });
        return c.json({ api_key: key, shown_once: true, note: 'Store this key now: it is shown only once and cannot be recovered. Anyone with the key can spend its credits; rotate it at POST /v1/key/rotate.', pack: r.pack.id, paid_usd: usd(r.pack.paid), credited_usd: usd(r.pack.credit), bonus_usd: usd(r.pack.bonus), balance_usd: usd(res.balance),
          use: { header: `Authorization: Bearer ${key}`, alternatives: ['X-Credits-Key', 'X-Credit-Token'], example: `curl -H "Authorization: Bearer ${key}" "${API_BASE}/payguard/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96"`, tools: [...new Set(TOOL_ROUTES.map((x) => `${API_BASE}/${x.tool}/`))] },
          balance: `${origin(c)}/v1/balance`, topup: { one: `${origin(c)}/v1/topup/1`, five: `${origin(c)}/v1/topup/5` }, terms: TERMS }, 200, { 'cache-control': 'no-store' });
      }
      const stub = c.get('topupStub');
      if (!stub) return bad(c, 'Send the key to top up: Authorization: Bearer <key>. Not charged.', 400, 'missing_key');
      const ref = `t_${crypto.randomUUID()}`;
      const p = await stub.topupPending({ ref, amount: r.pack.credit, paid: r.pack.paid, plan: r.pack.id });
      if (!p.ok) return bad(c, 'Unknown or inactive credits key; not charged.', 400, 'invalid_key');
      c.set('topup', { stub, ref });
      return c.json({ topped_up: true, pack: r.pack.id, paid_usd: usd(r.pack.paid), credited_usd: usd(r.pack.credit), bonus_usd: usd(r.pack.bonus), balance_usd: usd(p.balance + r.pack.credit), note: 'Credited once the payment settles (this response is only delivered after settlement).', balance: `${origin(c)}/v1/balance` }, 200, { 'cache-control': 'no-store' });
    });
  }
  return app;
}
