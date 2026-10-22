#!/usr/bin/env node
// Benchmark InjectScan on public, permissively licensed data. Nothing is vendored; data is fetched and cached.
//   node scripts/benchmark.js [--write bench/results.json] [--cache .bench-cache]
//
// Labeled sets (precision / recall), from the Hugging Face datasets-server API:
//   deepset/prompt-injections (Apache-2.0)            train 546 / test 116, English + German, label 1 = injection
//   jackhhao/jailbreak-classification (Apache-2.0)    train 1044 / test 262, "jailbreak" vs "benign"
// Attack-only set (recall):
//   Lakera/gandalf_ignore_instructions (MIT)          test 112, real "ignore your instructions" attacks on Gandalf
// Benign-only corpora (false-positive rate on the kind of content agents read):
//   bench/benign-wikipedia.json  300 random English Wikipedia articles (REST HTML -> Markdown, fetched at run time)
//   bench/benign-readmes.json    150 GitHub READMEs pinned to a commit (technical docs: install commands, badges, keys)
//
// Honesty notes: rules were written while looking at the deepset and jackhhao TRAIN splits and at a different sample of
// Wikipedia articles and popular READMEs. The TEST splits, the Lakera set and the two benign corpora above were not
// used for tuning; they are the held-out numbers.
import { scan, THRESHOLDS } from '../src/detect.js';
import { RULESET_VERSION } from '../src/rules.js';
import { htmlToMarkdown } from '../src/html2md.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', '.bench-cache'); mkdirSync(CACHE, { recursive: true });
const UA = 'InjectScanBench/0.1 (+https://injectscan.agentgate.workers.dev)';
async function cached(key, fn) {
  const p = `${CACHE}/${key.replace(/[^a-z0-9._-]/gi, '_')}.json`;
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const v = await fn(); writeFileSync(p, JSON.stringify(v)); return v;
}
async function hfRows(dataset, split) {
  return cached(`hf-${dataset}-${split}`, async () => {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const j = await (await fetch(`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=100`)).json();
      out.push(...j.rows.map((x) => x.row));
      if (out.length >= j.num_rows_total || !j.rows.length) break;
    }
    return out;
  });
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }
async function wikipedia() {
  // Article HTML from the Wikimedia REST API, converted to Markdown with the same converter the url= mode uses.
  const { titles } = JSON.parse(readFileSync(new URL('../bench/benign-wikipedia.json', import.meta.url)));
  return cached('wikipedia', async () => (await pool(titles, 2, async (t) => {
    const u = `https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(t.replace(/ /g, '_'))}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(u, { headers: { 'user-agent': UA } });
      if (r.ok) return htmlToMarkdown(await r.text(), { baseUrl: 'https://en.wikipedia.org/wiki/' }).markdown;
      if (r.status === 404) return '';
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
    throw new Error(`Wikipedia fetch failed for ${t}`);
  })).filter((t) => t.length >= 200));
}
async function readmes() {
  const { repos } = JSON.parse(readFileSync(new URL('../bench/benign-readmes.json', import.meta.url)));
  return cached('readmes', async () => (await pool(repos, 6, async ({ repo, sha }) => {
    for (const f of ['README.md', 'readme.md', 'Readme.md']) { const r = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${f}`); if (r.ok) return r.text(); }
    return '';
  })).filter((t) => t.length >= 300));
}

const metrics = (pairs, th) => {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const [score, y] of pairs) { const p = score >= th; if (p && y) tp++; else if (p) fp++; else if (y) fn++; else tn++; }
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall ? 2 * precision * recall / (precision + recall) : null;
  const r3 = (x) => (x == null ? null : +x.toFixed(3));
  return { n: pairs.length, tp, fp, tn, fn, precision: r3(precision), recall: r3(recall), f1: r3(f1), fpr: tn + fp ? r3(fp / (tn + fp)) : null };
};
const run = (texts) => { const t0 = performance.now(); const s = texts.map((t) => scan(t, { detail: false }).risk_score / 100); return { s, avg_ms: +((performance.now() - t0) / texts.length).toFixed(3) }; };

const results = { ruleset: RULESET_VERSION, generated_at: new Date().toISOString(), thresholds: THRESHOLDS, rows: [] };
const add = (row) => { results.rows.push(row); const f = (x) => (x == null ? '  -  ' : x.toFixed(3)); console.log(`${row.dataset.padEnd(38)} ${row.split.padEnd(6)} ${row.role.padEnd(9)} ${row.threshold.padEnd(10)} P=${f(row.precision)} R=${f(row.recall)} F1=${f(row.f1)} FPR=${f(row.fpr)} n=${row.n} tp=${row.tp} fp=${row.fp} fn=${row.fn} ${row.avg_ms}ms`); };
const both = (base, pairs, avg_ms) => { for (const [name, th] of [['flagged', THRESHOLDS.suspicious], ['malicious', THRESHOLDS.malicious]]) add({ ...base, threshold: name, ...metrics(pairs, th), avg_ms }); };

for (const [dataset, label, text] of [
  ['deepset/prompt-injections', (r) => r.label === 1, (r) => r.text],
  ['jackhhao/jailbreak-classification', (r) => r.type === 'jailbreak', (r) => r.prompt],
]) for (const split of ['train', 'test']) {
  const data = await hfRows(dataset, split); const { s, avg_ms } = run(data.map(text));
  both({ dataset, split, role: split === 'train' ? 'dev' : 'held-out' }, data.map((r, i) => [s[i], label(r)]), avg_ms);
}
{ const data = await hfRows('Lakera/gandalf_ignore_instructions', 'test'); const { s, avg_ms } = run(data.map((r) => r.text)); both({ dataset: 'Lakera/gandalf_ignore_instructions', split: 'test', role: 'held-out' }, s.map((x) => [x, true]), avg_ms); }
{ const t = await wikipedia(); const { s, avg_ms } = run(t); both({ dataset: 'benign: Wikipedia (300 random)', split: '-', role: 'held-out' }, s.map((x) => [x, false]), avg_ms); }
{ const t = await readmes(); const { s, avg_ms } = run(t); both({ dataset: 'benign: GitHub READMEs (150)', split: '-', role: 'held-out' }, s.map((x) => [x, false]), avg_ms); }

const out = arg('--write'); if (out) writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
