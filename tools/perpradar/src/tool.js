// PerpRadar: tool definition used by the generic app (routes, inputs, views, copy).
import { perpSnapshot, perpFull, perpScan, normalizeSymbol, normalizeSymbols, InputError, Incomplete, DISCLAIMER, LIMITS, ENGINE_VERSION, USER_AGENT, VENUES } from './engine.js';
import { LITE_EXAMPLE, FULL_EXAMPLE, SCAN_EXAMPLE } from './examples.js';
import { withDeadline } from './deadline.js';
export { InputError, Incomplete, DISCLAIMER, LIMITS, ENGINE_VERSION, USER_AGENT };

export const NAME = 'PerpRadar';
export const SLUG = 'perpradar';
export const SOURCE_URL = 'https://agentgate-source.pages.dev/x402-perpradar/';
export const NPM_URL = 'https://www.npmjs.com/package/@agentgate-builder/perpradar';
export const SOURCES = { hyperliquid: 'https://api.hyperliquid.xyz/info', dydx: 'https://indexer.dydx.trade/v4', paradex: 'https://api.prod.paradex.trade/v1', aevo: 'https://api.aevo.xyz' };
export const DESCRIPTION = 'Perpetual futures funding radar for trading agents: funding rates normalized to 8h and APR, open interest, mark/index premium and a cross-venue positioning read for any asset across the onchain perp venues Hyperliquid, dYdX v4, Paradex and Aevo, plus 7-day funding history and z-score, funding carry and a universe scan for funding extremes and the widest cross-venue spreads. Read-only analytics, paid per call over x402 or with prepaid credits; free preview and remote MCP. Not financial advice.';
const SYM = { type: 'string', description: 'Base asset ticker, e.g. BTC, ETH, SOL, HYPE (BTC-PERP, ETH-USD and SOLUSDT are accepted too)' };
export const ROUTES = [
  { tier: 'lite', path: '/v1/lite', key: 'priceLite', env: 'X402_PRICE_LITE', dflt: '$0.005', op: 'perp_funding_lite',
    summary: 'Funding rate (8h and APR) and open interest for one asset on every venue, cross-venue median, spread and positioning read',
    desc: 'Perp funding rates for one asset across Hyperliquid, dYdX v4, Paradex and Aevo: per-venue funding normalized to 8h % and APR, open interest in USD, cross-venue median and OI-weighted funding, spread, cheapest venue to be long or short, and a positioning read (crowded long / long bias / neutral / short bias / crowded short). Fail-closed: failed venues are listed, never estimated. Not financial advice.',
    returns: 'Per-venue funding (8h %, APR) and OI, median / OI-weighted funding, spread, cheapest venue for longs and shorts, positioning label, confidence, sources_failed.',
    input: { symbol: 'BTC' }, schema: { properties: { symbol: SYM }, required: ['symbol'] }, example: LITE_EXAMPLE },
  { tier: 'full', path: '/v1/full', key: 'priceFull', env: 'X402_PRICE_FULL', dflt: '$0.03', op: 'perp_derivatives_full',
    summary: 'Full derivatives read: per-venue funding, OI, mark/index premium, 24h volume, 7-day funding history with z-score and percentile, regime, funding carry',
    desc: 'Full perp derivatives snapshot for one asset across Hyperliquid, dYdX v4, Paradex and Aevo: funding (raw, 8h %, APR, interval), open interest, mark and index price, premium, 24h volume per venue; Hyperliquid 7-day and dYdX 100-hour funding history with mean, min, max, z-score and percentile of the latest rate; funding regime vs recent history; median premium read; annualized funding carry per venue; positioning read. Fail-closed. Not financial advice.',
    returns: 'Everything in lite plus mark/index premium, 24h volume, funding history stats (mean, min, max, z-score, percentile), regime vs recent history, premium read and funding carry per venue.',
    input: { symbol: 'ETH' }, schema: { properties: { symbol: SYM }, required: ['symbol'] }, example: FULL_EXAMPLE },
  { tier: 'scan', path: '/v1/scan', key: 'priceScan', env: 'X402_PRICE_SCAN', dflt: '$0.02', op: 'perp_funding_scan',
    summary: 'Funding scan: a watchlist (symbols=BTC,ETH,SOL) or the whole universe (universe=all): highest and lowest funding, widest cross-venue spreads, market-wide OI-weighted funding',
    desc: 'Cross-venue perp funding scan over Hyperliquid, dYdX v4 and Paradex: pass a watchlist (symbols=BTC,ETH,SOL, up to 25) or universe=all (every market above min_oi_usd, default $1M). Returns the highest and lowest funding (APR), the widest cross-venue funding spreads, the market-wide OI-weighted funding and share of markets with positive funding, with a per-asset positioning label. Fail-closed. Not financial advice.',
    returns: 'Highest / lowest funding assets, widest cross-venue spreads, market-wide OI-weighted funding and positive-funding share, per-asset venues and positioning; watchlist rows when symbols is given.',
    input: { universe: 'all' },
    schema: { properties: { symbols: { type: 'string', description: 'Comma-separated tickers (max 25), e.g. BTC,ETH,SOL. Either symbols or universe=all is required.' }, universe: { type: 'string', enum: ['all'], description: 'all = scan every market above min_oi_usd' }, min_oi_usd: { type: 'number', description: 'Universe mode: minimum open interest in USD per venue market (default 1000000)' }, limit: { type: 'integer', description: 'Rows per list, 1-25 (default 10)' } } },
    example: SCAN_EXAMPLE },
];
export const PREVIEW = { path: '/v1/preview', tier: 'preview', input: { symbol: 'BTC' }, schema: { properties: { symbol: SYM }, required: ['symbol'] }, returns: 'positioning label, venues listing the asset, confidence and sources_failed (no rates)' };

