// Live check (no funds move): 402 terms on GET/POST/HEAD of the paid route and the free preview, via api.youraitools.co and workers.dev.
const bases = process.argv.slice(2).length ? process.argv.slice(2) : ['https://stackdetect.agentgate.workers.dev', 'https://api.youraitools.co/stackdetect'];
const dec = (h) => JSON.parse(Buffer.from(h, 'base64').toString());
const H = { 'x-stackdetect-smoke': '1' };
for (const b of bases) {
  const t0 = Date.now();
  const g = await fetch(`${b}/v1/detect?url=https://laravel.com`, { headers: H });
  const p = await fetch(`${b}/v1/detect`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'laravel.com' }) });
  const h = await fetch(`${b}/v1/detect`, { method: 'HEAD', headers: H });
  const t402 = Date.now() - t0;
  const v = await (await fetch(`${b}/v1/preview?url=https://laravel.com`, { headers: H })).json();
  const pg = dec(g.headers.get('payment-required'));
  console.log(b, 'GET', g.status, pg.accepts[0].amount, pg.resource.url, '| POST', p.status, '| HEAD', h.status, !!h.headers.get('payment-required'), `| 402s ${t402}ms`, '| preview', v.technology_count, (v.technologies || []).slice(0, 6).join(', '));
}
