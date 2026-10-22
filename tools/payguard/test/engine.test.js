// Engine tests against the real bundled OFAC SDN snapshot (src/data/sdn.js). The sanctioned fixtures below are read
// from the list itself, so they fail loudly if a refresh drops them (then pick new ones from the data file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenAddress, previewAddress, screenBatch, normalizeAddress, invalidInput, LIST } from '../src/screen.js';
import { detectAddress, eip55, bech32Decode, cashaddrValid } from '../src/address.js';
import { SDN } from '../src/data/sdn.js';
import { LAZARUS_ETH, CLEAN_EVM } from './helpers.js';

test('bundled list: official source, sane size, every address points at an entity with programs and a list date', () => {
  assert.match(SDN.source_url, /^https:\/\/sanctionslistservice\.ofac\.treas\.gov\//);
  assert.match(SDN.publish_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(SDN.address_count > 500, String(SDN.address_count));
  assert.equal(Object.keys(SDN.addresses).length, SDN.address_count);
  for (const [addr, hits] of Object.entries(SDN.addresses)) {
    assert.ok(hits.length >= 1);
    for (const [uid, cur] of hits) { const e = SDN.entities[uid]; assert.ok(e && e.name && e.programs.length && /^\d{4}-\d{2}-\d{2}$/.test(e.list_date), `${addr} -> ${uid}`); assert.ok(cur); }
    if (/^0x[0-9a-f]{40}$/i.test(addr)) assert.equal(addr, addr.toLowerCase(), 'EVM keys are lower-case');
  }
  assert.ok(SDN.by_currency.ETH > 10 && SDN.by_currency.XBT > 100 && SDN.by_currency.TRX > 10);
});

test('Lazarus Group ETH address (from the list): sanctioned in any case, DPRK program, list date, checksum handled', () => {
  for (const a of [LAZARUS_ETH, LAZARUS_ETH.toLowerCase(), LAZARUS_ETH.toUpperCase().replace('0X', '0x'), ` ethereum:${LAZARUS_ETH} `]) {
    const r = screenAddress(a);
    assert.equal(r.sanctioned, true, a); assert.equal(r.match_count, 1);
    assert.equal(r.matches[0].entity, 'LAZARUS GROUP'); assert.ok(r.matches[0].programs.some((p) => /^DPRK/.test(p)));
    assert.equal(r.matches[0].list_date, '2019-09-13'); assert.equal(r.matches[0].listed_currency, 'ETH');
    assert.equal(r.chain.guess, 'evm'); assert.equal(r.address, LAZARUS_ETH.toLowerCase());
  }
  assert.equal(screenAddress(LAZARUS_ETH).chain.checksum_valid, true);
  assert.equal(screenAddress(LAZARUS_ETH.toLowerCase()).chain.checksum_valid, null);
  assert.equal(screenAddress(LAZARUS_ETH.toLowerCase()).chain.checksum_address, LAZARUS_ETH);
  assert.match(screenAddress(LAZARUS_ETH).disclaimer, /not legal advice/i);
});

test('clean addresses are not flagged; bad EIP-55 checksum is reported but still screened', () => {
  for (const a of [CLEAN_EVM, '0x0000000000000000000000000000000000000001', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t']) {
    const r = screenAddress(a); assert.equal(r.sanctioned, false, a); assert.deepEqual(r.matches, []);
  }
  const typo = screenAddress(CLEAN_EVM.slice(0, -1) + '4');
  assert.equal(typo.sanctioned, false); assert.equal(typo.chain.checksum_valid, false);
});

test('every listed address of every currency is found by its own listed form (exact match)', () => {
  let n = 0;
  for (const addr of Object.keys(SDN.addresses)) { assert.equal(screenAddress(addr).sanctioned, true, addr); n++; }
  assert.equal(n, LIST.address_count);
});

test('non-EVM samples from the list: TRX, BTC bech32 + legacy, SOL, XMR, LTC, BCH cashaddr, with chain guess + checksum', () => {
  const pick = (re, cur) => Object.entries(SDN.addresses).find(([a, h]) => re.test(a) && h.some(([, c]) => c === cur))?.[0];
  const cases = [[/^T/, 'USDT', 'tron', true], [/^bc1/, 'XBT', 'bitcoin', true], [/^1/, 'XBT', 'bitcoin', true], [/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'SOL', 'solana', null], [/^[48]/, 'XMR', 'monero', null], [/^L/, 'LTC', 'litecoin', true], [/^q/, 'BCH', 'bitcoin-cash', true]];
  for (const [re, cur, guess, checksum] of cases) {
    const a = pick(re, cur); assert.ok(a, `${cur} sample`);
    const r = screenAddress(a);
    assert.equal(r.sanctioned, true, a); assert.equal(r.chain.guess, guess, a); assert.equal(r.chain.checksum_valid, checksum, a);
  }
  const btc = pick(/^bc1/, 'XBT');
  assert.equal(screenAddress(btc.toUpperCase()).sanctioned, true, 'bech32 is case-insensitive');
  const trx = pick(/^T/, 'USDT');
  assert.equal(screenAddress(trx.toLowerCase()).sanctioned, false, 'base58 is exact');
  assert.equal(screenAddress(`bitcoincash:${pick(/^q/, 'BCH')}`).sanctioned, true);
});

test('address helpers: EIP-55, bech32, cashaddr, detect', () => {
  assert.equal(eip55('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), true);
  assert.equal(eip55('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), false);
  assert.equal(bech32Decode('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').variant, 'bech32');
  assert.equal(bech32Decode('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297').variant, 'bech32m');
  assert.equal(bech32Decode('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx'), null);
  assert.equal(cashaddrValid('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), true);
  assert.equal(cashaddrValid('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b'), false);
  assert.equal(detectAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh').guess, 'xrp');
  assert.equal(detectAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2').checksum_valid, true);
  assert.equal(detectAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3').checksum_valid, false);
});

test('input validation, normalization, preview tier and batch', () => {
  for (const bad of ['', '   ', 'x'.repeat(200), 'hello world', '<script>', 'short']) assert.ok(invalidInput(bad), JSON.stringify(bad));
  assert.equal(screenAddress('nope nope').error, 'bad_request');
  assert.equal(normalizeAddress(' BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ '), 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  const p = previewAddress(LAZARUS_ETH);
  assert.equal(p.sanctioned, true); assert.equal(p.matches, undefined); assert.equal(p.tier, 'preview');
  const b = screenBatch([LAZARUS_ETH, CLEAN_EVM]);
  assert.deepEqual([b.count, b.sanctioned_count, b.any_sanctioned], [2, 1, true]);
  assert.equal(b.results[0].matches[0].entity, 'LAZARUS GROUP'); assert.equal(b.results[1].sanctioned, false);
  assert.equal(screenBatch(Array(51).fill(CLEAN_EVM)).error, 'bad_request');
  assert.equal(screenBatch([]).error, 'bad_request');
  const old = screenAddress(CLEAN_EVM, { now: Date.parse(`${SDN.publish_date}T00:00:00Z`) + 30 * 86400000 });
  assert.match(old.stale_warning, /30 days old/);
});
