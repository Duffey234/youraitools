// Record example outputs for the Bazaar discovery declaration, OpenAPI and landing page from real engine runs.
//   node tools/gen-examples.mjs   (writes src/examples.js)
import { writeFileSync } from 'node:fs';
import { taLite, taRisk, taBacktest, parseStrategy, parseRisk, DISCLAIMER } from '../src/engine.js';
const lite = { ...(await taLite('BTC', '1h')), tier: 'lite', disclaimer: DISCLAIMER };
const risk = { ...(await taRisk('ETH', '4h', parseRisk({ account_usd: 10000, risk_pct: 1, side: 'long' }))), tier: 'risk', disclaimer: DISCLAIMER };
const bt = { ...(await taBacktest('SOL', '4h', parseStrategy({ strategy: 'ema_cross', fast: 20, slow: 50 }))), tier: 'backtest', disclaimer: DISCLAIMER };
bt.result.last_trades = bt.result.last_trades.slice(-2); bt.result.equity_curve = bt.result.equity_curve.filter((_, i, a) => i % 10 === 0 || i === a.length - 1);
writeFileSync(new URL('../src/examples.js', import.meta.url), `// Example outputs for the Bazaar discovery declaration, OpenAPI and landing page (recorded ${lite.checked_at}; trimmed lists).\nexport const LITE_EXAMPLE = ${JSON.stringify(lite)};\nexport const RISK_EXAMPLE = ${JSON.stringify(risk)};\nexport const BACKTEST_EXAMPLE = ${JSON.stringify(bt)};\n`);
console.log(lite.sources_failed, risk.sources_failed, bt.sources_failed, JSON.stringify(lite).length, JSON.stringify(risk).length, JSON.stringify(bt).length);
