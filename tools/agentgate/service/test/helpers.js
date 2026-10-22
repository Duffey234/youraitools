import { createApp } from '../src/app.js';
import { MockProvider } from '../../src/registry.js';

export const PAY_TO = '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F';
export const NETWORK = 'eip155:8453';

/** In-memory facilitator implementing the @x402/core FacilitatorClient interface. No network, no funds. */
export function fakeFacilitator({ verifyOk = true, settleOk = true } = {}) {
  const f = {
    verified: [], settled: [],
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: ['bazaar'], signers: {} };
    },
    async verify(payload, req) {
      f.verified.push({ payload, req });
      const auth = payload?.payload?.authorization;
      const ok = verifyOk && auth && auth.to?.toLowerCase() === req.payTo.toLowerCase() && String(auth.value) === String(req.amount);
      return ok ? { isValid: true, payer: auth.from } : { isValid: false, invalidReason: 'fake_invalid' };
    },
    async settle(payload, req) {
      f.settled.push({ payload, req });
      return settleOk
        ? { success: true, transaction: '0x' + 'ab'.repeat(32), network: req.network, payer: payload.payload.authorization.from }
        : { success: false, errorReason: 'fake_settle_failed', transaction: '', network: req.network };
    },
  };
  return f;
}

export function makeApp({ facilitator = fakeFacilitator(), provider = new MockProvider(), appOpts = {} } = {}) {
  const app = createApp({ facilitatorClient: facilitator, provider, payTo: PAY_TO, network: NETWORK, price: '$0.005', publicUrl: 'https://agentgate.example.com', ...appOpts });
  // Route all fetches (including the paying client's) into the Hono app.
  const fetchApp = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return { app, facilitator, provider, fetchApp };
}
