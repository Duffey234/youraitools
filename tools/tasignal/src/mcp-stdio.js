#!/usr/bin/env node
// TASignal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Free by default: the hosted free preview (bias, trend, regime; 10/min per IP).
// Full data: set TASIGNAL_X402_PRIVATE_KEY (or X402_PRIVATE_KEY) to a Base wallet key holding a little USDC, and this
// server pays the hosted API per call over x402 (lite $0.005, risk $0.02, backtest $0.05): https://api.youraitools.co/tasignal
//   npx -y @agentgate-builder/tasignal   (bin: tasignal)
import { createInterface } from 'node:readline';
import { toInput, preview, DISCLAIMER, FULL_DETAILS, API_BASE, PRICES, TIMEFRAMES } from './lite.js';
import { createPaidClient } from './paid.js';
import { VERSION_STR as VERSION } from './version.js';

export { VERSION };
const SYM = { type: 'string', description: 'Asset ticker, e.g. BTC, ETH, SOL, HYPE' };
const TF = { type: 'string', enum: TIMEFRAMES, description: 'Candle timeframe (default 1h)' };
const RO = { readOnlyHint: true, openWorldHint: true, idempotentHint: false };
export const TOOLS = [
  { name: 'ta_indicators', title: 'Technical indicators and bias for an asset', description: `Technical read for a crypto asset on closed candles. Free by default: bias (strong bearish ... strong bullish), trend and regime. With TASIGNAL_X402_PRIVATE_KEY set, returns the paid lite tier (${PRICES.lite} USDC on Base per call over x402): RSI, MACD, EMA 20/50/200, Bollinger, ATR, ADX, stochastic, realized volatility and the bias components. Read-only; not financial advice.`, inputSchema: { type: 'object', properties: { symbol: SYM, timeframe: TF }, required: ['symbol'] }, annotations: RO },
  { name: 'ta_position_size', title: 'Risk metrics and ATR position sizing', description: `Paid only (needs TASIGNAL_X402_PRIVATE_KEY, ${PRICES.risk} USDC on Base per call): historical VaR/CVaR, drawdowns, volatility, Sharpe/Sortino, ATR stop and position size for account_usd at risk_pct. Read-only; not financial advice.`, inputSchema: { type: 'object', properties: { symbol: SYM, timeframe: TF, account_usd: { type: 'number' }, risk_pct: { type: 'number' }, side: { type: 'string', enum: ['long', 'short'] }, stop: { type: 'number' }, entry: { type: 'number' } }, required: ['symbol'] }, annotations: RO },
  { name: 'ta_backtest', title: 'Backtest a rule-based strategy', description: `Paid only (needs TASIGNAL_X402_PRIVATE_KEY, ${PRICES.backtest} USDC on Base per call): sma_cross, ema_cross, rsi_reversion, breakout or macd_cross on up to 2000 candles with fees; return vs buy-and-hold, drawdown, Sharpe, win rate, trades. Historical simulation; past performance does not guarantee future results.`, inputSchema: { type: 'object', properties: { symbol: SYM, timeframe: TF, strategy: { type: 'string', enum: ['sma_cross', 'ema_cross', 'rsi_reversion', 'breakout', 'macd_cross'] }, fast: { type: 'integer' }, slow: { type: 'integer' }, period: { type: 'integer' }, direction: { type: 'string', enum: ['long_only', 'long_short'] }, fee_bps: { type: 'number' }, bars: { type: 'integer' } }, required: ['symbol', 'strategy'] }, annotations: RO },
];
const TIER = { ta_indicators: 'lite', ta_position_size: 'risk', ta_backtest: 'backtest' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const summarizePreview = (r, note) => `${note ? note + '\n' : ''}TASignal ${r.symbol} ${r.timeframe}: ${String(r.bias).replace(/_/g, ' ')} bias, trend ${r.trend}, regime ${r.regime}; confidence ${r.confidence}.\n${FULL_DETAILS} Set TASIGNAL_X402_PRIVATE_KEY to get them here.\n${DISCLAIMER}`;
const summarizePaid = (tier, r) => {
  if (tier === 'lite') return `TASignal ${r.symbol} ${r.timeframe}: ${String(r.signal?.bias).replace(/_/g, ' ')} (score ${r.signal?.score}), trend ${r.signal?.trend}, regime ${r.signal?.regime}. RSI ${r.indicators?.rsi_14}, MACD hist ${r.indicators?.macd?.histogram}, ATR ${r.indicators?.atr_pct}%, vol ${r.indicators?.realized_vol_annual_pct}%/yr.\n${DISCLAIMER}`;
  if (tier === 'risk') return `TASignal risk ${r.symbol} ${r.timeframe}: vol ${r.risk?.volatility_annual_pct}%/yr, VaR95 1d ${r.risk?.var_95_1d_pct}%, max DD ${r.risk?.max_drawdown_pct}%. Stop ${r.position_sizing?.stop} (${r.position_sizing?.stop_distance_pct}%)${r.position_sizing?.units ? `, size ${r.position_sizing.units} units ($${r.position_sizing.notional_usd})` : ''}.\n${DISCLAIMER}`;
  return `TASignal backtest ${r.symbol} ${r.timeframe} ${r.strategy?.name}: return ${r.result?.total_return_pct}% vs buy-and-hold ${r.result?.buy_and_hold_return_pct}%, max DD ${r.result?.max_drawdown_pct}%, ${r.result?.trades} trades, win rate ${r.result?.win_rate_pct}%.\n${DISCLAIMER}`;
};

let paidClient;
const paid = async (opts) => { if (paidClient === undefined) paidClient = await createPaidClient(opts); return paidClient; };

export async function handle(m, opts = {}) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  const note = m.id === undefined || m.id === null;
  const ok = (result) => (note ? null : { jsonrpc: '2.0', id: m.id, result });
  const err = (text) => ok({ isError: true, content: [{ type: 'text', text }] });
  switch (m.method) {
    case 'initialize': {
      const client = await paid(opts);
      const mode = client && !client.error ? `Paid mode: full data from ${client.apiBase} over x402.` : `Free preview mode; indicator values, risk and backtests at ${API_BASE} (x402).`;
      return ok({ protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tasignal', title: 'TASignal', version: VERSION }, instructions: `Call ta_indicators with an asset ticker for the technical read. ${mode} Not financial advice.` });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const args = m.params?.arguments || {};
      const t = toInput(args);
      if (t.error) return err(`bad_request: ${t.error}`);
      const client = await paid(opts);
      const tier = TIER[name];
      if (tier !== 'lite' && (!client || client.error)) return err(`${name} is paid only: set TASIGNAL_X402_PRIVATE_KEY (Base USDC) or call ${API_BASE}/v1/${tier} with any x402 client (${PRICES[tier]}).${client?.error ? ` (${client.error})` : ''}`);
      let fallbackNote = '';
      if (client?.error) fallbackNote = client.error;
      else if (client) {
        try {
          const r = await client.call(tier, { ...args, symbol: t.symbol, timeframe: args.timeframe ?? (tier === 'risk' ? '4h' : t.timeframe) });
          if (r.result && !r.error) return ok({ content: [{ type: 'text', text: summarizePaid(tier, r.result) }], structuredContent: { ...r.result, payer: client.payer, ...(r.paymentResponse ? { payment_response: r.paymentResponse } : {}) }, isError: false });
          if (tier !== 'lite') return err(`${r.error}${r.detail ? `: ${r.detail}` : ''}`);
          fallbackNote = `Paid call failed (${r.error}${r.detail ? `: ${r.detail}` : ''}); showing the free preview.`;
        } catch (e) { if (tier !== 'lite') return err(`paid call failed: ${String(e?.message || e).slice(0, 200)}`); fallbackNote = `Paid call failed (${String(e?.message || e).slice(0, 200)}); showing the free preview.`; }
      }
      const r = await preview(t, { fetchImpl: opts.fetchImpl, apiBase: opts.apiBase || process.env.TASIGNAL_API_URL || API_BASE });
      if (r.error) return err(`${r.error}: ${r.message}${fallbackNote ? ` (${fallbackNote})` : ''}`);
      delete r.full;
      return ok({ content: [{ type: 'text', text: summarizePreview(r, fallbackNote) }], structuredContent: fallbackNote ? { ...r, paid_error: fallbackNote } : r, isError: false });
    }
    default:
      return m.method.startsWith('notifications/') || note ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

export function serve({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (o) => output.write(JSON.stringify(o) + '\n');
  rl.on('line', async (l) => {
    if (!l.trim()) return;
    let msg; try { msg = JSON.parse(l); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map((x) => handle(x)))).filter(Boolean);
    if (replies.length) write(batch ? replies : replies[0]);
  });
  return rl;
}

const self = process.argv[1] || '';
if (import.meta.url === `file://${self}` || /tasignal(-mcp)?$/.test(self)) serve();
