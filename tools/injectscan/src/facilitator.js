// A facilitator client that can't hang the Worker. On Workers, staticSupported=true answers /supported from a
// static list (matching PayAI's) with no I/O: @x402/hono starts its init when the app is built, i.e. inside the
// first request, and if that request finishes first its fetch and timers are orphaned, so every later paid request
// would wait forever on that promise. Otherwise /supported gets a short timeout and the same static fallback.
// verify and settle run inside the paying request and get their own timeouts.
// createAuthHeaders (CDP facilitator) is passed through to HTTPFacilitatorClient; it runs inside verify/settle, so the
// same deadlines cover it. EXTENSION-RESPONSES (e.g. CDP's bazaar indexing status) is logged after verify/settle.
import { HTTPFacilitatorClient } from '@x402/core/server';
import { withDeadline as withTimeout, BUDGET } from './deadline.js';

export class ResilientFacilitatorClient extends HTTPFacilitatorClient {
  constructor({ url, network, kinds, createAuthHeaders, name, supportedTimeoutMs = BUDGET.supportedMs, verifyTimeoutMs = BUDGET.verifyMs, settleTimeoutMs = BUDGET.settleMs, staticSupported = false }) {
    super(createAuthHeaders ? { url, createAuthHeaders } : { url });
    this.name = name || 'payai';
    this.network = network;
    this.kinds = kinds; // static kinds for every enabled network (networks.js supportedKinds); default: just `network`
    this.supportedTimeoutMs = supportedTimeoutMs;
    this.verifyTimeoutMs = verifyTimeoutMs;
    this.settleTimeoutMs = settleTimeoutMs;
    this.staticSupported = staticSupported;
  }
  staticKinds() {
    return { kinds: this.kinds?.length ? this.kinds : [{ x402Version: 2, scheme: 'exact', network: this.network }], extensions: ['bazaar'], signers: {} };
  }
  async getSupported() {
    if (this.staticSupported) return this.staticKinds();
    try { return await withTimeout(super.getSupported(), this.supportedTimeoutMs, 'facilitator /supported'); }
    catch (e) {
      console.warn(`x402: ${e.message}; using static supported kinds`);
      return this.staticKinds();
    }
  }
  verify(payload, requirements) { return withTimeout(super.verify(payload, requirements), this.verifyTimeoutMs, 'facilitator /verify').then((r) => logExtensionResponses(this.name, 'verify', r)); }
  settle(payload, requirements) { return withTimeout(super.settle(payload, requirements), this.settleTimeoutMs, 'facilitator /settle').then((r) => logExtensionResponses(this.name, 'settle', r)); }
}

/** Log the facilitator's decoded EXTENSION-RESPONSES header (HTTPFacilitatorClient puts it on result.extensionResponses). */
export function logExtensionResponses(facilitator, op, result, log = console.log) {
  try { if (result?.extensionResponses) log(`x402 EXTENSION-RESPONSES ${facilitator} ${op}: ${JSON.stringify(result.extensionResponses)}`); } catch { /* logging never breaks a payment */ }
  return result;
}