export function parseInput(tier, raw = {}) {
  if (tier === 'scan') {
    const lim = raw.limit === undefined || raw.limit === '' ? 10 : Number(raw.limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 25) throw new InputError('"limit" must be an integer from 1 to 25');
    if (raw.symbols !== undefined && raw.symbols !== '') return { symbols: normalizeSymbols(raw.symbols), limit: lim };
    if (raw.universe === undefined || raw.universe === '') throw new InputError('provide "symbols" (e.g. BTC,ETH,SOL) or "universe": "all"');
    if (String(raw.universe).toLowerCase() !== 'all') throw new InputError('"universe" must be "all"');
    const m = raw.min_oi_usd === undefined || raw.min_oi_usd === '' ? 1_000_000 : Number(raw.min_oi_usd);
    if (!Number.isFinite(m) || m < 0 || m > 1e12) throw new InputError('"min_oi_usd" must be a number from 0 to 1e12');
    return { universe: 'all', minOiUsd: m, limit: lim };
  }
  const s = raw.symbol ?? raw.coin ?? raw.asset ?? raw.ticker;
  if (s === undefined || s === '') throw new InputError('"symbol" is required, e.g. BTC');
  return { symbol: normalizeSymbol(s) };
}

export function run(tier, v, ctx) {
  if (tier === 'scan') return perpScan(v.symbols ? { symbols: v.symbols, limit: v.limit } : { minOiUsd: v.minOiUsd, limit: v.limit }, ctx);
  if (tier === 'full') return perpFull(v.symbol, ctx);
  return perpSnapshot(v.symbol, ctx);
}

