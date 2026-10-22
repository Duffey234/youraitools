// "Agent trust kit" block shared by the agentgate-builder services' landing pages (keep in sync across repos).
export const TRUST_KIT = [
  { name: 'AgentGate', url: 'https://agentgate.agentgate.workers.dev', price: '$0.005', what: 'Is this AI agent who it says it is? Checks the Concordium Agent Registry (CIS-8004): registered, Active, Verified.' },
  { name: 'WebRead', url: 'https://webread.agentgate.workers.dev', price: '$0.002', what: 'Read any public web page as clean Markdown (robots.txt-aware, SSRF-safe).' },
  { name: 'InjectScan', url: 'https://injectscan.agentgate.workers.dev', price: '$0.003', what: 'Scan text, pages and MCP tool definitions for prompt injection before your agent acts on them.' },
  { name: 'DomainCheck', url: 'https://domaincheck.agentgate.workers.dev', price: '$0.002', what: 'Is this domain or email real and trustworthy? DNS, SPF/DMARC, registration age (RDAP), disposable and parked detection, risk score.' },
  { name: 'PayGuard', url: 'https://payguard.agentgate.workers.dev', price: '$0.001', what: 'Is this crypto address on the US Treasury OFAC SDN list? Exact match with entity, program and list date, plus chain and checksum.' },
  { name: 'PkgGuard', url: 'https://pkgguard.agentgate.workers.dev', price: '$0.003', what: 'Is this dependency safe to install? Known vulnerabilities (CVE/GHSA, severity, fixed-in) and confirmed-malicious packages for a manifest or lockfile.' },
  { name: 'StackDetect', url: 'https://stackdetect.agentgate.workers.dev', price: '$0.003', what: 'What is this website built with? CMS, frameworks, hosting/CDN, analytics, payments, plus email and DNS providers from public DNS, with versions and evidence.' },
  { name: 'TokenVerdict', url: 'https://tokenverdict.agentgate.workers.dev', price: '$0.005', what: 'Safety check for a Base ERC-20 token before an agent or app interacts with it. Honeypot sell simulation and taxes, owner powers, proxy, liquidity and LP, holders: SAFE / CAUTION / DANGER with reasons.' },
  { name: 'SignCheck', url: 'https://signcheck.agentgate.workers.dev', price: '$0.005', what: 'Is it safe to sign this? Decodes a transaction, Permit / Permit2 / EIP-3009 signature, EIP-7702 delegation or x402 payment and flags drainer patterns: SAFE / CAUTION / DANGER with reasons.' },
];
export function trustKitHtml(current, esc = (s) => s) {
  const cards = TRUST_KIT.map((t) => `<div class="card"><h3>${t.name === current ? esc(t.name) + ' <span style="color:var(--muted)">(this service)</span>' : `<a href="${esc(t.url)}">${esc(t.name)}</a>`}</h3><p>${esc(t.what)} <b>${t.name === 'TokenVerdict' || t.name === 'SignCheck' ? 'from ' : ''}${esc(t.price)}</b>/call, free tier + remote MCP.</p></div>`).join('');
  return `<h2 id="trust-kit">Agent trust kit</h2>
  <p style="color:var(--muted)">Nine small x402 tools for agents that act on outside input: verify <i>who</i> (AgentGate), read <i>what</i> (WebRead), check it is <i>safe to follow</i> (InjectScan), check the <i>domain or email</i> behind it (DomainCheck), screen the <i>wallet</i> before paying it (PayGuard), check the <i>code</i> before installing it (PkgGuard), see what a <i>website</i> runs on (StackDetect), check a <i>token</i> before interacting with it (TokenVerdict), and check a <i>signature</i> before the wallet signs it (SignCheck). Same wallet-free free tiers, same pay-per-call USDC on Base or Solana (Polygon and Arbitrum One also accepted).</p>
  <div class="grid">${cards}</div>`;
}
