import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, PAY_TO, NETWORK } from './helpers.js';
import { prefersHtml } from '../src/landing.js';

const ROOT = 'https://agentgate.example.com/';
const EXPECTED_JSON = {
  name: 'AgentGate',
  description: 'Paid x402 API: is this AI agent registered, Active and Verified by Concordium?',
  paid: { method: 'GET', path: '/v1/check-agent', price: '$0.005', network: NETWORK, asset: 'USDC', payTo: PAY_TO, facilitator: 'https://facilitator.payai.network' },
  free: ['/health', '/lax-offer.json', '/v1/check-agent/preview', '/mcp', '/v1/stats', '/openapi.json', '/.well-known/x402'],
  freeTier: {
    preview: { method: 'GET', path: '/v1/check-agent/preview', limit: '20 requests/min per IP', returns: 'verdict only: verified, found, active, cardHashMatches, issues' },
    mcp: { method: 'POST', path: '/mcp', transport: 'streamable-http', tools: ['check_agent'], limit: '20 tool calls/min per IP' },
    stats: { method: 'GET', path: '/v1/stats', returns: 'public usage counters, last 30 days' },
  },
  mcpRegistry: 'io.github.agentgate-builder/agentgate',
  source: 'https://agentgate-source.pages.dev/agentgate/',
  checker: 'https://agentgate-source.pages.dev/agentgate/demo/',
  guide: 'https://youraitools.co/guides/x402-agent-verification',
  npm: 'https://www.npmjs.com/package/concordium-agentgate',
  allTools: 'https://youraitools.co/built-by-us',
};
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

test('root returns the exact JSON for agents, curl, */* and application/json', async () => {
  const { fetchApp } = makeApp();
  for (const accept of [undefined, '*/*', 'application/json', 'application/json, text/html', 'text/html;q=0.5, */*', 'text/html;q=0.5, application/json']) {
    const r = await fetchApp(ROOT, { headers: accept ? { accept } : {} });
    assert.equal(r.status, 200, String(accept));
    assert.match(r.headers.get('content-type'), /application\/json/, String(accept));
    assert.deepEqual(await r.json(), EXPECTED_JSON, String(accept));
  }
});

test('root returns a self-contained HTML landing page for browsers', async () => {
  const { fetchApp } = makeApp();
  for (const accept of [BROWSER, 'text/html']) {
    const r = await fetchApp(ROOT, { headers: { accept } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('vary') || '', /Accept/i);
    const html = await r.text();
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes('Agent trust kit') && html.includes('https://webread.agentgate.workers.dev') && html.includes('https://injectscan.agentgate.workers.dev') && html.includes('https://domaincheck.agentgate.workers.dev'));
    for (const s of ['$0.005 USDC', 'on Base', 'curl -i &quot;https://agentgate.example.com/v1/check-agent?id=', '@x402/fetch', 'wrapFetchWithPaymentFromConfig',
      'https://agentgate-source.pages.dev/agentgate/', 'https://youraitools.co/guides/x402-agent-verification', 'https://agentgate-source.pages.dev/agentgate/demo/',
      'https://facilitator.payai.network/discovery/listing-status?resource=https%3A%2F%2Fagentgate.example.com%2Fv1%2Fcheck-agent',
      'href="/health"', 'href="/lax-offer.json"', 'href="/v1/stats"', 'href="/v1/check-agent/preview?id=', 'POST /mcp', 'https://agentgate.example.com/mcp', PAY_TO]) assert.ok(html.includes(s), `missing ${s}`);
    // self-contained: no external stylesheets, scripts, images or fonts
    assert.doesNotMatch(html, /<link\b|<script[^>]+src=|<img\b|@import|url\(/i);
  }
});

test('other routes ignore Accept: /health, /lax-offer.json and the paid 402 are unchanged for browsers', async () => {
  const { fetchApp } = makeApp();
  const h = await fetchApp('https://agentgate.example.com/health', { headers: { accept: BROWSER } });
  assert.deepEqual(await h.json(), { ok: true });
  const o = await fetchApp('https://agentgate.example.com/lax-offer.json', { headers: { accept: BROWSER } });
  assert.match(o.headers.get('content-type'), /application\/json/);
  const p = await fetchApp('https://agentgate.example.com/v1/check-agent?id=Mf22soLh1NuZYFgBK8iSs', { headers: { accept: 'application/json' } });
  assert.equal(p.status, 402);
  assert.ok(p.headers.get('PAYMENT-REQUIRED'));
});

test('prefersHtml ranks q-values correctly', () => {
  assert.equal(prefersHtml(BROWSER), true);
  assert.equal(prefersHtml('text/html'), true);
  assert.equal(prefersHtml(undefined), false);
  assert.equal(prefersHtml('*/*'), false);
  assert.equal(prefersHtml('application/json;q=0.9, text/html'), true);
  assert.equal(prefersHtml('text/html;q=0, */*'), false);
  assert.equal(prefersHtml('text/html;q=abc'), false);
});

test('root JSON stays backward compatible: original fields and free entries unchanged, new ones only appended', async () => {
  const { fetchApp } = makeApp();
  const j = await (await fetchApp(ROOT)).json();
  for (const k of ['name', 'description', 'paid', 'free', 'source', 'checker']) assert.ok(k in j, k);
  assert.deepEqual(j.free.slice(0, 2), ['/health', '/lax-offer.json']);
});
