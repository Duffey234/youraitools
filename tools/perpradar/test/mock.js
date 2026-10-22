// Offline mock of the four perp venues. fail: set of venue names that error (HTTP 503) or 'timeout'.
const HL_META = { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'kPEPE' }, { name: 'MATIC', isDelisted: true }, { name: 'HOTX' }] };
const HL_CTX = [
  { funding: '0.0000125', openInterest: '40000', markPx: '80000', oraclePx: '80010', premium: '-0.0001', dayNtlVlm: '3000000000' },
  { funding: '0.00005', openInterest: '500000', markPx: '3000', oraclePx: '2999', premium: '0.0002', dayNtlVlm: '1000000000' },
  { funding: '-0.00002', openInterest: '2000000', markPx: '150', oraclePx: '150.1', premium: '-0.0003', dayNtlVlm: '400000000' },
  { funding: '0.0001', openInterest: '9000000', markPx: '0.01', oraclePx: '0.01', premium: '0', dayNtlVlm: '1000000' },
  { funding: '0.1', openInterest: '1', markPx: '1', oraclePx: '1', premium: '0', dayNtlVlm: '1' },
  { funding: '0.0004', openInterest: '2000000', markPx: '1', oraclePx: '1', premium: '0.001', dayNtlVlm: '9000000' },
];
const DYDX = { markets: {
  'BTC-USD': { status: 'ACTIVE', nextFundingRate: '0.00001', oraclePrice: '80005', openInterest: '200', volume24H: '7000000' },
  'ETH-USD': { status: 'ACTIVE', nextFundingRate: '-0.00001', oraclePrice: '3001', openInterest: '3000', volume24H: '2000000' },
  'OLD-USD': { status: 'FINAL_SETTLEMENT', nextFundingRate: '0.5', oraclePrice: '1', openInterest: '1', volume24H: '1' },
} };
const PARADEX = { results: [
  { symbol: 'BTC-USD-PERP', funding_rate: '0.0001', funding_interval_minutes: 480, mark_price: '80020', underlying_price: '80000', open_interest: '90', volume_24h: '3500000' },
  { symbol: 'ETH-USD-PERP', funding_rate: '0.0004', funding_interval_minutes: 480, mark_price: '3002', underlying_price: '3000', open_interest: '1000', volume_24h: '1000000' },
  { symbol: 'BTC-USD-OPTION', funding_rate: '9' },
] };
const AEVO = { BTC: { instrument_name: 'BTC-PERP', instrument_type: 'PERPETUAL', funding_rate: '0.000006', mark_price: '80000', index_price: '80001', markets: { total_oi: '27', daily_volume: '2000000' } } };
const hlHistory = (n, rate) => Array.from({ length: n }, (_, i) => ({ coin: 'BTC', fundingRate: String(i === n - 1 ? rate * 4 : rate), time: 1792000000000 + i * 3600000 }));

export function mockVenues({ fail = new Set(), calls = [] } = {}) {
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push(u.href);
    const venue = u.host.includes('hyperliquid') ? 'hyperliquid' : u.host.includes('dydx') ? 'dydx' : u.host.includes('paradex') ? 'paradex' : u.host.includes('aevo') ? 'aevo' : 'other';
    if (fail.has(venue)) return new Response('busy', { status: 503 });
    if (fail.has(`${venue}:timeout`)) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    const j = (o) => Response.json(o);
    if (venue === 'hyperliquid') {
      const b = JSON.parse(init.body || '{}');
      if (b.type === 'metaAndAssetCtxs') return j([HL_META, HL_CTX]);
      if (b.type === 'fundingHistory') return fail.has('hyperliquid_history') ? new Response('x', { status: 500 }) : j(hlHistory(168, 0.00001));
      if (b.type === 'meta') return j(HL_META);
    }
    if (venue === 'dydx') {
      if (u.pathname === '/v4/perpetualMarkets') return j(DYDX);
      if (u.pathname.startsWith('/v4/historicalFunding/')) return u.pathname.endsWith('BTC-USD') ? j({ historicalFunding: Array.from({ length: 100 }, (_, i) => ({ rate: String(0.00001 + (i % 5) * 1e-6) })) }) : j({ historicalFunding: [] });
      if (u.pathname === '/v4/time') return j({ iso: 'x' });
    }
    if (venue === 'paradex') return u.pathname.endsWith('/summary') ? j(PARADEX) : j({ server_time: 1 });
    if (venue === 'aevo') {
      const m = u.pathname.match(/^\/instrument\/([A-Z0-9]+)-PERP$/);
      if (m) return AEVO[m[1]] ? j(AEVO[m[1]]) : new Response('{"error":"INSTRUMENT_NOT_FOUND"}', { status: 404 });
      return j({ time: 1 });
    }
    throw new TypeError(`no network in tests: ${u.href}`);
  };
  return { calls, fetchImpl };
}
