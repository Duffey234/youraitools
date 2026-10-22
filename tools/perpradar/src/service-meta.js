// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon). Category/categories only appear in /openapi.json and /.well-known/x402.
export const SERVICE_META = {
  serviceName: 'PerpRadar by AgentGate',
  tags: ['funding-rates', 'perps', 'open-interest', 'trading', 'market-data'],
  iconUrl: 'https://agentgate-source.pages.dev/icons/perpradar.png',
  category: 'trading',
  categories: ['trading', 'market-data', 'defi', 'crypto'],
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
