// Offline mock of the candle sources. fail: set of 'hyperliquid' | 'dydx' (HTTP 503) or '<name>:timeout'.
export const NOW = Date.UTC(2026, 9, 22, 12, 30); // 12:30 UTC: the 12:00 1h candle is in progress
const MS = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
export function series(n, { start = 100, drift = 0.001, amp = 0.03, period = 40 } = {}) {
  return Array.from({ length: n }, (_, i) => start * (1 + drift) ** i * (1 + amp * Math.sin((2 * Math.PI * i) / period)));
}
function candles(coin, tf, n, now, opts) {
  const ms = MS[tf]; const lastStart = Math.floor(now / ms) * ms; const px = series(n + 1, opts);
  return Array.from({ length: n + 1 }, (_, i) => { const t = lastStart - (n - i) * ms; const o = i ? px[i - 1] : px[0]; const c = px[i]; return { t, T: t + ms - 1, s: coin, i: tf, o: String(o), c: String(c), h: String(Math.max(o, c) * 1.004), l: String(Math.min(o, c) * 0.996), v: String(1000 + (i % 7) * 50) }; });
}
export function mockSources({ fail = new Set(), calls = [], hlCoins = ['BTC', 'ETH', 'SOL', 'kPEPE'], dydxCoins = ['BTC', 'ETH', 'SOL', 'DYDXONLY'], bars = 600, now = NOW, opts = {} } = {}) {
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push(u.href + (init.body ? ` ${init.body}` : ''));
    const venue = u.host.includes('hyperliquid') ? 'hyperliquid' : u.host.includes('dydx') ? 'dydx' : 'other';
    if (fail.has(venue)) return new Response('busy', { status: 503 });
    if (fail.has(`${venue}:timeout`)) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    if (venue === 'hyperliquid') {
      const b = JSON.parse(init.body || '{}');
      if (b.type === 'meta') return Response.json({ universe: [...hlCoins.map((name) => ({ name })), { name: 'OLD', isDelisted: true }] });
      if (b.type === 'candleSnapshot') {
        if (!hlCoins.includes(b.req.coin)) return new Response('null', { status: 500 });
        const all = candles(b.req.coin, b.req.interval, bars, now, opts);
        return Response.json(all.filter((c) => c.t >= b.req.startTime));
      }
    }
    if (venue === 'dydx') {
      if (u.pathname === '/v4/time') return Response.json({ iso: 'x' });
      const m = u.pathname.match(/^\/v4\/candles\/perpetualMarkets\/([A-Z0-9]+)-USD$/);
      if (m) {
        if (!dydxCoins.includes(m[1])) return Response.json({ errors: [{ msg: 'not found' }] }, { status: 404 });
        const tf = { '15MINS': '15m', '1HOUR': '1h', '4HOURS': '4h', '1DAY': '1d' }[u.searchParams.get('resolution')];
        const all = candles(m[1], tf, Math.min(bars, Number(u.searchParams.get('limit')) - 1), now, opts).reverse();
        return Response.json({ candles: all.map((c) => ({ startedAt: new Date(c.t).toISOString(), open: c.o, high: c.h, low: c.l, close: c.c, baseTokenVolume: c.v })) });
      }
    }
    throw new TypeError(`no network in tests: ${u.href}`);
  };
  return { calls, fetchImpl };
}
