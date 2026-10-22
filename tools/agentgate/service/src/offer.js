// LAX registry offer (https://lax.kognai.ai/aiax/sections/lax_offer.json) for the AgentGate paid endpoint.
import { NETWORKS } from '../../src/registry.js';
export const FIVE_LAWS = ['Solidarity Oath', 'Renewal Mandate', 'Treasury Equilibrium', 'Harm Shield', 'Transparency Covenant'];

export function laxOffer({ baseUrl, price = '$0.005' }) {
  const amount = String(price).replace(/^\$/, '');
  return {
    lax_version: '1.0',
    name: 'AgentGate',
    description: 'Checks whether an AI agent is registered in the Concordium Agent Registry (CIS-8004, ERC-8004 compatible), Active, and Verified by Concordium (its Agent Card hash matches the on-chain record). Pay per call in USDC on Base over x402. Refuses: anything other than public registry lookups; it never asks for keys.',
    category: 'Agent identity',
    endpoint: `${baseUrl}/v1/check-agent`,
    capabilities: [{
      skill_id: 'check_agent',
      description: 'Concordium Agent Registry verdict for one badge or owner account',
      pricing: { model: 'per_call', amount, currency: 'USDC', rail: 'x402' },
      input_schema: { type: 'object', properties: { id: { type: 'string' }, network: { type: 'string', enum: NETWORKS } }, required: ['id'] },
      output_schema: { type: 'object', properties: { verified: { type: 'boolean' }, found: { type: 'boolean' }, active: { type: 'boolean' }, cardHashMatches: { type: ['boolean', 'null'] }, tokenAddress: { type: ['string', 'null'] }, owner: { type: ['string', 'null'] }, issues: { type: 'array' } }, required: ['verified', 'found', 'active'] },
    }],
    constitutional_constraints: FIVE_LAWS,
    payment_rails: ['x402', 'usdc-base'],
  };
}
