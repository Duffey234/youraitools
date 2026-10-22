// Listing metadata for x402 Bazaar / Agentic.Market (resource.serviceName, resource.tags, resource.iconUrl: at most 32 printable
// ASCII chars, at most 5 tags, absolute https icon; facilitators soft-drop invalid values). The x402 spec has no category field:
// Agentic.Market assigns categories editorially, so `category` / `categories` are only published in /openapi.json and
// /.well-known/x402 (and the category is the first tag, which the Bazaar search does index).
export const SERVICE_META = {
 "serviceName": "WebRead by AgentGate",
 "tags": [
  "data",
  "web",
  "scraping",
  "markdown",
  "llm"
 ],
 "iconUrl": "https://agentgate-source.pages.dev/icons/webread.png",
 "category": "data",
 "categories": [
  "data",
  "web"
 ]
};
export const ROUTE_META = { serviceName: SERVICE_META.serviceName, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl };
