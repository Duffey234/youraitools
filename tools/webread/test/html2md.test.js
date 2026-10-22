import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, decodeEntities } from '../src/html2md.js';

test('converts main content: headings, links (absolute), lists, code, tables; drops chrome and scripts', () => {
  const h = `<html lang="en"><head><title>T &amp; U</title><meta property="og:description" content="D"></head><body><nav>NAV</nav><div role="navigation">MENU</div>
  <main><h2>Sub</h2><p>A <strong>b</strong> <em>c</em> <a href="/x?y=1">link</a> <a href="javascript:alert(1)">js</a></p><ol><li>one</li><li>two</li></ol>
  <pre><code>x  = 1</code></pre><table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table><img src="i.png" alt="pic"><div hidden>secret</div></main>
  <aside>ADS</aside><script>evil()</script><style>.x{}</style></body></html>`;
  const r = htmlToMarkdown(h, { baseUrl: 'https://ex.com/d/p' });
  assert.equal(r.title, 'T & U'); assert.equal(r.description, 'D'); assert.equal(r.lang, 'en');
  for (const s of ['## Sub', '**b**', '_c_', '[link](https://ex.com/x?y=1)', '1. one', '2. two', '```\nx  = 1\n```', '| K | V |', '| --- | --- |', 'pic'])
    assert.ok(r.markdown.includes(s), `missing ${JSON.stringify(s)} in\n${r.markdown}`);
  for (const s of ['NAV', 'MENU', 'ADS', 'evil', '.x{}', 'secret', 'javascript:']) assert.ok(!r.markdown.includes(s), `should drop ${s}`);
});

test('entities, whitespace collapsing and truncation', () => {
  assert.equal(decodeEntities('&lt;a&gt; &#169; &#x1F600; &nbsp;&bogus;'), '<a> © 😀  &bogus;');
  const r = htmlToMarkdown(`<body><p>${'word '.repeat(1000)}</p></body>`, { maxChars: 100 });
  assert.equal(r.markdown.length, 100); assert.equal(r.truncated, true);
});

test('large page converts in bounded time (no quadratic paths)', () => {
  const big = '<body><main>' + Array.from({ length: 20000 }, (_, i) => `<p>Para ${i} <a href="/l${i}">l${i}</a> <b>x</b></p>`).join('') + '</main></body>';
  const t = performance.now(); const r = htmlToMarkdown(big, { baseUrl: 'https://ex.com/' }); const ms = performance.now() - t;
  assert.ok(r.links === 20000); assert.ok(ms < 400, `took ${ms} ms`);
});
