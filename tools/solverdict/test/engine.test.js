import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMint, normalizeMint, liteView, previewView, parseMetaplex, InputError } from '../src/sol.js';
import { isOnCurveAddress, findProgramAddress } from '../src/b58.js';
import { mockFetch, pool, rayPool, curveAcct, RUG, T22, NOTMINT, MINTS } from './mock.js';
import { PUMP_PROGRAM, parsePumpCurve } from '../src/sol.js';

const NOW = Date.parse('2026-10-22T17:00:00Z');
const run = (mint, o) => analyzeMint(mint, { fetchImpl: o.fetchImpl, now: NOW, tier: 'check' });

test('normalizeMint: base58 32-byte addresses only', () => {
  assert.equal(normalizeMint(' DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 '), 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  for (const bad of ['', '0x532f27101965dd16442E59d40670FaF5eBB142E4', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB26O', 'abc', '1'.repeat(45)]) assert.throws(() => normalizeMint(bad), InputError, bad);
});

test('active mint + freeze authority (not a recognized issuer) = DANGER with both reasons', async () => {
  const m = mockFetch({ dex: { [RUG]: [pool(RUG)] } });
  const r = await run(RUG, m);
  assert.equal(r.verdict, 'DANGER'); assert.ok(r.score <= 20);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('freeze_authority') && codes.includes('mint_authority'));
  assert.equal(r.reasons[0].severity, 'danger');
  assert.equal(r.checks.program, 'spl-token');
});

test('Token-2022 traps: permanent delegate (danger), transfer hook and 2.5% fee (warn), metadata from the extension', async () => {
  const m = mockFetch({ dex: { [T22]: [pool(T22)] } });
  const r = await run(T22, m);
  assert.equal(r.verdict, 'DANGER'); assert.equal(r.symbol, 'TRAP'); assert.equal(r.checks.program, 'token-2022');
  const by = Object.fromEntries(r.reasons.map((x) => [x.code, x.severity]));
  assert.equal(by.permanent_delegate, 'danger'); assert.equal(by.transfer_hook, 'warn'); assert.equal(by.transfer_fee, 'warn');
  assert.equal(r.checks.extensions.transfer_fee_pct, 2.5);
  const l = liteView(r); assert.equal(l.key.permanent_delegate, true); assert.equal(l.key.transfer_hook, true); assert.equal(l.checks, undefined);
});

test('honeypot pattern: many buys, zero sells = DANGER no_sells', async () => {
  const m = mockFetch({ dex: { [T22]: [pool(T22, { buys: 120, sells: 0 })] } });
  const r = await run(T22, m);
  assert.ok(r.reasons.some((x) => x.code === 'no_sells' && x.severity === 'danger'));
});

test('holder concentration: one wallet with 60% = danger whale; holders come from the largest-accounts query', async () => {
  const m = mockFetch({ dex: { [RUG]: [pool(RUG)] } });
  const r = await run(RUG, m);
  assert.equal(r.checks.holders.available, true); assert.equal(r.checks.holders.largest_wallet_pct, 70); // both accounts owned by the same wallet
  assert.ok(r.reasons.some((x) => x.code === 'whale'));
});

test('a failed source is never read as clean: market down = CAUTION at most, missing_data lists it', async () => {
  // clean mint (no authorities) but DexScreener answers 429 and holders are refused
  const clean = 'HxxZZHoRuvNT2GHhQcoSNFVKuBM19TmoAgkmktoV6YDV';
  const m = mockFetch({ dex: { [clean]: 'down' }, holders: false });
  const { MINTS } = await import('./mock.js');
  const saved = MINTS[clean]; MINTS[clean] = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: null } } } };
  try {
    const r = await run(clean, m);
    assert.notEqual(r.verdict, 'SAFE'); assert.equal(r.degraded, true);
    assert.deepEqual(r.missing_data.sort(), ['holders', 'market']);
    assert.ok(r.reasons.some((x) => x.code === 'incomplete'));
    assert.equal(r.confidence, 'low');
  } finally { MINTS[clean] = saved; }
});

