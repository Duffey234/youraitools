// Well-known Solana mints whose issuer controls (mint / freeze authority, permanent delegate, pausing) are documented by design.
// For these the controls are reported as information, not red flags. Addresses checked on-chain 2026-10-22.
export const RECOGNIZED = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', issuer: 'Circle (native USDC)' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', issuer: 'Tether' },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', issuer: 'Paxos (PayPal USD)' },
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: { symbol: 'EURC', issuer: 'Circle' },
  So11111111111111111111111111111111111111112: { symbol: 'wSOL', issuer: 'SPL Token program (wrapped SOL)' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'JitoSOL', issuer: 'Jito stake pool' },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL', issuer: 'Marinade' },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', issuer: 'Jupiter' },
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': { symbol: 'JLP', issuer: 'Jupiter perps LP' },
};
// Owners that mean "burned" (tokens sent here are gone).
export const BURN_OWNERS = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
