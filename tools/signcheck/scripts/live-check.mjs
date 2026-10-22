// Live check (no funds move): 402 terms on GET/POST/HEAD of the paid route and the free preview, via api.youraitools.co and workers.dev.
const bases = process.argv.slice(2).length ? process.argv.slice(2) : ['https://signcheck.agentgate.workers.dev', 'https://api.youraitools.co/signcheck'];
const dec = (h) => JSON.parse(Buffer.from(h, 'base64').toString());
const H = { 'x-signcheck-smoke': '1' };
const TX = { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b30000000000000000000000003c1a1e01e790cd326495631b3b38bd7068f08d6fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
for (const b of bases) {
  const t0 = Date.now();
  const g = await fetch(`${b}/v1/check?${new URLSearchParams(TX)}`, { headers: H });
  const p = await fetch(`${b}/v1/check`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ tx: TX }) });
  const h = await fetch(`${b}/v1/check`, { method: 'HEAD', headers: H });
  const t402 = Date.now() - t0;
  const v = await (await fetch(`${b}/v1/preview`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ tx: TX }) })).json();
  const pg = dec(g.headers.get('payment-required'));
  console.log(b, 'GET', g.status, pg.accepts[0].amount, pg.resource.url, '| POST', p.status, '| HEAD', h.status, !!h.headers.get('payment-required'), `| 402s ${t402}ms`, '| preview', v.verdict, v.summary, JSON.stringify(v.flags));
}
