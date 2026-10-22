// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon). Category/categories only appear in /openapi.json and /.well-known/x402.
export const SERVICE_META = {
  serviceName: 'x402fix by AgentGate',
  tags: ['developer-tools', 'x402', 'lint', 'bazaar', 'check_x402_endpoint'],
  iconUrl: 'https://agentgate-source.pages.dev/icons/x402fix.png',
  category: 'developer-tools',
  categories: ['developer-tools', 'payments', 'x402', 'testing'],
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
