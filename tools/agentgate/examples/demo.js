// Runnable demo: an Express API with one paid route gated by AgentGate.
//   npm run demo        -> offline, MockProvider + mock paywall (no network, no funds)
//   npm run demo:live   -> real Concordium mainnet registry lookups via the public badge-check API
//                          (payment step is still the MOCK paywall; no funds are moved)
import express from 'express';
import { agentGate, MockProvider, ConcordiumPublicProvider, encodeHeader, decodeHeader } from '../src/index.js';
import { mockPaywall } from './mock-paywall.js';

const live = process.argv.includes('--live');
const provider = live ? new ConcordiumPublicProvider() : new MockProvider();
const network = live ? 'mainnet' : 'testnet';

export function createApp() {
  const app = express();
  app.get('/free', (_req, res) => res.json({ ok: true }));
  app.get('/paid/quote', agentGate({ provider, network, bindPayer: !live }), mockPaywall(), (req, res) => {
    res.json({ quote: 'CCD/EUR 0.0123 (demo data)', servedTo: req.agentGate.tokenAddress, source: req.agentGate.source });
  });
  return app;
}

async function main() {
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const good = live ? 'Mf22soLh1NuZYFgBK8iSs' : 'MockVerifiedAgent1111'; // live: a real public mainnet agent (TippingService)
  const bad = live ? '4DDvjwdcLmTy1Ar9FCKKPMiABrS261TvyXJGr4n4ypuuogXeFX' : 'MockRevokedAgent22222';
  console.log(`AgentGate demo (${live ? 'LIVE Concordium mainnet registry' : 'MOCK provider, offline'}) on ${base}\n`);

  const show = async (label, headers = {}) => {
    const r = await fetch(`${base}/paid/quote`, { headers });
    const body = await r.json();
    console.log(`- ${label}\n  -> HTTP ${r.status} ${body.error || ''}${body.quote ? ' ' + JSON.stringify(body) : ''}`);
    return r;
  };
  await show('no badge header');
  await show(`unregistered/revoked agent (${bad})`, { 'X-Agent-Badge': bad });
  const r402 = await show(`verified agent (${good}), no payment yet`, { 'X-Agent-Badge': good });
  const reqs = decodeHeader(r402.headers.get('PAYMENT-REQUIRED'));
  if (reqs) {
    const accepted = reqs.accepts[0];
    const payer = live ? undefined : 'MOCK-WALLET-1';
    const sig = encodeHeader({ x402Version: 2, accepted, payload: { payer, mock: true } });
    await show(`verified agent pays (MOCK payment)`, { 'X-Agent-Badge': good, 'PAYMENT-SIGNATURE': sig });
  }
  server.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
