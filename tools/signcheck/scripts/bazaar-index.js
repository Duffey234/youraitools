#!/usr/bin/env node
// Get the deployed endpoint catalogued in the PayAI Bazaar (same flow as PayGuard).
//
//   PAYER_PRIVATE_KEY=0x... node scripts/bazaar-index.js https://<host>/v1/check [--settle]
//
// Default (verify-only): fetch the live 402, build a signed x402 payment with the official client
// (which echoes the bazaar declaration), and POST it to the facilitator's /verify. /verify moves no
// funds; PayAI catalogs on /verify for GET resources that answer 402 unpaid.
// --settle: make one real paid call ($0.015 USDC) through @x402/fetch instead (needs USDC on Base).
// The key is read from the environment and is never printed.
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const url = process.argv[2];
const settle = process.argv.includes('--settle');
const facilitator = process.env.FACILITATOR_URL || 'https://facilitator.payai.network';
if (!url || !process.env.PAYER_PRIVATE_KEY) { console.error('usage: PAYER_PRIVATE_KEY=... node scripts/bazaar-index.js <paid url> [--settle]'); process.exit(2); }
const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);
const probe = `${url}${url.includes('?') ? '&' : '?'}chain=base&to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&data=0x&from=0xE35E10429048b6F3409b0307E65e4797477Ed144`;

if (settle) {
  const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }] });
  const r = await pay(probe);
  console.log('paid call:', r.status, r.headers.get('PAYMENT-RESPONSE') ? 'PAYMENT-RESPONSE present' : 'no PAYMENT-RESPONSE');
  console.log((await r.text()).slice(0, 300));
} else {
  const r402 = await fetch(probe, { headers: { 'x-signcheck-smoke': '1' } }); // operator check: excluded from usage stats
  if (r402.status !== 402) { console.error('expected 402, got', r402.status); process.exit(1); }
  const required = JSON.parse(Buffer.from(r402.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));
  const client = new x402Client().register('eip155:8453', new ExactEvmScheme(account));
  const paymentPayload = await client.createPaymentPayload(required);
  const res = await fetch(`${facilitator}/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: paymentPayload.accepted || required.accepts[0] }),
  });
  const ext = res.headers.get('EXTENSION-RESPONSES');
  console.log('/verify HTTP', res.status, JSON.stringify(await res.json()).slice(0, 300));
  console.log('EXTENSION-RESPONSES', ext ? Buffer.from(ext, 'base64').toString('utf8') : '(none)');
}
const status = await fetch(`${facilitator}/discovery/listing-status?resource=${encodeURIComponent(url.split('?')[0])}`);
console.log('listing-status', status.status, (await status.text()).slice(0, 400));
