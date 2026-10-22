// Record the example outputs used in the Bazaar declaration, OpenAPI and landing page (public test vectors only:
// the BIP39 spec mnemonic and the AWS documentation example key). Live balances at recording time.
//   node tools/gen-examples.mjs
import { writeFileSync } from 'node:fs';
import { liteScan, deepScan } from '../src/scan.js';
const EXAMPLE_TEXT = 'agent log: restored wallet from seed abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about; aws key AKIAIOSFODNN7EXAMPLE; contact ops@example.com';
const lite = await liteScan(EXAMPLE_TEXT);
const scan = await deepScan({ text: EXAMPLE_TEXT });
const strip = (r) => { const o = { ...r }; delete o.disclaimer; return o; };
writeFileSync(new URL('../src/examples.js', import.meta.url), `// Example input/outputs for the Bazaar discovery declaration, OpenAPI and landing page (public test vectors: BIP39 spec mnemonic,\n// AWS docs example key; recorded ${new Date().toISOString()} by tools/gen-examples.mjs).\nexport const EXAMPLE_TEXT = ${JSON.stringify(EXAMPLE_TEXT)};\nexport const LITE_EXAMPLE = ${JSON.stringify(strip(lite))};\nexport const SCAN_EXAMPLE = ${JSON.stringify(strip(scan))};\n`);
console.log(lite.verdict, scan.verdict, scan.exposure.status, scan.sources_failed, JSON.stringify(scan).length);