export function liteView(r) {
  return {
    symbol: r.symbol, venues_ok: r.venues_ok, funding: r.funding, open_interest_usd_total: r.open_interest_usd_total,
    positioning: r.positioning, positioning_note: r.positioning_note,
    venues: r.venues.map((v) => ({ venue: v.venue, market: v.market, funding_8h_pct: v.funding_8h_pct, funding_apr_pct: v.funding_apr_pct, funding_interval_hours: v.funding_interval_hours, open_interest_usd: v.open_interest_usd })),
    confidence: r.confidence, sources_failed: r.sources_failed, checked_at: r.checked_at,
  };
}
export function paidView(tier, r) { return tier === 'lite' ? liteView(r) : r; }
export function previewView(r) {
  return { symbol: r.symbol, positioning: r.positioning, positioning_note: r.positioning_note, venues_listed: r.venues_listed, venues_ok: r.venues_ok, confidence: r.confidence, sources_failed: r.sources_failed, checked_at: r.checked_at, disclaimer: DISCLAIMER };
}
export function fullLinks(origin, v, prices) {
  const q = encodeURIComponent(v.symbol);
  return { lite: `${origin}/v1/lite?symbol=${q}`, full: `${origin}/v1/full?symbol=${q}`, scan: `${origin}/v1/scan?universe=all`, prices, adds: 'per-venue funding (8h %, APR), OI, median / OI-weighted funding, spread and cheapest venue (lite); premium, 24h volume, 7-day funding history, z-score, regime and carry (full); universe extremes and spreads (scan)' };
}
export const MCP_INSTRUCTIONS = 'Call perp_positioning with an asset ticker (BTC, ETH, SOL...) for the cross-venue positioning read from perp funding on Hyperliquid, dYdX, Paradex and Aevo. Rates, OI, history and scans are on the paid x402 routes. Not financial advice.';
export const MCP_TOOLS = [
  { name: 'perp_positioning', title: 'Perp funding positioning (free preview)', description: 'Cross-venue perpetual futures positioning read for an asset from funding rates on Hyperliquid, dYdX v4, Paradex and Aevo: crowded long / long bias / neutral / short bias / crowded short, venues that list it, confidence. Free preview tier. The paid x402 routes add per-venue funding (8h %, APR) and open interest (/v1/lite), premium, 7-day funding history and carry (/v1/full) and a universe scan for funding extremes and spreads (/v1/scan). Read-only analytics; not financial advice.', inputSchema: { type: 'object', properties: { symbol: SYM }, required: ['symbol'] }, annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false } },
];
export function previewText(pv, origin, v, prices) {
  return `PerpRadar ${pv.symbol}: ${pv.positioning.replace(/_/g, ' ')} (${pv.positioning_note}) Venues: ${pv.venues_listed.join(', ')}; confidence ${pv.confidence}${pv.sources_failed.length ? `; failed: ${pv.sources_failed.join(', ')}` : ''}.\nFunding rates, OI and spreads: ${origin}/v1/lite?symbol=${encodeURIComponent(v.symbol)} (${prices.lite}); history, premium and carry: /v1/full (${prices.full}); universe scan: /v1/scan?universe=all (${prices.scan}). x402 USDC on Base or Solana.\n${DISCLAIMER}`;
}
export async function probeSources({ fetchImpl }) {
  const probe = async (name, url, init) => { const t0 = Date.now(); try { const r = await withDeadline(fetchImpl(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init?.headers || {}) } }), 6000, name); return [name, { status: r.status, ms: Date.now() - t0 }]; } catch (e) { return [name, { error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 }]; } };
  return Object.fromEntries(await Promise.all([
    probe('hyperliquid', SOURCES.hyperliquid, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"meta"}' }),
    probe('dydx', `${SOURCES.dydx}/time`), probe('paradex', `${SOURCES.paradex}/system/time`), probe('aevo', `${SOURCES.aevo}/time`),
  ]));
}
export { VENUES };
export const LANDING = {
  title: 'PerpRadar: perp funding rates, open interest and positioning across Hyperliquid, dYdX, Paradex, Aevo (x402 API + MCP)',
  h1: 'Perp<span>Radar</span>',
  lead: 'Perpetual futures funding radar for trading agents. One call returns funding rates normalized to <b>8h and APR</b>, open interest and mark/index premium for any asset across the onchain perp venues <b>Hyperliquid, dYdX v4, Paradex and Aevo</b>, with the cross-venue median, spread, cheapest venue to be long or short and a positioning read. The full tier adds 7-day funding history with z-score and percentile, the funding regime and carry; the scan finds funding extremes and the widest cross-venue spreads across the whole market. Read-only analytics: PerpRadar never trades and never touches funds.',
  snippet: (origin) => `// Trading agent: check perp positioning before sizing a trade
const r = await (await pay('${origin}/v1/lite?symbol=SOL')).json();
console.log(r.positioning, r.funding.median_apr_pct, r.funding.cheapest_to_be_long);
const scan = await (await pay('${origin}/v1/scan?universe=all&limit=5')).json();
console.log(scan.highest_funding.map((x) => [x.symbol, x.median_apr_pct]));`,
};
