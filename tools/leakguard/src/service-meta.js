// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon). Category/categories only appear in /openapi.json and /.well-known/x402.
export const SERVICE_META = {
  serviceName: 'LeakGuard by AgentGate',
  tags: ['secret-scanning', 'pii-redaction', 'seed-phrase', 'dlp', 'scan_for_leaks'],
  iconUrl: 'https://agentgate-source.pages.dev/icons/leakguard.png',
  category: 'security',
  categories: ['security', 'privacy', 'ai-agents', 'crypto'],
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
