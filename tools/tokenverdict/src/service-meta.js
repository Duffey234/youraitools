// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon). Category/categories only appear in /openapi.json and /.well-known/x402.
export const SERVICE_META = {
  serviceName: 'TokenVerdict by AgentGate',
  tags: ['crypto', 'token-security', 'honeypot', 'base', 'check_token'],
  iconUrl: 'https://agentgate-source.pages.dev/icons/tokenverdict.png',
  category: 'crypto',
  categories: ['crypto', 'security', 'defi', 'trading'],
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
