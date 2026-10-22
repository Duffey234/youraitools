// Solana devnet x402 route (testnet demo / integration target; Base mainnet routes are untouched).
//   GET|POST /solana-devnet/v1/address?address=   PAID $0.001 devnet USDC (x402 v2, exact, solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)
// Same OFAC SDN screen as the Base route /v1/address. Settled by the public x402.org facilitator (free, no API key;
// it is the Solana fee payer, so payers need devnet USDC but no SOL). This is a separate x402ResourceServer +
// paymentMiddleware scoped to /solana-devnet/*, so the Base 402 terms, CDP facilitator and Bazaar listing never change.
// /supported is answered statically (no I/O on the 402 path, see facilitator.js); the facilitator's Solana fee-payer
// address comes from SOLANA_DEVNET_FEE_PAYER (checked against https://x402.org/facilitator/supported by
// scripts/solana-devnet-pay.mjs before every test payment).
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { ResilientFacilitatorClient } from './facilitator.js';

export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // CAIP-2 (v1 name: solana-devnet)
export const SOLANA_DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // Circle devnet USDC, 6 decimals
export const SOLANA_DEVNET_PREFIX = '/solana-devnet';
export const SOLANA_DEVNET_ADDRESS_PATH = `${SOLANA_DEVNET_PREFIX}/v1/address`;
export const SOLANA_DEVNET_DEFAULTS = {
  solanaDevnetPayTo: 'DmeY2NNcgbgSd2S7HTipepnCnFsfF6bhmBEms3ctknkq',     // our devnet receiver (key kept offline)
  solanaDevnetFacilitatorUrl: 'https://x402.org/facilitator',
  solanaDevnetFeePayer: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5',  // x402.org facilitator's Solana fee payer
  solanaDevnetPrice: '$0.001',
};

class StaticSvmFacilitatorClient extends ResilientFacilitatorClient {
  constructor(o) { super(o); this.feePayer = o.feePayer; }
  staticKinds() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: this.network, extra: { feePayer: this.feePayer } }], extensions: [], signers: { 'solana:*': [this.feePayer] } };
  }
}

export function solanaDevnetInfo(cfg, origin) {
  return {
    methods: ['GET', 'POST'], path: SOLANA_DEVNET_ADDRESS_PATH, url: `${origin}${SOLANA_DEVNET_ADDRESS_PATH}`, param: 'address',
    price: cfg.solanaDevnetPrice, network: SOLANA_DEVNET, networkV1Name: 'solana-devnet', asset: 'USDC (devnet)', assetAddress: SOLANA_DEVNET_USDC,
    payTo: cfg.solanaDevnetPayTo, facilitator: cfg.solanaDevnetFacilitatorUrl, x402: ['v2'], testnet: true,
    note: 'Solana devnet test route (no real money). Same result as /v1/address. Devnet USDC: https://faucet.circle.com (Solana Devnet); no SOL needed, the facilitator pays the fee.',
  };
}

/**
 * Mount the Solana devnet paid route on `app`.
 * @param {import('hono').Hono} app
 * @param {object} cfg merged config (solanaDevnet* keys, publicUrl)
 * @param {{facilitatorClient?: any, validate: Function, handler: Function, syncFacilitatorOnStart?: boolean}} o
 */
export function mountSolanaDevnet(app, cfg, o) {
  const c = { ...SOLANA_DEVNET_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k.startsWith('solanaDevnet') && v !== undefined)) };
  const facilitatorClient = o.facilitatorClient || new StaticSvmFacilitatorClient({
    url: c.solanaDevnetFacilitatorUrl, name: 'x402.org', network: SOLANA_DEVNET, feePayer: c.solanaDevnetFeePayer, staticSupported: true, settleTimeoutMs: 30000,
  });
  const server = new x402ResourceServer(facilitatorClient).register(SOLANA_DEVNET, new ExactSvmScheme());
  const resource = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${SOLANA_DEVNET_ADDRESS_PATH}` } : {};
  const route = {
    ...resource,
    accepts: { scheme: 'exact', price: { amount: String(Math.round(Number(String(c.solanaDevnetPrice).replace('$', '')) * 1e6)), asset: SOLANA_DEVNET_USDC }, network: SOLANA_DEVNET, payTo: c.solanaDevnetPayTo, maxTimeoutSeconds: 120 },
    description: 'PayGuard OFAC SDN sanctions screen for one crypto address, paid in Solana devnet USDC (test route). Same output as the Base mainnet /v1/address.',
    mimeType: 'application/json',
  };
  const routes = { [`GET ${SOLANA_DEVNET_ADDRESS_PATH}`]: route, [`POST ${SOLANA_DEVNET_ADDRESS_PATH}`]: route };
  app.use(SOLANA_DEVNET_ADDRESS_PATH, o.validate);
  app.use(SOLANA_DEVNET_ADDRESS_PATH, paymentMiddleware(routes, server, undefined, undefined, o.syncFacilitatorOnStart ?? true));
  app.on(['GET', 'POST'], SOLANA_DEVNET_ADDRESS_PATH, o.handler);
  return c;
}
