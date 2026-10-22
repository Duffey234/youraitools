import { ataOf } from '../src/solana.js';
// Offline engine tests: a fake JSON-RPC / HTTP layer answers like the public endpoints do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, checkCounterparty, listChecks, previewView, InputError, UpstreamError, SOLANA_USDC } from '../src/counterparty.js';
import { SCAM_EVM } from '../src/data/scamsniffer.js';

const LAZARUS = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const str = (s) => { const hex = Buffer.from(s).toString('hex'); return '0x' + pad('20') + pad(s.length.toString(16)) + hex.padEnd(64, '0'); };
/** accounts: address -> { code, nonce, balance, symbol, decimals, supply, sol } */
function fakeFetch(accounts, { down = false, http = {}, bad = [], itemErr = null, names = {} } = {}) {
  const calls = [];
  const answer = (m) => {
    const p = m.params || [];
    if (m.method === 'eth_call' && names[p[0].data.slice(10)]) return names[p[0].data.slice(10)][p[0].data.slice(0, 10)] ?? '0x';
    const acct = (a) => accounts[String(a)] || accounts[String(a).toLowerCase()] || {};
    switch (m.method) {
      case 'eth_blockNumber': return '0x1000';
      case 'eth_getCode': return acct(p[0]).code || '0x';
      case 'eth_getTransactionCount': return '0x' + (acct(p[0]).nonce || 0).toString(16);
      case 'eth_getBalance': return '0x' + BigInt(acct(p[0]).balance || 0).toString(16);
      case 'eth_getStorageAt': return '0x' + pad('0');
      case 'eth_getLogs': return [];
      case 'eth_call': {
        const { to, data } = p[0]; const a = acct(to);
        if (data.startsWith('0x95d89b41')) return a.symbol ? str(a.symbol) : '0x';
        if (data.startsWith('0x313ce567')) return a.decimals != null ? '0x' + pad(a.decimals.toString(16)) : '0x';
        if (data.startsWith('0x18160ddd')) return a.supply != null ? '0x' + pad(BigInt(a.supply).toString(16)) : '0x';
        if (data.startsWith('0x70a08231')) return '0x' + pad('0');
        return '0x';
      }
      case 'getAccountInfo': return { context: {}, value: acct(p[0]).sol ?? null };
      case 'getMultipleAccounts': return { context: {}, value: p[0].map((x) => acct(x).sol ?? null) };
      case 'getSignaturesForAddress': return acct(p[0]).sigs || [];
      default: return null;
    }
  };
  const f = async (url, init = {}) => {
    calls.push(String(url));
    if (down) throw new Error('network down');
    if (bad.some((b) => String(url).includes(b))) return new Response('rate limited', { status: 429 });
    for (const [k, v] of Object.entries(http)) if (String(url).includes(k)) return new Response(JSON.stringify(v), { status: 200 });
    if (!init.body) return new Response('not found', { status: 404 });
    const body = JSON.parse(init.body); const arr = Array.isArray(body) ? body : [body];
    const out = arr.map((m) => { const e = itemErr && itemErr(m, String(url)); return e ? { jsonrpc: '2.0', id: m.id, error: { code: -32005, message: e } } : { jsonrpc: '2.0', id: m.id, result: answer(m) }; });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls; return f;
}
const run = (address, opts = {}, accounts = {}, net = {}) => checkCounterparty(normalizeInput({ address, ...opts }), { tier: opts.tier || 'lite', fetchImpl: fakeFetch(accounts, net), now: Date.parse('2026-10-22T16:00:00Z') });

test('normalizeInput: EVM and Solana, chain aliases, intent; bad input throws InputError', () => {
  assert.deepEqual(normalizeInput({ address: ' 0x098B716B8Aaf21512996dC57EB0615e2383E2f96 ', chain: 'Eip155:1' }), { address: LAZARUS, input: '0x098B716B8Aaf21512996dC57EB0615e2383E2f96', chain: 'ethereum', intent: 'pay', family: 'evm' });
  assert.equal(normalizeInput('FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte').chain, 'solana');
  assert.equal(normalizeInput({ address: LAZARUS, chain: 'arb', intent: 'APPROVE' }).intent, 'approve');
  for (const bad of [{}, { address: '0x12' }, { address: LAZARUS, chain: 'tron' }, { address: LAZARUS, intent: 'x' }, { address: LAZARUS, chain: 'solana' }, { address: 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte', chain: 'base' }, { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }]) assert.throws(() => normalizeInput(bad), InputError, JSON.stringify(bad));
});

test('lists: OFAC SDN hit, ScamSniffer hit, our x402 payee; labelled contracts are never scam-flagged', () => {
  const l = listChecks(LAZARUS, 'evm'); assert.equal(l.sanctions.listed, true); assert.match(l.sanctions.matches[0].entity, /LAZARUS/);
  const scam = [...SCAM_EVM][0]; assert.equal(listChecks(scam, 'evm').scam_list.listed, true);
  const ours = listChecks('0x3c1a1e01e790cd326495631b3b38bd7068f08d6f', 'evm').x402_directory; assert.equal(ours.listed, true); assert.equal(ours.ours, true);
  assert.equal(listChecks(USDC_BASE, 'evm').scam_list.listed, false);
});

test('sanctioned address: block with ofac_sdn first, even when the RPC answers it is an active wallet', async () => {
  const r = await run(LAZARUS, { chain: 'ethereum' }, { [LAZARUS]: { nonce: 38, balance: 10n ** 20n } });
  assert.equal(r.verdict, 'block'); assert.equal(r.reasons[0].code, 'ofac_sdn'); assert.equal(r.confidence, 'high'); assert.equal(r.facts.kind, 'eoa');
  assert.match(r.disclaimer, /not legal, compliance or financial advice/i);
});

test('paying a token contract is a block; interacting with it is not', async () => {
  const acc = { [USDC_BASE]: { code: '0x6080', nonce: 1, symbol: 'USDC', decimals: 6, supply: 10n ** 15n } };
  const pay = await run(USDC_BASE, {}, acc); assert.equal(pay.verdict, 'block'); assert.equal(pay.reasons[0].code, 'token_contract'); assert.equal(pay.facts.token.symbol, 'USDC');
  const use = await run(USDC_BASE, { intent: 'interact' }, acc); assert.equal(use.verdict, 'ok'); assert.ok(use.reasons.some((x) => x.code === 'known_label'));
});

test('unused EOA: caution for pay (typo / poisoning); approving an EOA: caution; active EOA: ok', async () => {
  const a = '0x1111111111111111111111111111111111111111';
  const r = await run(a); assert.equal(r.verdict, 'caution'); assert.equal(r.reasons[0].code, 'no_history');
  const ap = await run(a, { intent: 'approve' }, { [a]: { nonce: 3 } }); assert.equal(ap.verdict, 'caution'); assert.equal(ap.reasons[0].code, 'approve_eoa');
  const ok = await run(a, {}, { [a]: { nonce: 3, balance: 10n ** 16n } }); assert.equal(ok.verdict, 'ok'); assert.ok(ok.reasons.some((x) => x.code === 'active'));
});

test('EIP-7702 delegated EOA is recognised with its delegate; burn address is a block', async () => {
  const a = '0x3333333333333333333333333333333333333333';
  const r = await run(a, {}, { [a]: { code: '0xef0100' + '5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d', nonce: 9 } });
  assert.equal(r.facts.kind, 'eip7702_delegated_eoa'); assert.equal(r.facts.delegate, '0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d');
  const b = await run('0x000000000000000000000000000000000000dEaD'); assert.equal(b.verdict, 'block'); assert.ok(b.reasons.some((x) => x.code === 'burn_address'));
});

test('quick tier: optional sources failing degrade to missing_data and a lower confidence (never a clean bill)', async () => {
  const a = '0x4444444444444444444444444444444444444444';
  const r = await run(a, { tier: 'quick' }, { [a]: { code: '0x6080', nonce: 1 } });
  assert.equal(r.sources.rpc, 'ok'); assert.equal(r.sources.sourcify, 'failed'); assert.ok(r.missing_data.includes('sourcify'));
  // verification decides "unverified contract" on quick: its failure is a required check -> caution / low, never ok
  assert.equal(r.verdict, 'caution'); assert.equal(r.confidence, 'low'); assert.deepEqual(r.sources_failed, ['sourcify']);
});

const TIERS = ['preview', 'lite', 'quick', 'full'];
test('fail closed: RPC down on every tier and every chain -> caution (block if listed), confidence low, sources_failed, never ok', async () => {
  const cases = [[USDC_BASE, 'base'], [USDC_BASE, 'ethereum'], [USDC_BASE, 'polygon'], [USDC_BASE, 'arbitrum'], ['FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte', 'solana']];
  for (const tier of TIERS) {
    for (const [a, chain] of cases) {
      const r = await run(a, { tier, chain }, {}, { down: true });
      assert.equal(r.verdict, 'caution', `${tier} ${chain}`); assert.equal(r.confidence, 'low'); assert.deepEqual(r.sources_failed, ['onchain']);
      assert.ok(r.reasons.some((x) => x.code === 'checks_incomplete'));
      const v = previewView(r); assert.equal(v.verdict, 'caution'); assert.deepEqual(v.sources_failed, ['onchain']); assert.deepEqual(v.signals, ['checks_incomplete']); assert.equal(v.reasons, undefined);
    }
    const l = await run(LAZARUS, { tier, chain: 'ethereum' }, {}, { down: true }); // a list match still blocks without the RPC
    assert.equal(l.verdict, 'block'); assert.equal(l.confidence, 'low'); assert.deepEqual(l.sources_failed, ['onchain']);
    assert.deepEqual(previewView(l).signals, ['sanctions_list_match', 'checks_incomplete']);
  }
});

test('fail closed: every endpoint answering 429 is the same as down (no tier returns ok)', async () => {
  for (const tier of TIERS) {
    const r = await run(USDC_BASE, { tier }, { [USDC_BASE]: { code: '0x6080', symbol: 'USDC', decimals: 6, supply: 1e15 } }, { bad: ['http'] });
    assert.notEqual(r.verdict, 'ok', tier); assert.equal(r.confidence, 'low'); assert.ok(r.sources_failed.includes('onchain'));
  }
});

test('RPC fallback: first endpoints rate-limited or capping batches -> the next endpoint answers and the token check still blocks', async () => {
  const usdc = { [USDC_BASE]: { code: '0x6080', symbol: 'USDC', decimals: 6, supply: 1e15 } };
  const r = await run(USDC_BASE, { tier: 'preview' }, usdc, { bad: ['base-rpc.publicnode.com', 'mainnet.base.org'] });
  assert.equal(r.verdict, 'block'); assert.equal(r.confidence, 'high'); assert.deepEqual(r.sources_failed, []); assert.equal(r.reasons[0].code, 'token_contract');
  // an endpoint that errors every batch item (free-plan batch cap) is skipped like a 429
  const capped = (m, url) => (url.includes('publicnode') ? 'Batch of more than 3 requests are not allowed on free plan' : null);
  const r2 = await run(USDC_BASE, { tier: 'lite' }, usdc, { itemErr: capped });
  assert.equal(r2.verdict, 'block'); assert.deepEqual(r2.sources_failed, []);
});

test('fail closed: token-contract calls failing at every endpoint (code known) -> caution with token_check, never ok', async () => {
  const usdc = { [USDC_BASE]: { code: '0x6080', symbol: 'USDC', decimals: 6, supply: 1e15 } };
  const symFail = (m) => (m.method === 'eth_call' && /^0x(95d89b41|313ce567|18160ddd)/.test(m.params[0].data) ? 'upstream timeout' : null);
  for (const tier of TIERS) {
    const r = await run(USDC_BASE, { tier }, usdc, { itemErr: symFail });
    assert.equal(r.verdict, 'caution', tier); assert.equal(r.confidence, 'low'); assert.ok(r.sources_failed.includes('token_check'), tier);
  }
  // a revert is an answer (not a token), not a failure
  const reverts = (m) => (m.method === 'eth_call' && /^0x(95d89b41|313ce567|18160ddd)/.test(m.params[0].data) ? 'execution reverted' : null);
  const c = await run(USDC_BASE, { tier: 'lite' }, usdc, { itemErr: reverts });
  assert.deepEqual(c.sources_failed, []); assert.equal(c.facts.kind, 'contract'); assert.notEqual(c.confidence, 'low');
});

test('fail closed (full): age, activity and approvals failing are required checks -> caution / low', async () => {
  const a = '0x5555555555555555555555555555555555555555';
  const r = await run(a, { tier: 'full' }, { [a]: { nonce: 3, balance: 10n ** 18n } }, { itemErr: (m) => (m.method === 'eth_getLogs' || m.method === 'eth_getTransactionCount' && m.params[1] !== 'latest' ? 'rate limit' : null) });
  assert.equal(r.verdict, 'caution'); assert.equal(r.confidence, 'low'); assert.ok(r.sources_failed.includes('activity'));
});

test('names: vitalik.eth / *.base.eth resolve on chain; unknown name -> 400; resolver RPC down -> caution / low (never ok)', async () => {
  const { namehash } = await import('viem');
  const V = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'; const RES = '0x231b0ee14048e9dccd1d247744d114a4eb5e8e63'; const BRES = '0xc6d566a56a1aff6508b41f6c90ff131615583bcd';
  const w = (x) => '0x' + pad(x.slice(2));
  const names = { [namehash('vitalik.eth').slice(2)]: { '0x0178b8bf': w(RES), '0x3b3b57de': w(V) }, [namehash('jesse.base.eth').slice(2)]: { '0x0178b8bf': w(BRES), '0x3b3b57de': w(LAZARUS) } };
  const n = normalizeInput({ address: 'Vitalik.eth' }); assert.equal(n.name, 'vitalik.eth'); assert.equal(n.chain, 'base');
  const r = await run('vitalik.eth', { tier: 'lite', chain: 'ethereum' }, { [V]: { nonce: 5 } }, { names });
  assert.equal(r.address, V); assert.equal(r.name, 'vitalik.eth'); assert.equal(r.checks.name.resolved, V); assert.equal(r.verdict, 'ok'); assert.deepEqual(r.sources_failed, []);
  const b = await run('jesse.base.eth', { tier: 'preview' }, {}, { names });
  assert.equal(b.address, LAZARUS); assert.equal(b.verdict, 'block'); assert.match(b.checks.name.via, /Basename/);
  await assert.rejects(run('nobody-here-123.eth', { tier: 'lite' }, {}, { names }), (e) => e instanceof InputError && /no on-chain address record/.test(e.message));
  for (const tier of TIERS) {
    const d = await run('vitalik.eth', { tier }, {}, { down: true });
    assert.equal(d.verdict, 'caution'); assert.equal(d.confidence, 'low'); assert.deepEqual(d.sources_failed, ['name_resolution']); assert.equal(d.address, null);
  }
  assert.throws(() => normalizeInput({ address: 'vitalik.eth', chain: 'solana' }), InputError);
  assert.throws(() => normalizeInput({ address: 'example.com' }), InputError);
});

test('Solana: mint = block for pay, wallet without a USDC token account = caution, wallet with one = ok', async () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const m = await run(mint, {}, { [mint]: { sol: { lamports: 1e9, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false, data: { parsed: { type: 'mint', info: { decimals: 9, supply: '0' } } } } } });
  assert.equal(m.chain, 'solana'); assert.equal(m.facts.kind, 'token_mint'); assert.equal(m.verdict, 'block');
  const w = 'FH73WbbUe2UyNzfy72MJs5nT3NxyDf9GrqE7kzjL2Jte';
  const acc = { [w]: { sol: { lamports: 3.5e6, owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'] } } };
  const none = await run(w, {}, acc); assert.equal(none.verdict, 'caution'); assert.equal(none.reasons[0].code, 'no_usdc_account');
  acc[ataOf(w, SOLANA_USDC)] = { sol: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'account', info: { mint: SOLANA_USDC, tokenAmount: { uiAmount: 0.8 } } } } } };
  const ready = await run(w, {}, acc); assert.equal(ready.verdict, 'ok'); assert.ok(ready.reasons.some((x) => x.code === 'usdc_ready'));
});

test('wrong-chain trap on every tier: Base USDC contract address on Polygon (EOA there) -> block for pay', async () => {
  for (const tier of TIERS) {
    const r = await run(USDC_BASE, { tier, chain: 'polygon' }, { [USDC_BASE]: { nonce: 0, balance: 10n ** 20n } });
    assert.equal(r.verdict, 'block', tier); assert.ok(r.reasons.some((x) => x.code === 'wrong_chain_contract'));
  }
});
