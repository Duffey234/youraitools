#!/usr/bin/env node
// Refresh src/data/disposable.js from the npm package disposable-email-domains-js (CC0-1.0).
//   npm pack disposable-email-domains-js && tar xzf disposable-email-domains-js-*.tgz && node scripts/update-disposable.js package/dist/dict/disposable_email_blocklist.json
import { readFileSync, writeFileSync } from 'node:fs';
const src = process.argv[2];
if (!src) { console.error('usage: node scripts/update-disposable.js <disposable_email_blocklist.json>'); process.exit(2); }
const list = [...new Set(JSON.parse(readFileSync(src, 'utf8')).map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
writeFileSync(new URL('../src/data/disposable.js', import.meta.url), `// Disposable / throwaway email domains (${list.length} entries).\n// Source: npm disposable-email-domains-js (mirror of the community disposable-email-domains list), CC0-1.0.\n// Regenerate: node scripts/update-disposable.js\nexport const DISPOSABLE_COUNT = ${list.length};\nexport const DISPOSABLE_LIST = ${JSON.stringify(list.join('\n'))};\n`);
console.log(list.length, 'domains');
