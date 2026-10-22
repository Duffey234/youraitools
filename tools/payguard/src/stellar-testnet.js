// Stellar testnet x402 route (testnet demo / integration target; Base mainnet routes are untouched).
//   GET|POST /stellar-testnet/v1/address?address=   PAID 0.01 XLM on Stellar testnet (x402 v2, exact, stellar:testnet)
// Same OFAC SDN screen as the Base route /v1/address. Uses the official @x402/stellar server scheme and the public
// x402.org facilitator (free, no API key, sponsors the network fee: areFeesSponsored). The asset is the native XLM
// Stellar Asset Contract (SEP-41), so a Friendbot-funded testnet account can pay with no trustline or USDC faucet.
// Separate x402ResourceServer + paymentMiddleware scoped to /stellar-testnet/*; /supported is answered statically.
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { ResilientFacilitatorClient } from './facilitator.js';

export const STELLAR_TESTNET = 'stellar:testnet'; // CAIP-2
export const STELLAR_TESTNET_XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // native XLM SAC (testnet), 7 decimals
export const STELLAR_TESTNET_PREFIX = '/stellar-testnet';
export const STELLAR_TESTNET_ADDRESS_PATH = `${STELLAR_TESTNET_PREFIX}/v1/address`;
export const STELLAR_TESTNET_DEFAULTS = {
  stellarTestnetPayTo: 'GD2I22CZ7K6BJR2JLN54LDM7TSXFSMTDWYFPJECWXZOHK3TFM6PEX44I', // our testnet receiver (key kept offline)
  stellarTestnetFacilitatorUrl: 'https://x402.org/facilitator',
  stellarTestnetAmount: '100000', // 0.01 XLM (stroops)
};

class StaticStellarFacilitatorClient extends ResilientFacilitatorClient {
  staticKinds() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: this.network, extra: { areFeesSponsored: true } }], extensions: [], signers: {} };
  }
}

export function stellarTestnetInfo(cfg, origin) {
  const c = { ...STELLAR_TESTNET_DEFAULTS, ...cfg };
  return {
    methods: ['GET', 'POST'], path: STELLAR_TESTNET_ADDRESS_PATH, url: `${origin}${STELLAR_TESTNET_ADDRESS_PATH}`, param: 'address',
    price: `${Number(c.stellarTestnetAmount) / 1e7} XLM (testnet)`, amount: c.stellarTestnetAmount, network: STELLAR_TESTNET, asset: 'XLM (native Stellar Asset Contract, testnet)', assetAddress: STELLAR_TESTNET_XLM_SAC,
    payTo: c.stellarTestnetPayTo, facilitator: c.stellarTestnetFacilitatorUrl, x402: ['v2'], testnet: true,
    note: 'Stellar testnet test route (no real money). Same result as /v1/address. Fund a testnet account free with Friendbot (https://friendbot.stellar.org/?addr=G...); fees are sponsored by the facilitator.',
  };
}

export function mountStellarTestnet(app, cfg, o) {
  const c = { ...STELLAR_TESTNET_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k.startsWith('stellarTestnet') && v !== undefined)) };
  // Stellar settle waits for ledger close (often 10-20 s), so it gets 30 s (verify 8 s + settle 30 s < 45 s watchdog).
  const facilitatorClient = o.facilitatorClient || new StaticStellarFacilitatorClient({ url: c.stellarTestnetFacilitatorUrl, name: 'x402.org', network: STELLAR_TESTNET, staticSupported: true, settleTimeoutMs: 30000 });
  const server = new x402ResourceServer(facilitatorClient).register(STELLAR_TESTNET, new ExactStellarScheme());
  const resource = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${STELLAR_TESTNET_ADDRESS_PATH}` } : {};
  const route = {
    ...resource,
    accepts: { scheme: 'exact', price: { amount: String(c.stellarTestnetAmount), asset: STELLAR_TESTNET_XLM_SAC }, network: STELLAR_TESTNET, payTo: c.stellarTestnetPayTo, maxTimeoutSeconds: 120 },
    description: 'PayGuard OFAC SDN sanctions screen for one crypto address, paid in Stellar testnet XLM (test route). Same output as the Base mainnet /v1/address.',
    mimeType: 'application/json',
  };
  const routes = { [`GET ${STELLAR_TESTNET_ADDRESS_PATH}`]: route, [`POST ${STELLAR_TESTNET_ADDRESS_PATH}`]: route };
  app.use(STELLAR_TESTNET_ADDRESS_PATH, o.validate);
  app.use(STELLAR_TESTNET_ADDRESS_PATH, paymentMiddleware(routes, server, undefined, undefined, o.syncFacilitatorOnStart ?? true));
  app.on(['GET', 'POST'], STELLAR_TESTNET_ADDRESS_PATH, o.handler);
  return c;
}
