// GOAT Network Testnet3 x402 route (testnet demo for the GOAT AI Builder Grant; Base mainnet routes are untouched).
//   GET|POST /goat-testnet3/v1/address?address=   PAID 0.001 test USD on GOAT Testnet3 (x402 v2, exact, eip155:48816)
// Same OFAC SDN screen as the Base route /v1/address. Standard x402 "exact" EVM scheme (EIP-3009
// transferWithAuthorization, @x402/evm ExactEvmScheme) settled by our own small facilitator Worker
// (goat-facilitator.agentgate.workers.dev, source: https://agentgate-source.pages.dev/x402-goat-facilitator/), which pays the testnet BTC gas,
// so payers only need the token. Not a GoatX402 merchant integration. Two accepted assets:
//   1. tUSDC "PayGuard Test USD" (open faucet: faucet() / faucetTo(addr) on the token, 10 tUSDC per address per day)
//   2. GOAT's x402 test USDC 0x29D1...2Fa1 (EIP-3009, "USD Coin" v1), for wallets that already hold it.
// The facilitator is reached through a service binding (GOAT_FACILITATOR) when present, since a Worker can't fetch
// another workers.dev Worker on the same account; otherwise over HTTPS. /supported is answered statically.
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { withDeadline } from './deadline.js';

export const GOAT_TESTNET3 = 'eip155:48816'; // CAIP-2, chain id 48816 (0xBEB0)
export const GOAT_TESTNET3_EXPLORER = 'https://explorer.testnet3.goat.network';
export const GOAT_TESTNET3_RPC = 'https://rpc.testnet3.goat.network';
export const GOAT_TESTNET3_TUSDC = '0x4aa7292d13801011C3A638CA2C16fFa85a06Bc43'; // PayGuard Test USD (tUSDC), 6 decimals
export const GOAT_TESTNET3_USDC = '0x29D1Ee93e9ecf6E50F309f498e40a6b42D352Fa1'; // GOAT x402 test USDC, 6 decimals
export const GOAT_TESTNET3_PREFIX = '/goat-testnet3';
export const GOAT_TESTNET3_ADDRESS_PATH = `${GOAT_TESTNET3_PREFIX}/v1/address`;
export const GOAT_TESTNET3_DEFAULTS = {
  goatTestnet3PayTo: '0x35A4577c2Bd3c6dC283285c879C3E5cfD252C6a1', // our testnet receiver (key kept offline)
  goatTestnet3FacilitatorUrl: 'https://goat-facilitator.agentgate.workers.dev',
  goatTestnet3FacilitatorSigner: '0x7730c7b13e10440dda3A2700845e7cE4dF901df4',
  goatTestnet3Amount: '1000', // 0.001 (6 decimals)
};

/** Minimal x402 facilitator client (verify/settle/getSupported) over a fetch function (service binding or global). */
export class GoatFacilitatorClient {
  constructor({ url, signer, fetcher, verifyTimeoutMs = 10000, settleTimeoutMs = 30000 }) {
    this.url = url.replace(/\/+$/, ''); this.signer = signer; this.fetcher = fetcher || ((req) => fetch(req));
    this.verifyTimeoutMs = verifyTimeoutMs; this.settleTimeoutMs = settleTimeoutMs;
  }
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: GOAT_TESTNET3 }], extensions: [], signers: { 'eip155:*': [this.signer] } };
  }
  async post(op, paymentPayload, paymentRequirements, ms) {
    const req = new Request(`${this.url}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }) });
    const res = await withDeadline(this.fetcher(req), ms, `goat facilitator /${op}`);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { throw new Error(`goat facilitator /${op} ${res.status}: ${text.slice(0, 200)}`); }
    if (!res.ok && !(op === 'verify' ? 'isValid' in data : 'success' in data)) throw new Error(`goat facilitator /${op} ${res.status}: ${text.slice(0, 200)}`);
    return data;
  }
  verify(p, r) { return this.post('verify', p, r, this.verifyTimeoutMs); }
  settle(p, r) { return this.post('settle', p, r, this.settleTimeoutMs); }
}

export function goatTestnet3Info(cfg, origin) {
  const c = { ...GOAT_TESTNET3_DEFAULTS, ...cfg };
  return {
    methods: ['GET', 'POST'], path: GOAT_TESTNET3_ADDRESS_PATH, url: `${origin}${GOAT_TESTNET3_ADDRESS_PATH}`, param: 'address',
    price: `${Number(c.goatTestnet3Amount) / 1e6} tUSDC or USDC (GOAT Testnet3)`, amount: c.goatTestnet3Amount, network: GOAT_TESTNET3, chainId: 48816,
    asset: 'tUSDC (PayGuard Test USD, EIP-3009) or GOAT x402 test USDC', assetAddress: GOAT_TESTNET3_TUSDC, assetAddresses: [GOAT_TESTNET3_TUSDC, GOAT_TESTNET3_USDC],
    payTo: c.goatTestnet3PayTo, facilitator: c.goatTestnet3FacilitatorUrl, x402: ['v2'], testnet: true, explorer: GOAT_TESTNET3_EXPLORER,
    note: 'GOAT Network Testnet3 test route (no real money). Same result as /v1/address. Get tUSDC from the token\'s open faucet (faucet() or faucetTo(address), 10 tUSDC/day); no gas needed to pay, our facilitator pays the testnet BTC gas.',
  };
}

export function mountGoatTestnet3(app, cfg, o) {
  const c = { ...GOAT_TESTNET3_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k.startsWith('goatTestnet3') && v !== undefined)) };
  const facilitatorClient = o.facilitatorClient || new GoatFacilitatorClient({ url: c.goatTestnet3FacilitatorUrl, signer: c.goatTestnet3FacilitatorSigner, fetcher: c.goatTestnet3Fetcher });
  const server = new x402ResourceServer(facilitatorClient).register(GOAT_TESTNET3, new ExactEvmScheme());
  const resource = cfg.publicUrl ? { resource: `${cfg.publicUrl.replace(/\/$/, '')}${GOAT_TESTNET3_ADDRESS_PATH}` } : {};
  const accept = (asset, name) => ({ scheme: 'exact', price: { amount: String(c.goatTestnet3Amount), asset, extra: { name, version: '1' } }, network: GOAT_TESTNET3, payTo: c.goatTestnet3PayTo, maxTimeoutSeconds: 120 });
  const route = {
    ...resource,
    accepts: [accept(GOAT_TESTNET3_TUSDC, 'PayGuard Test USD'), accept(GOAT_TESTNET3_USDC, 'USD Coin')],
    description: 'PayGuard OFAC SDN sanctions screen for one crypto address, paid on GOAT Network Testnet3 (test route). Same output as the Base mainnet /v1/address.',
    mimeType: 'application/json',
  };
  const routes = { [`GET ${GOAT_TESTNET3_ADDRESS_PATH}`]: route, [`POST ${GOAT_TESTNET3_ADDRESS_PATH}`]: route };
  app.use(GOAT_TESTNET3_ADDRESS_PATH, o.validate);
  app.use(GOAT_TESTNET3_ADDRESS_PATH, paymentMiddleware(routes, server, undefined, undefined, o.syncFacilitatorOnStart ?? true));
  app.on(['GET', 'POST'], GOAT_TESTNET3_ADDRESS_PATH, o.handler);
  return c;
}
