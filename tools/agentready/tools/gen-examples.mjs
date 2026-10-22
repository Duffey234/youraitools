// Record example outputs for the Bazaar discovery declaration, OpenAPI and landing page from a real audit run.
//   node tools/gen-examples.mjs   (writes src/examples.js)
import { writeFileSync } from 'node:fs';
import { auditSite, liteView } from '../src/audit.js';
const URL_ = 'https://example.com';
const r = await auditSite(URL_);
const lite = liteView(r);
const audit = { ...r, tier: 'audit', checks: r.checks.map(({ evidence, ...c }) => c), limits: undefined };
delete audit.limits;
writeFileSync(new URL('../src/examples.js', import.meta.url), `// Example input/outputs for the Bazaar discovery declaration, OpenAPI and landing page (example.com, recorded ${r.checked_at}).\nexport const EXAMPLE_URL = '${URL_}';\nexport const LITE_EXAMPLE = ${JSON.stringify(lite)};\nexport const AUDIT_EXAMPLE = ${JSON.stringify(audit)};\n`);
console.log(r.score, r.grade, r.sources_failed, JSON.stringify(lite).length, JSON.stringify(audit).length);
