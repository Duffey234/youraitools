// x402-trust.com provider verification file (https://x402-trust.com/verify): serves the public key line from the
// X402_TRUST_TXT var at /.well-known/x402-trust.txt as text/plain. Public key only; the private key is kept offline.
export const X402_TRUST_PATH = '/.well-known/x402-trust.txt';
export function x402TrustResponse(request, env = {}) {
  if (!env.X402_TRUST_TXT || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  if (new URL(request.url).pathname !== X402_TRUST_PATH) return null;
  return new Response(request.method === 'HEAD' ? null : `${env.X402_TRUST_TXT}\n`, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
}
