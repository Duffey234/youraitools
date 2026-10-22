import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumPublicProvider, MockProvider, CachedProvider, classifyId, RegistryError } from '../src/registry.js';
import { fakeFetch, fixture } from './helpers.js';

test('classifyId distinguishes badges, accounts, CAIP-19 and junk', () => {
  assert.deepEqual(classifyId('Mf22soLh1NuZYFgBK8iSs'), { kind: 'badge', value: 'Mf22soLh1NuZYFgBK8iSs' });
  assert.equal(classifyId('4DDvjwdcLmTy1Ar9FCKKPMiABrS261TvyXJGr4n4ypuuogXeFF').kind, 'account');
  assert.deepEqual(classifyId('ccd:9dd9ca4d19e9393877d2c44b70f89acb/cis-2:Mf22soLh1NuZYFgBK8iSs'), { kind: 'badge', value: 'Mf22soLh1NuZYFgBK8iSs' });
  assert.equal(classifyId('0xdeadbeef').kind, 'invalid');
  assert.equal(classifyId('').kind, 'invalid');
  assert.equal(classifyId(42).kind, 'invalid');
});

test('mainnet badge: parses real badge-check response (recorded fixture)', async () => {
  const fetch = fakeFetch({ rest: { '/v1/badge-check/Mf22soLh1NuZYFgBK8iSs': { body: fixture('badge-check-mainnet-484.json') } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('Mf22soLh1NuZYFgBK8iSs');
  assert.equal(r.verified, true);
  assert.equal(r.found, true);
  assert.equal(r.active, true);
  assert.equal(r.cardHashMatches, true);
  assert.equal(r.tokenId, 484);
  assert.equal(r.owner, '4DDvjwdcLmTy1Ar9FCKKPMiABrS261TvyXJGr4n4ypuuogXeFF');
  assert.equal(r.source, 'concordium-badge-check');
  assert.equal(r.mock, false);
  assert.match(fetch.calls[0].url, /^https:\/\/agent-registry-mcp\.concordium\.com\/v1\/badge-check\//);
});

test('mainnet account: verified if any owned agent has a valid badge', async () => {
  const fetch = fakeFetch({ rest: { '/v1/badge-check/4DDv': { body: fixture('badge-check-account.json') } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('4DDvjwdcLmTy1Ar9FCKKPMiABrS261TvyXJGr4n4ypuuogXeFF');
  assert.equal(r.kind, 'account');
  assert.equal(r.verified, true);
  assert.ok(r.agentCount >= 1);
});

test('mainnet: 400 from badge-check yields not-found, not an exception', async () => {
  const fetch = fakeFetch({ rest: { '/v1/badge-check/': { status: 400, body: { error: 'bad_request', message: 'bad checksum' } } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('Mf22soLh1NuZYFgBK8iSX');
  assert.equal(r.found, false);
  assert.equal(r.verified, false);
  assert.match(r.issues[0].message, /bad checksum/);
});

test('mainnet: 5xx throws RegistryError (so middleware can fail closed)', async () => {
  const fetch = fakeFetch({ rest: { '/v1/badge-check/': { status: 502, body: { error: 'upstream' } } } });
  await assert.rejects(new ConcordiumPublicProvider({ fetch }).check('Mf22soLh1NuZYFgBK8iSs'), RegistryError);
});

const testnetRec = { network: 'testnet', token_address: 'JyP9TtQC3HCNrTYR3sc2T', token_id: '0', token_id_u64: 0, owner_account: '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB', agent_uri: 'https://example.com/card.json', metadata_hash_hex: 'ab', agent_wallet: '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB', status: 'Active' };

test('testnet badge via hosted MCP: Active + card match => verified', async () => {
  const fetch = fakeFetch({ mcp: { agent_by_token_address: testnetRec, verify_agent_card: { match: true, fetched: { http_status: 200 } } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('JyP9TtQC3HCNrTYR3sc2T', { network: 'testnet' });
  assert.equal(r.verified, true);
  assert.equal(r.source, 'concordium-mcp');
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.params.name, 'agent_by_token_address');
  assert.equal(body.params.arguments.network, 'testnet');
});

test('testnet: card hash mismatch => not verified', async () => {
  const fetch = fakeFetch({ mcp: { agent_by_token_address: testnetRec, verify_agent_card: { match: false, fetched: { http_status: 404 } } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('JyP9TtQC3HCNrTYR3sc2T', { network: 'testnet' });
  assert.equal(r.found, true);
  assert.equal(r.cardHashMatches, false);
  assert.equal(r.verified, false);
});

test('testnet: revoked agent => not verified', async () => {
  const fetch = fakeFetch({ mcp: { agent_by_token_address: { ...testnetRec, status: 'Revoked' }, verify_agent_card: { match: true } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('JyP9TtQC3HCNrTYR3sc2T', { network: 'testnet' });
  assert.equal(r.active, false);
  assert.equal(r.verified, false);
});

test('testnet: MCP tool error (bad checksum) => not found', async () => {
  const fetch = fakeFetch({ mcp: { agent_by_token_address: { isError: true, text: 'invalid checksum' } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('JyP9TtQC3HCNrTYR3sc2X', { network: 'testnet' });
  assert.equal(r.found, false);
  assert.match(r.issues[0].message, /checksum/);
});

test('testnet account via agents_by_owner', async () => {
  const fetch = fakeFetch({ mcp: { agents_by_owner: { agents: [testnetRec] }, verify_agent_card: { match: true } } });
  const r = await new ConcordiumPublicProvider({ fetch }).check('3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB', { network: 'testnet' });
  assert.equal(r.kind, 'account');
  assert.equal(r.verified, true);
  assert.equal(r.tokenId, 0);
});

test('unknown network rejected', async () => {
  await assert.rejects(new ConcordiumPublicProvider({ fetch: fakeFetch({}) }).check('Mf22soLh1NuZYFgBK8iSs', { network: 'moon' }), /unknown network/);
});

test('MockProvider is clearly labeled and covers verified/revoked/tampered', async () => {
  const m = new MockProvider();
  const ok = await m.check('MockVerifiedAgent1111');
  assert.equal(ok.verified, true);
  assert.equal(ok.mock, true);
  assert.equal(ok.source, 'mock');
  assert.equal((await m.check('MockRevokedAgent22222')).verified, false);
  assert.equal((await m.check('MockTamperedCard33333')).verified, false);
  assert.equal((await m.check('Mf22soLh1NuZYFgBK8iSs')).found, false);
});

test('CachedProvider caches within TTL', async () => {
  let t = 0;
  const m = new MockProvider();
  const c = new CachedProvider(m, { ttlMs: 1000, now: () => t });
  await c.check('MockVerifiedAgent1111');
  await c.check('MockVerifiedAgent1111');
  assert.equal(m.calls, 1);
  t = 2000;
  await c.check('MockVerifiedAgent1111');
  assert.equal(m.calls, 2);
});

test('LIVE: real Concordium badge-check + hosted MCP (set AGENTGATE_LIVE=1)', { skip: process.env.AGENTGATE_LIVE !== '1' }, async () => {
  const p = new ConcordiumPublicProvider();
  const main = await p.check('Mf22soLh1NuZYFgBK8iSs', { network: 'mainnet' });
  assert.equal(main.found, true);
  assert.equal(main.tokenId, 484);
  const tn = await p.check('JyP9TtQC3HCNrTYR3sc2T', { network: 'testnet' });
  assert.equal(tn.found, true);
  assert.equal(tn.network, 'testnet');
});
