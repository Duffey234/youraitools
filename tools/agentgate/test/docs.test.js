import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('docs/registry.js is an exact copy of src/registry.js (run: npm run sync-docs)', () => {
  assert.equal(readFileSync(new URL('../docs/registry.js', import.meta.url), 'utf8'), readFileSync(new URL('../src/registry.js', import.meta.url), 'utf8'));
});

test('checker page imports the shared registry module and shows the support wallet', () => {
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(html, /from '\.\/registry\.js'/);
  assert.match(html, /0x3c1A1E01e790Cd326495631B3b38Bd7068F08d6F/);
});
