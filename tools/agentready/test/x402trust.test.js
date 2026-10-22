import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { x402TrustResponse } from '../src/x402trust.js';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const LINE = toml.match(/^X402_TRUST_TXT = "([^"]+)"/m)[1];
test('x402-trust.txt: public key line from wrangler.toml, text/plain 200, nothing else', async () => {
  assert.match(LINE, /^x402-trust-verification=v1:[A-Za-z0-9_-]{80,}$/);
  const r = x402TrustResponse(new Request('https://w.example/.well-known/x402-trust.txt'), { X402_TRUST_TXT: LINE });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/plain/); assert.equal(await r.text(), LINE + '\n');
  assert.equal(x402TrustResponse(new Request('https://w.example/.well-known/x402'), { X402_TRUST_TXT: LINE }), null);
  assert.equal(x402TrustResponse(new Request('https://w.example/.well-known/x402-trust.txt'), {}), null);
  assert.equal(x402TrustResponse(new Request('https://w.example/.well-known/x402-trust.txt', { method: 'POST' }), { X402_TRUST_TXT: LINE }), null);
});
