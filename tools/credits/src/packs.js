// Pack catalogue and the price list of the tools that accept credits. Amounts are atomic USDC (6 decimals).
export const PACKS = {
  sample: { id: 'sample', price: '$0.005', paid: 5000, credit: 5000, bonus: 0, label: 'Sample pack: $0.005 of credits (try the flow end to end)' },
  1: { id: '1', price: '$1', paid: 1000000, credit: 1000000, bonus: 0, label: '$1 pack: $1.00 of credits' },
  5: { id: '5', price: '$5', paid: 5000000, credit: 5500000, bonus: 500000, label: '$5 pack: $5.50 of credits (10% bonus)' },
};
export const TOPUPS = { 1: PACKS[1], 5: PACKS[5] };

// Paid routes that accept a credits key (price = the route's x402 price; checked against the live 402s 2026-10-22).
export const TOOL_ROUTES = [
  { tool: 'agentgate', name: 'AgentGate', route: 'GET /v1/check-agent', amount: 5000, what: 'AI agent registry check (Concordium)' },
  { tool: 'webread', name: 'WebRead', route: 'GET /v1/read', amount: 2000, what: 'web page to clean Markdown' },
  { tool: 'injectscan', name: 'InjectScan', route: 'GET|POST /v1/scan', amount: 3000, what: 'prompt-injection scan' },
  { tool: 'domaincheck', name: 'DomainCheck', route: 'GET|POST /v1/domain', amount: 2000, what: 'domain trust check' },
  { tool: 'domaincheck', name: 'DomainCheck', route: 'GET|POST /v1/email', amount: 1000, what: 'email address check' },
  { tool: 'payguard', name: 'PayGuard', route: 'GET|POST /v1/address', amount: 1000, what: 'OFAC SDN address screen' },
  { tool: 'payguard', name: 'PayGuard', route: 'POST /v1/batch', amount: 10000, what: 'OFAC screen, up to 50 addresses' },
  { tool: 'pkgguard', name: 'PkgGuard', route: 'GET|POST /v1/package', amount: 1000, what: 'one package vulnerability check' },
  { tool: 'pkgguard', name: 'PkgGuard', route: 'POST /v1/scan', amount: 3000, what: 'manifest / lockfile scan' },
  { tool: 'stackdetect', name: 'StackDetect', route: 'GET|POST /v1/detect', amount: 3000, what: 'website tech stack' },
  { tool: 'tokenverdict', name: 'TokenVerdict', route: 'GET|POST /v1/lite', amount: 5000, what: 'Base token safety check (lite)' },
  { tool: 'tokenverdict', name: 'TokenVerdict', route: 'GET|POST /v1/quick', amount: 15000, what: 'Base token safety check (quick)' },
  { tool: 'tokenverdict', name: 'TokenVerdict', route: 'GET|POST /v1/deep', amount: 50000, what: 'Base token safety check (deep)' },
  { tool: 'signcheck', name: 'SignCheck', route: 'GET|POST /v1/lite', amount: 5000, what: 'pre-sign check (offline)' },
  { tool: 'signcheck', name: 'SignCheck', route: 'GET|POST /v1/check', amount: 15000, what: 'pre-sign check with simulation' },
  { tool: 'counterpartycheck', name: 'CounterpartyCheck', route: 'GET|POST /v1/lite', amount: 5000, what: 'pre-payment address check (lite)' },
  { tool: 'counterpartycheck', name: 'CounterpartyCheck', route: 'GET|POST /v1/quick', amount: 15000, what: 'pre-payment address check (quick)' },
  { tool: 'counterpartycheck', name: 'CounterpartyCheck', route: 'GET|POST /v1/full', amount: 50000, what: 'pre-payment address check (full)' },
  { tool: 'x402fix', name: 'x402fix', route: 'GET|POST /v1/lite', amount: 5000, what: 'x402 endpoint check + fix list' },
  { tool: 'x402fix', name: 'x402fix', route: 'GET|POST /v1/check', amount: 20000, what: 'x402 endpoint check + CDP verdict + generated fixes' },
  { tool: 'x402fix', name: 'x402fix', route: 'GET|POST /v1/site', amount: 50000, what: 'x402 check of a whole origin (up to 8 routes)' },
  { tool: 'solverdict', name: 'SolVerdict', route: 'GET|POST /v1/lite', amount: 5000, what: 'Solana token safety check (lite)' },
  { tool: 'solverdict', name: 'SolVerdict', route: 'GET|POST /v1/check', amount: 20000, what: 'Solana token safety check (full report)' },
  { tool: 'agentready', name: 'AgentReady', route: 'GET|POST /v1/lite', amount: 5000, what: 'Website AI-agent readiness audit (lite: score, grade, top fixes)' },
  { tool: 'agentready', name: 'AgentReady', route: 'GET|POST /v1/audit', amount: 30000, what: 'Website AI-agent readiness audit (full: every check, fixes, snippets)' },
  { tool: 'leakguard', name: 'LeakGuard', route: 'GET|POST /v1/lite', amount: 5000, what: 'Find and redact leaked secrets, wallet keys and PII in text (lite)' },
  { tool: 'leakguard', name: 'LeakGuard', route: 'GET|POST /v1/scan', amount: 20000, what: 'Deep leak scan: JSON payloads + live balances of wallets whose keys leaked' },
  { tool: 'perpradar', name: 'PerpRadar', route: 'GET|POST /v1/lite', amount: 5000, what: 'Perp funding snapshot for one asset across onchain perp venues (lite; read-only analytics, not financial advice)' },
  { tool: 'perpradar', name: 'PerpRadar', route: 'GET|POST /v1/full', amount: 30000, what: 'Perp funding history, basis and positioning for one asset (full; read-only analytics, not financial advice)' },
  { tool: 'perpradar', name: 'PerpRadar', route: 'GET|POST /v1/scan', amount: 20000, what: 'Perp funding scan across many assets, ranked extremes (read-only analytics, not financial advice)' },
  { tool: 'tasignal', name: 'TASignal', route: 'GET|POST /v1/lite', amount: 5000, what: 'Technical indicators and descriptive bias for one asset (lite; not financial advice)' },
  { tool: 'tasignal', name: 'TASignal', route: 'GET|POST /v1/risk', amount: 20000, what: 'Risk metrics and ATR position sizing for one asset (simulation; not financial advice)' },
  { tool: 'tasignal', name: 'TASignal', route: 'GET|POST /v1/backtest', amount: 50000, what: 'Rule backtest on public candles (simulation; past performance does not guarantee future results)' },
];
export const API_BASE = 'https://api.youraitools.co';
export const usd = (atomic) => (Number(atomic) / 1e6).toFixed(6).replace(/0{1,4}$/, '');

/** What a pack buys: calls per route at today's prices. */
export function quote(packId) {
  const p = PACKS[packId] || PACKS[1];
  return {
    pack: p.id, price_usd: usd(p.paid), credit_usd: usd(p.credit), bonus_usd: usd(p.bonus),
    calls: TOOL_ROUTES.map((r) => ({ tool: r.name, route: r.route, url: `${API_BASE}/${r.tool}${r.route.split(' ')[1]}`, price_usd: usd(r.amount), calls: Math.floor(p.credit / r.amount), what: r.what })),
  };
}
