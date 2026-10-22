// PerpRadar engine: perpetual-futures funding, open interest, premium and positioning across onchain perp venues
// (Hyperliquid, dYdX v4, Paradex, Aevo). Read-only public market data; nothing is traded, no keys, no custody.
// Fail-closed: a venue that errors or times out is listed in sources_failed and never filled in; the cross-venue read
// needs >= 2 venues (otherwise "unknown", confidence low); no venue at all = Incomplete (HTTP 503, never charged).
import { withDeadline } from './deadline.js';

export const ENGINE_VERSION = 'perpradar-0.1.0';
export const USER_AGENT = 'PerpRadar/0.1 (+https://api.youraitools.co/perpradar; read-only market data; hello@youraitools.co)';
export const DISCLAIMER = 'Not financial advice. Past performance does not guarantee future results. Read-only market analytics from public venue data at the time of the request; funding rates change every hour and can reverse. PerpRadar never trades, holds funds or keys.';
export const VENUES = ['hyperliquid', 'dydx', 'paradex', 'aevo'];
export const SCAN_VENUES = ['hyperliquid', 'dydx', 'paradex'];
export const LIMITS = [
  'Onchain perp venues only (Hyperliquid, dYdX v4, Paradex, Aevo); centralized exchanges are not included.',
  'Funding is normalized to an 8-hour rate and an annualized rate (APR, simple, not compounded) from each venue\'s native interval.',
  'Positioning labels are descriptive statistics of funding, not predictions or trade signals.',
  'Venue data can lag or be wrong; a venue that fails is listed in sources_failed and left out, never estimated.',
];
const TIMEOUT = 6000;
const HOURS_PER_YEAR = 24 * 365;

export class InputError extends Error { constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; } }
export class Incomplete extends Error { constructor(message, sources_failed = []) { super(message); this.code = 'upstream_unavailable'; this.sources_failed = sources_failed; } }

const num = (v) => { const n = typeof v === 'number' ? v : Number.parseFloat(v); return Number.isFinite(n) ? n : null; };
const round = (v, d = 6) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** Normalize a user symbol: "btc", "BTC-PERP", "ETH-USD", "SOLUSDT" -> "BTC" / "ETH" / "SOL". */
export function normalizeSymbol(raw) {
  if (typeof raw !== 'string') throw new InputError('"symbol" must be a string, e.g. BTC');
  let s = raw.trim().toUpperCase().replace(/[\s_/]+/g, '-');
  s = s.replace(/-?(PERP|PERPETUAL|SWAP)$/, '').replace(/-?(USDT|USDC|USD)$/, '').replace(/-+$/, '');
  if (!/^[A-Z0-9]{1,15}$/.test(s)) throw new InputError('"symbol" must be a base asset ticker like BTC, ETH or SOL (letters and digits, max 15)');
  return s;
}
export function normalizeSymbols(raw, max = 25) {
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) throw new InputError('"symbols" must list at least one ticker, e.g. BTC,ETH,SOL');
  if (list.length > max) throw new InputError(`"symbols" can list at most ${max} tickers`);
  return [...new Set(list.map(normalizeSymbol))];
}

async function getJson(fetchImpl, url, init = {}, what = url) {
  const ctl = new AbortController();
  const p = (async () => {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
    return r.json();
  })();
  try { return await withDeadline(p, TIMEOUT, what); } finally { ctl.abort(); }
}

/** One row per venue market, rates normalized. rate = funding per interval (fraction). */
function row(venue, market, { rate, intervalH, mark, index, oiBase, volUsd }) {
  rate = num(rate); mark = num(mark); index = num(index); oiBase = num(oiBase);
  if (rate === null) return null;
  const perHour = rate / intervalH;
  const premium = mark !== null && index ? (mark - index) / index * 100 : null;
  return {
    venue, market, funding_rate: rate, funding_interval_hours: intervalH,
    funding_8h_pct: round(perHour * 8 * 100, 5), funding_apr_pct: round(perHour * HOURS_PER_YEAR * 100, 3),
    mark_price: mark, index_price: index, premium_pct: round(premium, 4),
    open_interest: oiBase, open_interest_usd: oiBase !== null && (mark ?? index) ? Math.round(oiBase * (mark ?? index)) : null,
    volume_24h_usd: num(volUsd) !== null ? Math.round(num(volUsd)) : null,
  };
}

