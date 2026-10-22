import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentGateClient } from '../src/client.js';

test('client: preview hits the free route, check without paidFetch surfaces 402 clearly', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (url.includes('/preview')) return new Response(JSON.stringify({ verified: true, tier: 'free' }), { status: 200 });
    return new Response('{}', { status: 402 });
  };
  const c = createAgentGateClient({ baseUrl: 'https://x.test/', fetch });
  assert.equal((await c.preview('Mf22soLh1NuZYFgBK8iSs')).verified, true);
  assert.equal(seen[0], 'https://x.test/v1/check-agent/preview?id=Mf22soLh1NuZYFgBK8iSs&network=mainnet');
  await assert.rejects(c.check('Mf22soLh1NuZYFgBK8iSs'), (e) => e.status === 402);
  const paid = createAgentGateClient({ baseUrl: 'https://x.test', fetch, paidFetch: async () => new Response(JSON.stringify({ verified: true, owner: 'o' }), { status: 200 }) });
  assert.equal((await paid.verify('Mf22soLh1NuZYFgBK8iSs')).owner, 'o');
});
