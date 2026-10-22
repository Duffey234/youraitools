import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, redact, bip39ChecksumOk, base58checkOk, luhnOk, ibanOk } from '../src/engine.js';

// Public test vectors only (BIP39 spec vector, Hardhat account #0, Bitcoin wiki WIF example, card/IBAN test numbers).
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HARDHAT0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
const types = (fs) => fs.map((f) => f.type).sort();

test('validators', async () => {
  assert.equal(await bip39ChecksumOk(MNEMONIC.split(' ')), true);
  assert.equal(await bip39ChecksumOk(MNEMONIC.replace(/about$/, 'abandon').split(' ')), false);
  assert.equal(await base58checkOk(WIF), true);
  assert.equal(await base58checkOk(WIF.slice(0, -1) + 'K'), false);
  assert.equal(luhnOk('4111111111111111'), true); assert.equal(luhnOk('4111111111111112'), false);
  assert.equal(ibanOk('GB82 WEST 1234 5698 7654 32'), true); assert.equal(ibanOk('GB82 WEST 1234 5698 7654 33'), false);
});

test('wallet keys: seed phrase (checksum), private key with context, WIF', async () => {
  const r = await redact(`my seed: ${MNEMONIC}\nPRIVATE_KEY=${HARDHAT0}\nbtc wif ${WIF}`);
  assert.equal(r.verdict, 'WALLET_KEY_EXPOSED'); assert.equal(r.safe_to_send, false);
  assert.deepEqual(types(r.findings), ['bip39_mnemonic', 'evm_private_key', 'wif_private_key']);
  assert.ok(!r.redacted.includes('abandon about')); assert.ok(!r.redacted.includes('ac0974bec39a17e3'));
  assert.ok(r.redacted.includes('[REDACTED:bip39_mnemonic]'));
  for (const f of r.findings) assert.ok(!f.preview.includes('ac0974'), 'previews never echo a key');
});

test('a 12-word run with a bad checksum is still flagged (lower confidence)', async () => {
  const fs = await scan(MNEMONIC.replace(/about$/, 'abandon'));
  assert.equal(fs.length, 1); assert.equal(fs[0].type, 'bip39_mnemonic'); assert.ok(fs[0].confidence < 0.9);
});

test('no false positives on tx hashes, git SHAs, UUIDs and ordinary English', async () => {
  const text = `tx 0x8994737ace8052c529c7cd4544eaca7705d365f128f1215aad69f1fb3f3208b7 confirmed. commit 3809c73a1b2c3d4e5f60718293a4b5c6d7e8f901.
id 123e4567-e89b-12d3-a456-426614174000. The quick brown fox jumps over the lazy dog because it was able to.
Our team will review the access policy and the budget before the window closes. version 1.2.3.4`;
  assert.deepEqual(await scan(text), []);
});

test('API secrets', async () => {
  const fake = 'A'.repeat(36);
  const text = [`token ghp_${fake}`, `AKIAABCDEFGHIJKLMNOP`, `sk_live_${'x1'.repeat(12)}`, `xoxb-1234567890-abcdefghij`, `postgres://admin:s3cretPw@db.example.com:5432/app`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv', `api_key = "Zx81kQp02LmN7vRt"`, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'].join('\n');
  const r = await redact(text);
  assert.equal(r.verdict, 'SECRETS_FOUND');
  assert.deepEqual(types(r.findings), ['aws_access_key_id', 'github_token', 'jwt', 'password_assignment', 'pem_private_key', 'slack_token', 'stripe_secret_key', 'url_with_credentials']);
  assert.ok(!/ghp_A|s3cretPw|Zx81kQp02/.test(r.redacted));
});

test('placeholders are not secrets', async () => {
  assert.deepEqual(await scan('password = ********\napi_key: ${API_KEY}\ntoken = process.env.TOKEN\nsecret: <your-secret-here>'), []);
});

test('PII with validators and mask style', async () => {
  const text = 'Card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, SSN 536-22-1234, mail jane.doe@example.com, call (415) 555-0132, ip 8.8.8.8. Not a card: 4111 1111 1111 1112';
  const r = await redact(text, { style: 'mask' });
  assert.equal(r.verdict, 'PII_FOUND');
  assert.deepEqual(types(r.findings), ['credit_card', 'email', 'iban', 'ipv4', 'phone', 'us_ssn']);
  assert.ok(r.redacted.includes('***1111') && r.redacted.includes('j***@example.com') && r.redacted.includes('4111 1111 1111 1112'));
});

test('filters: types and minSeverity', async () => {
  const text = `mail a@b.co and ${MNEMONIC}`;
  assert.deepEqual(types(await scan(text, { types: ['pii'] })), ['email']);
  assert.deepEqual(types(await scan(text, { minSeverity: 'high' })), ['bip39_mnemonic']);
});

test('clean text', async () => {
  const r = await redact('Summarize the attached quarterly report for the board.');
  assert.equal(r.verdict, 'CLEAN'); assert.equal(r.safe_to_send, true); assert.equal(r.redacted, 'Summarize the attached quarterly report for the board.');
});

test('fast enough for the Workers free plan on 50 KB', async () => {
  const big = ('Lorem ipsum dolor sit amet, contact ops@example.org about invoice 42. ').repeat(700);
  const t = performance.now(); const r = await redact(big); const ms = performance.now() - t;
  assert.equal(r.counts.email, 700); assert.ok(ms < 400, `${ms} ms`);
});