// ---- venue adapters: each returns Map(symbol -> row) for every listed market ----
const ADAPTERS = {
  async hyperliquid(f) {
    const [meta, ctxs] = await getJson(f, 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }, 'hyperliquid');
    const out = new Map();
    meta.universe.forEach((u, i) => {
      if (u.isDelisted || !ctxs[i]) return;
      const c = ctxs[i]; const sym = u.name.startsWith('k') && /^k[A-Z0-9]+$/.test(u.name) ? u.name.slice(1) : u.name;
      const scale = sym !== u.name ? 1000 : 1; // kPEPE etc. quote 1000 units
      const r = row('hyperliquid', u.name, { rate: c.funding, intervalH: 1, mark: num(c.markPx) / scale, index: num(c.oraclePx) / scale, oiBase: num(c.openInterest) * scale, volUsd: c.dayNtlVlm });
      if (r) { r.premium_pct = round(num(c.premium) * 100, 4) ?? r.premium_pct; out.set(sym.toUpperCase(), r); }
    });
    return out;
  },
  async dydx(f) {
    const j = await getJson(f, 'https://indexer.dydx.trade/v4/perpetualMarkets', {}, 'dydx');
    const out = new Map();
    for (const [t, m] of Object.entries(j.markets || {})) {
      if (m.status !== 'ACTIVE' || !t.endsWith('-USD')) continue;
      const r = row('dydx', t, { rate: m.nextFundingRate, intervalH: 1, mark: null, index: m.oraclePrice, oiBase: m.openInterest, volUsd: m.volume24H });
      if (r) out.set(t.slice(0, -4).toUpperCase(), r);
    }
    return out;
  },
  async paradex(f) {
    const j = await getJson(f, 'https://api.prod.paradex.trade/v1/markets/summary?market=ALL', {}, 'paradex');
    const out = new Map();
    for (const m of j.results || []) {
      if (!/-USD-PERP$/.test(m.symbol || '')) continue;
      const ih = num(m.funding_interval_minutes) ? num(m.funding_interval_minutes) / 60 : 8;
      const r = row('paradex', m.symbol, { rate: m.funding_rate, intervalH: ih, mark: m.mark_price, index: m.underlying_price, oiBase: m.open_interest, volUsd: m.volume_24h });
      if (r) out.set(m.symbol.replace(/-USD-PERP$/, '').toUpperCase(), r);
    }
    return out;
  },
};
// Aevo has no cheap all-markets funding endpoint: per symbol only (single-symbol tiers).
async function aevoOne(f, sym) {
  let j;
  try { j = await getJson(f, `https://api.aevo.xyz/instrument/${encodeURIComponent(sym)}-PERP`, {}, 'aevo'); }
  catch (e) { if (/HTTP 4\d\d/.test(e.message)) return null; throw e; }
  if (!j || j.instrument_type !== 'PERPETUAL') return null;
  return row('aevo', j.instrument_name, { rate: j.funding_rate, intervalH: 1, mark: j.mark_price, index: j.index_price, oiBase: j.markets?.total_oi, volUsd: j.markets?.daily_volume });
}

// Per-isolate cache of the all-markets snapshots (15 s) so bursts and the scan share one upstream call per venue.
const SNAP = new Map();
async function snapshot(venue, f, now) {
  const hit = SNAP.get(venue);
  if (hit && now - hit.at < 15000 && hit.f === f) return hit.p;
  const p = ADAPTERS[venue](f);
  SNAP.set(venue, { at: now, p, f });
  p.catch(() => { if (SNAP.get(venue)?.p === p) SNAP.delete(venue); });
  return p;
}
export function _clearCache() { SNAP.clear(); }

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function positioning(aprMedian) {
  if (aprMedian === null) return 'unknown';
  if (aprMedian >= 30) return 'crowded_long';
  if (aprMedian >= 10) return 'long_bias';
  if (aprMedian > -10) return 'neutral';
  if (aprMedian > -30) return 'short_bias';
  return 'crowded_short';
}
const POS_TEXT = {
  crowded_long: 'Longs pay a high funding rate: positioning looks crowded long.',
  long_bias: 'Longs pay shorts: mild long bias.',
  neutral: 'Funding is near zero: no strong positioning bias.',
  short_bias: 'Shorts pay longs: mild short bias.',
  crowded_short: 'Shorts pay a high funding rate: positioning looks crowded short.',
  unknown: 'Fewer than 2 venues answered: no cross-venue read.',
};

