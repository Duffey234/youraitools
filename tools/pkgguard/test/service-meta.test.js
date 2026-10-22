import test from 'node:test';
import assert from 'node:assert/strict';
import { routesConfig } from '../src/app.js';
import { SERVICE_META } from '../src/service-meta.js';
import { isValidServiceName, isValidIconUrl } from '@x402/extensions/bazaar';

test('Bazaar listing metadata on every paid route is valid (name <= 32 ASCII, <= 5 tags, https icon)', () => {
  const routes = routesConfig({ priceScan: '$0.003', pricePackage: '$0.001', network: 'eip155:8453', payTo: '0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F', publicUrl: 'https://api.example.com' });
  assert.ok(Object.keys(routes).length >= 1);
  for (const [k, r] of Object.entries(routes)) {
    assert.equal(r.serviceName, SERVICE_META.serviceName, k);
    assert.ok(isValidServiceName(r.serviceName), k);
    assert.ok(r.tags.length <= 5 && r.tags.every((t) => t.length <= 32), k);
    assert.equal(r.tags[0], SERVICE_META.category, k);
    assert.ok(isValidIconUrl(r.iconUrl) && r.iconUrl.startsWith('https://'), k);
    assert.ok(r.description.length <= 500, `${k} description must be <= 500 chars for the CDP facilitator`);
  }
});
