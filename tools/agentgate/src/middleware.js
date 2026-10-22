// Express-style (req, res, next) middleware that only lets registered, Active,
// Verified-by-Concordium agents reach the wrapped route. Mount it BEFORE your x402
// payment middleware so unverified agents are rejected before they are asked to pay.
//
//   app.get('/paid', agentGate({ network: 'testnet' }), paymentMiddleware(...), handler)

import { ConcordiumPublicProvider, CachedProvider } from './registry.js';
import { getHeader, readPaymentPayload, payerOf } from './x402.js';

export const AGENT_HEADER = 'X-Agent-Badge';

/**
 * @param {Object} [opts]
 * @param {'mainnet'|'testnet'|'devnet'} [opts.network='mainnet']
 * @param {{check:Function, name:string}} [opts.provider]  defaults to cached ConcordiumPublicProvider
 * @param {string} [opts.header='X-Agent-Badge']  request header carrying the agent's badge (CIS-2 token address) or owner account
 * @param {boolean} [opts.requireCardMatch=true]  require Agent Card hash == on-chain metadata_hash
 * @param {boolean} [opts.bindPayer=false]  if an x402 payment is attached, require its payer to be the agent's wallet or owner
 * @param {boolean} [opts.failOpen=false]   on registry outage, let requests through (default: fail closed with 503)
 * @param {(req:any, result:any)=>boolean|Promise<boolean>} [opts.policy]  extra custom policy
 */
export function agentGate(opts = {}) {
  const network = opts.network || 'mainnet';
  const header = opts.header || AGENT_HEADER;
  const requireCardMatch = opts.requireCardMatch ?? true;
  const provider = opts.provider || new CachedProvider(new ConcordiumPublicProvider(), { ttlMs: 60000 });

  return async function agentGateMiddleware(req, res, next) {
    const id = getHeader(req, header);
    if (!id) {
      return deny(res, 401, 'agent_badge_required', `Send your Verified by Concordium badge (CIS-2 token address) in the ${header} header.`, { header, network });
    }
    let result;
    try {
      result = await provider.check(String(id), { network });
    } catch (e) {
      if (opts.failOpen) { req.agentGate = { error: e.message, failOpen: true }; return next(); }
      return deny(res, 503, 'registry_unavailable', `Could not reach the Concordium Agent Registry: ${e.message}`);
    }
    req.agentGate = result;
    if (!result.found) return deny(res, 403, 'agent_not_registered', 'No CIS-8004 Agent Registry record for this badge/account.', { result });
    if (!result.active) return deny(res, 403, 'agent_not_active', 'Agent registration is not Active (revoked).', { result });
    if (requireCardMatch && result.cardHashMatches === false) return deny(res, 403, 'agent_card_mismatch', 'Agent Card does not match the hash committed on-chain.', { result });

    if (opts.bindPayer) {
      const payer = payerOf(readPaymentPayload(req));
      if (payer && ![result.agentWallet, result.owner].filter(Boolean).includes(payer)) {
        return deny(res, 403, 'payer_not_bound', 'x402 payer is not the agent wallet or owner recorded on-chain.', { payer, result });
      }
    }
    if (opts.policy && !(await opts.policy(req, result))) return deny(res, 403, 'policy_denied', 'Custom policy rejected this agent.', { result });

    if (typeof res.setHeader === 'function') res.setHeader('X-AgentGate', `verified; network=${network}; source=${result.source}${result.mock ? '; MOCK' : ''}`);
    return next();
  };
}

function deny(res, status, error, message, extra = {}) {
  const body = { error, message, ...extra };
  if (typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