function summarize(sym, rows, failed, checkedAt) {
  const aprs = rows.map((r) => r.funding_apr_pct);
  const med = rows.length >= 2 ? median(aprs) : null;
  const pos = positioning(med);
  const sorted = [...rows].sort((a, b) => a.funding_apr_pct - b.funding_apr_pct);
  const oiTotal = rows.reduce((s, r) => s + (r.open_interest_usd || 0), 0);
  const w = rows.filter((r) => r.open_interest_usd);
  const oiw = w.length ? w.reduce((s, r) => s + r.funding_apr_pct * r.open_interest_usd, 0) / w.reduce((s, r) => s + r.open_interest_usd, 0) : null;
  const ok = rows.length;
  return {
    symbol: sym,
    venues_ok: ok, venues_listed: rows.map((r) => r.venue),
    funding: {
      median_apr_pct: round(med, 3), median_8h_pct: med === null ? null : round(med / (HOURS_PER_YEAR / 8), 5),
      oi_weighted_apr_pct: rows.length >= 2 ? round(oiw, 3) : null,
      min: sorted[0] ? { venue: sorted[0].venue, apr_pct: sorted[0].funding_apr_pct } : null,
      max: sorted.at(-1) ? { venue: sorted.at(-1).venue, apr_pct: sorted.at(-1).funding_apr_pct } : null,
      cross_venue_spread_apr_pct: rows.length >= 2 ? round(sorted.at(-1).funding_apr_pct - sorted[0].funding_apr_pct, 3) : null,
      cheapest_to_be_long: sorted[0]?.venue ?? null, cheapest_to_be_short: sorted.at(-1)?.venue ?? null,
    },
    open_interest_usd_total: Math.round(oiTotal),
    positioning: pos, positioning_note: POS_TEXT[pos],
    confidence: ok >= 3 && !failed.length ? 'high' : ok >= 2 ? 'medium' : 'low',
    sources_failed: failed,
    checked_at: new Date(checkedAt).toISOString(),
  };
}

/** Funding + OI + premium for one asset on every venue. */
export async function perpSnapshot(sym, { fetchImpl = globalThis.fetch, now = Date.now(), venues = VENUES } = {}) {
  const failed = [];
  const res = await Promise.all(venues.map(async (v) => {
    try { return v === 'aevo' ? await aevoOne(fetchImpl, sym) : (await snapshot(v, fetchImpl, now)).get(sym) || null; }
    catch (e) { failed.push(v); return null; }
  }));
  const rows = res.filter(Boolean);
  if (!rows.length) {
    if (failed.length) throw new Incomplete(`No venue answered for ${sym} (${failed.join(', ')} failed). Not charged; retry shortly.`, failed.sort());
    throw new InputError(`${sym} is not listed as a perpetual on ${venues.join(', ')}`, 404, 'symbol_not_found');
  }
  failed.sort();
  return { ...summarize(sym, rows, failed, now), venues: rows };
}

