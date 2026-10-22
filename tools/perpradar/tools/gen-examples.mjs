// Record example outputs for the Bazaar discovery declaration, OpenAPI and landing page from real engine runs.
//   node tools/gen-examples.mjs   (writes src/examples.js)
import { writeFileSync } from 'node:fs';
import { perpSnapshot, perpFull, perpScan, DISCLAIMER } from '../src/engine.js';
const lite0 = await perpSnapshot('BTC');
const lite = { symbol: lite0.symbol, venues_ok: lite0.venues_ok, funding: lite0.funding, open_interest_usd_total: lite0.open_interest_usd_total, positioning: lite0.positioning, positioning_note: lite0.positioning_note,
  venues: lite0.venues.slice(0, 2).map((v) => ({ venue: v.venue, market: v.market, funding_8h_pct: v.funding_8h_pct, funding_apr_pct: v.funding_apr_pct, funding_interval_hours: v.funding_interval_hours, open_interest_usd: v.open_interest_usd })),
  confidence: lite0.confidence, sources_failed: lite0.sources_failed, checked_at: lite0.checked_at, tier: 'lite', disclaimer: DISCLAIMER };
const full = { ...(await perpFull('ETH')), tier: 'full', disclaimer: DISCLAIMER };
full.venues = full.venues.slice(0, 2); full.carry = full.carry.slice(0, 2);
const scan = { ...(await perpScan({ limit: 3 })), tier: 'scan', disclaimer: DISCLAIMER };
for (const k of ['highest_funding', 'lowest_funding', 'widest_spreads']) scan[k] = scan[k].slice(0, 2);
writeFileSync(new URL('../src/examples.js', import.meta.url), `// Example outputs for the Bazaar discovery declaration, OpenAPI and landing page (recorded ${lite0.checked_at}; trimmed lists).\nexport const LITE_EXAMPLE = ${JSON.stringify(lite)};\nexport const FULL_EXAMPLE = ${JSON.stringify(full)};\nexport const SCAN_EXAMPLE = ${JSON.stringify(scan)};\n`);
console.log(lite0.sources_failed, full.sources_failed, scan.sources_failed, JSON.stringify(lite).length, JSON.stringify(full).length, JSON.stringify(scan).length);
