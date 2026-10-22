// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon). Categories are only published in /openapi.json and /.well-known/x402.
export const SERVICE_META = {
  serviceName: 'SignCheck by AgentGate',
  tags: ['security', 'wallet-security', 'transaction-simulation', 'eip-712', 'check_signature'],
  iconUrl: 'https://agentgate-source.pages.dev/icons/signcheck.png',
  category: 'security',
  categories: ['security', 'wallets', 'developer-tools', 'payments'],
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
