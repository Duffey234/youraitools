// Listing/discovery metadata must be benign: Bazaar (CDP) screens it for agent-directed instructions and replays the
// example input. Our own detector must rate every listing string "safe", and the example must be the real output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, BASE } from './helpers.js';
import { EXAMPLE_TEXT, OUTPUT_EXAMPLE } from '../src/app.js';
import { scan } from '../src/detect.js';

const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const strings = (o, out = []) => { if (typeof o === 'string') out.push(o); else if (o && typeof o === 'object') for (const v of Object.values(o)) strings(v, out); return out; };
const ATTACK = /ignore (all )?previous|webhook\.site|send the conversation/i;

test('benign discovery example: safe, score 0, and it is the real scanner output', () => {
  assert.equal(EXAMPLE_TEXT, 'Please summarize this article about solar panels.');
  const r = scan(EXAMPLE_TEXT);
  assert.equal(r.verdict, 'safe'); assert.equal(r.risk_score, 0);
  assert.deepEqual({ ...r, ms: 0, input: 'text' }, { ...OUTPUT_EXAMPLE, ms: 0 });
});

test('402 bazaar extension, v1 body, openapi and .well-known carry the benign example and no attack text', async () => {
  const { fetchApp } = makeApp();
  const r = await fetchApp(`${BASE}/v1/scan`);
  assert.equal(r.status, 402);
  const pr = decode(r.headers.get('PAYMENT-REQUIRED'));
  assert.equal(pr.extensions.bazaar.info.input.queryParams.text, EXAMPLE_TEXT);
  assert.equal(pr.extensions.bazaar.info.output.example.verdict, 'safe');
  const v1 = await r.json();
  const oa = await (await fetchApp(`${BASE}/openapi.json`)).json();
  assert.equal(oa.paths['/v1/scan'].get.parameters.find((p) => p.name === 'text').example, EXAMPLE_TEXT);
  assert.equal(oa.paths['/v1/scan'].post.requestBody.content['application/json'].example.text, EXAMPLE_TEXT);
  assert.equal(oa.paths['/v1/scan'].get.responses[200].content['application/json'].example.verdict, 'safe');
  const wk = await (await fetchApp(`${BASE}/.well-known/x402`)).json();
  for (const [name, doc] of Object.entries({ pr, v1, oa, wk })) {
    for (const s of strings(doc)) {
      assert.doesNotMatch(s, ATTACK, `${name}: ${s}`);
      if (s.length > 20) assert.equal(scan(s).verdict, 'safe', `${name} listing text not rated safe: ${s.slice(0, 120)}`);
    }
  }
});

test('landing page demo uses the benign example', async () => {
  const { fetchApp } = makeApp();
  const html = await (await fetchApp(`${BASE}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /Please summarize this article about solar panels\./);
  assert.doesNotMatch(html, /webhook\.site\/abc/);
});