/** Funding history (Hyperliquid 7 d hourly + dYdX last 100 h) for the full tier. Fail-closed per source. */
export async function fundingHistory(sym, hlMarket, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const out = {}; const failed = [];
  const stats = (rates, intervalH) => {
    const aprs = rates.map((x) => x / intervalH * HOURS_PER_YEAR * 100);
    if (aprs.length < 6) return null;
    const mean = aprs.reduce((s, x) => s + x, 0) / aprs.length;
    const sd = Math.sqrt(aprs.reduce((s, x) => s + (x - mean) ** 2, 0) / aprs.length);
    const cur = aprs.at(-1);
    return { samples: aprs.length, mean_apr_pct: round(mean, 3), min_apr_pct: round(Math.min(...aprs), 3), max_apr_pct: round(Math.max(...aprs), 3), latest_apr_pct: round(cur, 3), zscore_latest: sd > 0 ? round((cur - mean) / sd, 2) : 0, percentile_latest: Math.round(aprs.filter((x) => x <= cur).length / aprs.length * 100), positive_share_pct: Math.round(aprs.filter((x) => x > 0).length / aprs.length * 100) };
  };
  await Promise.all([
    hlMarket && (async () => {
      try {
        const j = await getJson(fetchImpl, 'https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin: hlMarket, startTime: now - 7 * 86400000 }) }, 'hyperliquid_history');
        const s = stats((Array.isArray(j) ? j : []).map((x) => num(x.fundingRate)).filter((x) => x !== null), 1);
        if (s) out.hyperliquid_7d = s; else failed.push('hyperliquid_history');
      } catch { failed.push('hyperliquid_history'); }
    })(),
    (async () => {
      try {
        const j = await getJson(fetchImpl, `https://indexer.dydx.trade/v4/historicalFunding/${encodeURIComponent(sym)}-USD?limit=100`, {}, 'dydx_history');
        const rates = (j.historicalFunding || []).map((x) => num(x.rate)).filter((x) => x !== null).reverse();
        const s = stats(rates, 1);
        if (s) out.dydx_100h = s; else if (!(j.historicalFunding || []).length) { /* not listed on dYdX */ } else failed.push('dydx_history');
      } catch (e) { if (!/HTTP 404/.test(e.message)) failed.push('dydx_history'); }
    })(),
  ]);
  return { history: out, failed: failed.sort() };
}

export async function perpFull(sym, opts = {}) {
  const snap = await perpSnapshot(sym, opts);
  const hl = snap.venues.find((v) => v.venue === 'hyperliquid');
  const h = await fundingHistory(sym, hl?.market, opts);
  const carry = snap.venues.map((v) => ({ venue: v.venue, short_perp_funding_apr_pct: v.funding_apr_pct, note: v.funding_apr_pct >= 0 ? 'a short perp position currently receives funding' : 'a short perp position currently pays funding' }));
  const pr = snap.venues.filter((v) => v.premium_pct !== null).map((v) => v.premium_pct);
  const failed = [...new Set([...snap.sources_failed, ...h.failed])].sort();
  const hist = h.history.hyperliquid_7d || h.history.dydx_100h;
  return {
    ...snap,
    premium: { median_pct: round(median(pr), 4), read: pr.length ? (median(pr) > 0.05 ? 'perps trade above index (bid for leverage long)' : median(pr) < -0.05 ? 'perps trade below index (pressure from shorts)' : 'perps trade near index') : 'unknown' },
    history: h.history,
    regime: hist ? { vs_recent: hist.zscore_latest >= 2 ? 'funding unusually high vs recent history' : hist.zscore_latest <= -2 ? 'funding unusually low vs recent history' : 'funding within its recent range', zscore: hist.zscore_latest, percentile: hist.percentile_latest, based_on: h.history.hyperliquid_7d ? 'hyperliquid_7d' : 'dydx_100h' } : { vs_recent: 'unknown', based_on: null },
    carry, carry_note: 'Funding carry is the annualized funding a delta-neutral short-perp / long-spot position would receive at the current rate, before fees, slippage and borrow. Rates change hourly; not a return forecast.',
    sources_failed: failed,
    confidence: snap.venues_ok >= 3 && !failed.length ? 'high' : snap.venues_ok >= 2 ? 'medium' : 'low',
  };
}

/** Cross-venue funding scan: a watchlist (symbols) or the whole universe (extremes + spreads). */
export async function perpScan({ symbols = null, minOiUsd = 1_000_000, limit = 10 } = {}, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const failed = []; const maps = {};
  await Promise.all(SCAN_VENUES.map(async (v) => { try { maps[v] = await snapshot(v, fetchImpl, now); } catch { failed.push(v); } }));
  const ok = Object.keys(maps);
  if (!ok.length) throw new Incomplete(`No venue answered (${failed.join(', ')} failed). Not charged; retry shortly.`, failed.sort());
  const assets = new Map();
  for (const [v, m] of Object.entries(maps)) for (const [s, r] of m) { if (!assets.has(s)) assets.set(s, []); assets.get(s).push(r); }
  const pick = symbols ? symbols : [...assets.keys()];
  const items = [];
  const missing = [];
  for (const s of pick) {
    const rows = (assets.get(s) || []).filter((r) => symbols || (r.open_interest_usd ?? 0) >= minOiUsd);
    if (!rows.length) { if (symbols) missing.push(s); continue; }
    const sm = summarize(s, rows, [], now);
    items.push({ symbol: s, venues: rows.map((r) => ({ venue: r.venue, funding_apr_pct: r.funding_apr_pct, funding_8h_pct: r.funding_8h_pct, open_interest_usd: r.open_interest_usd, premium_pct: r.premium_pct })), median_apr_pct: rows.length >= 2 ? sm.funding.median_apr_pct : rows[0].funding_apr_pct, spread_apr_pct: sm.funding.cross_venue_spread_apr_pct, oi_usd_total: sm.open_interest_usd_total, positioning: rows.length >= 2 ? sm.positioning : positioning(rows[0].funding_apr_pct), single_venue: rows.length < 2 });
  }
  const by = (k, dir) => [...items].filter((x) => x[k] !== null).sort((a, b) => dir * (b[k] - a[k])).slice(0, limit);
  const pos = items.filter((x) => x.median_apr_pct > 0).length;
  const w = items.filter((x) => x.oi_usd_total > 0);
  const oiw = w.length ? w.reduce((s, x) => s + x.median_apr_pct * x.oi_usd_total, 0) / w.reduce((s, x) => s + x.oi_usd_total, 0) : null;
  failed.sort();
  return {
    mode: symbols ? 'watchlist' : 'universe',
    filters: symbols ? { symbols } : { min_oi_usd: minOiUsd },
    venues_ok: ok.sort(), assets: items.length,
    market: { oi_weighted_funding_apr_pct: round(oiw, 3), positive_funding_share_pct: items.length ? Math.round(pos / items.length * 100) : null, read: oiw === null ? 'unknown' : positioning(oiw) },
    highest_funding: by('median_apr_pct', 1), lowest_funding: by('median_apr_pct', -1),
    widest_spreads: by('spread_apr_pct', 1).filter((x) => !x.single_venue),
    ...(symbols ? { watchlist: items, not_listed: missing } : {}),
    confidence: ok.length >= 3 ? 'high' : ok.length === 2 ? 'medium' : 'low',
    sources_failed: failed,
    checked_at: new Date(now).toISOString(),
  };
}
