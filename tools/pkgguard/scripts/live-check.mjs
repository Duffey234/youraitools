// Live check (no funds move): 402 terms on both paid routes and the free preview, via api.youraitools.co and workers.dev.
const bases = process.argv.slice(2).length ? process.argv.slice(2) : ['https://pkgguard.agentgate.workers.dev', 'https://api.youraitools.co/pkgguard'];
const dec = (h) => JSON.parse(Buffer.from(h, 'base64').toString());
for (const b of bases) {
  const t0 = Date.now();
  const s = await fetch(`${b}/v1/scan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pkgguard-smoke': '1' }, body: JSON.stringify({ manifest: '{"dependencies":{"lodash":"4.17.15"}}' }) });
  const p = await fetch(`${b}/v1/package?ecosystem=npm&name=lodash&version=4.17.15`, { headers: { 'x-pkgguard-smoke': '1' } });
  const v = await (await fetch(`${b}/v1/preview?ecosystem=npm&name=lodash&version=4.17.15`, { headers: { 'x-pkgguard-smoke': '1' } })).json();
  const ps = dec(s.headers.get('payment-required')), pp = dec(p.headers.get('payment-required'));
  console.log(b, s.status, ps.accepts[0].amount, ps.resource.url, '|', p.status, pp.accepts[0].amount, pp.resource.url, '| preview', v.verdict, v.advisory_count, `${Date.now() - t0}ms`);
}
