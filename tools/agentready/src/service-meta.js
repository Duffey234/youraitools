// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon). Category/categories only appear in /openapi.json and /.well-known/x402.
export const SERVICE_META = {
  serviceName: 'AgentReady by AgentGate',
  tags: ['agent-readiness', 'seo', 'llms-txt', 'site-audit', 'audit_website'],
  iconUrl: 'https://agentgate-source.pages.dev/icons/agentready.png',
  category: 'developer-tools',
  categories: ['developer-tools', 'seo', 'ai-agents', 'web'],
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
