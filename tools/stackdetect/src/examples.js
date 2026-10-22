// Example inputs/outputs used in the Bazaar discovery declaration, OpenAPI and landing page.
export const EXAMPLE_URL = 'https://laravel.com';
export const DETECT_EXAMPLE = {
  tier: 'full', url: 'https://laravel.com/', final_url: 'https://laravel.com/', http_status: 200, content_type: 'text/html', title: 'Laravel - The PHP Framework For Web Artisans',
  technology_count: 3,
  technologies: [
    { name: 'Cloudflare', categories: ['cdn', 'waf'], version: null, confidence: 100, evidence: [{ type: 'header', value: 'server: cloudflare' }] },
    { name: 'Laravel', categories: ['web-framework'], version: null, confidence: 85, evidence: [{ type: 'cookie', value: 'laravel_session' }] },
    { name: 'Google Workspace', categories: ['email-provider'], version: null, confidence: 95, evidence: [{ type: 'mx', value: 'aspmx.l.google.com' }] },
  ],
  categories: { cdn: ['Cloudflare'], waf: ['Cloudflare'], 'web-framework': ['Laravel'], 'email-provider': ['Google Workspace'] },
  providers: { email: ['Google Workspace'], email_delivery: [], dns: ['Cloudflare DNS'], hosting: ['Cloudflare'], verified_saas: [] },
  engine: 'stackdetect-0.1', disclaimer: 'Informational: technologies inferred from public signals of one page load and public DNS.',
};
export const PREVIEW_EXAMPLE = { tier: 'preview', url: 'https://laravel.com/', http_status: 200, technology_count: 12, technologies: ['Cloudflare', 'Laravel', 'Tailwind CSS', 'Vue.js', 'Algolia'], categories: { 'web-framework': ['Laravel'] } };