test('not a mint = 422 (never charged); RPC down = 503', async () => {
  await assert.rejects(run(NOTMINT, mockFetch()), (e) => e instanceof InputError && e.status === 422 && e.code === 'not_a_mint');
  await assert.rejects(run(RUG, mockFetch({ rpcDown: true })), (e) => e instanceof InputError && e.status === 503);
});

test('preview view hides reasons', async () => {
  const r = await run(RUG, mockFetch({ dex: { [RUG]: [pool(RUG)] } }));
  const p = previewView(r); assert.equal(p.reasons, undefined); assert.ok(p.flags.danger >= 2);
});

test('PDA helpers: Metaplex metadata PDA for BONK and on-curve detection', () => {
  assert.equal(isOnCurveAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), true);
  const pda = findProgramAddress([new TextEncoder().encode('metadata'), ...['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'].map((a) => Uint8Array.from(Buffer.from(require58(a))))], 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  assert.equal(isOnCurveAddress(pda), false);
  assert.equal(parseMetaplex('not base64!!'), null);
});
import { base58Decode } from '../src/b58.js';
function require58(a) { return base58Decode(a); }

const CLEAN = 'HxxZZHoRuvNT2GHhQcoSNFVKuBM19TmoAgkmktoV6YDV';
const cleanMint = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000', mintAuthority: null, freezeAuthority: null } } } };
async function withClean(fn) { const saved = MINTS[CLEAN]; MINTS[CLEAN] = cleanMint; try { await fn(); } finally { MINTS[CLEAN] = saved; } }

test('DexScreener rate-limited: Raydium pools give liquidity and pool age (no sells claimed); falls back without a 503', async () => withClean(async () => {
  const r = await run(CLEAN, mockFetch({ dex: { [CLEAN]: 'down' }, ray: { [CLEAN]: [rayPool(CLEAN, { tvl: 250000 })] }, holders: false }));
  assert.equal(r.checks.market.available, true); assert.equal(r.checks.market.liquidity_usd, 250000); assert.match(r.checks.market.source, /Raydium/);
  assert.equal(r.sources.raydium, true); assert.equal(r.sources.dexscreener, false);
  assert.ok(r.reasons.some((x) => x.code === 'sells_unchecked')); assert.ok(!r.reasons.some((x) => x.code === 'no_sells'));
  assert.ok(r.checks.age && r.checks.age.days > 300);
  assert.ok(!(r.missing_data || []).includes('market'));
}));

test('Raydium answers with no pool: never read as no_liquidity DANGER and never SAFE (market listed as missing)', async () => withClean(async () => {
  const r = await run(CLEAN, mockFetch({ dex: { [CLEAN]: 'down' }, ray: { [CLEAN]: [] } }));
  assert.ok(!r.reasons.some((x) => x.code === 'no_liquidity'));
  assert.notEqual(r.verdict, 'SAFE'); assert.ok(r.missing_data.includes('market'));
}));

test('pump.fun bonding curve read on-chain (PDA ["bonding-curve", mint]) when both market APIs are down', async () => withClean(async () => {
  const pda = findProgramAddress([new TextEncoder().encode('bonding-curve'), base58Decode(CLEAN)], PUMP_PROGRAM);
  const r = await run(CLEAN, mockFetch({ dex: { [CLEAN]: 'down' }, accounts: { [pda]: curveAcct({ realSol: 12.5 }) } }));
  assert.equal(r.checks.market.bonding_curve, true); assert.equal(r.checks.market.liquidity_sol, 12.5);
  assert.deepEqual(r.checks.market.pump_curve, { address: pda, complete: false, real_sol_reserves: 12.5 });
  assert.ok(r.reasons.some((x) => x.code === 'bonding_curve'));
  assert.equal(parsePumpCurve({ owner: 'x', data: ['', 'base64'] }), null);
  assert.equal(parsePumpCurve(curveAcct({ complete: true })).complete, true);
}));
