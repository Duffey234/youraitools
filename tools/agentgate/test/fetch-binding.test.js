import test from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumPublicProvider } from '../src/registry.js';

// Regression: Cloudflare Workers throws "Illegal invocation" if the global fetch is invoked as a method of another object.
test('provider never calls the global fetch with `this` bound to the provider', async () => {
  const orig = globalThis.fetch;
  let seenThis = 'unset';
  globalThis.fetch = function (url) { seenThis = this; return Promise.resolve(new Response(JSON.stringify({}), { status: 404 })); };
  try {
    const p = new ConcordiumPublicProvider({ checkCard: false });
    await p.check('Mf22soLh1NuZYFgBK8iSs', { network: 'mainnet' }).catch(() => {});
    assert.notEqual(seenThis, 'unset', 'fetch was called');
    assert.notEqual(seenThis, p);
  } finally { globalThis.fetch = orig; }
});
