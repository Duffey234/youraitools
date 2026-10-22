import { readFileSync } from 'node:fs';
export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Build a fake fetch that routes by URL / MCP tool name. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/mcp')) {
      const msg = JSON.parse(init.body);
      const h = routes.mcp?.[msg.params.name];
      if (!h) return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no route' } });
      const out = typeof h === 'function' ? h(msg.params.arguments) : h;
      const result = out.isError ? { content: [{ type: 'text', text: out.text }], isError: true } : { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false };
      return json(200, { jsonrpc: '2.0', id: msg.id, result });
    }
    for (const [k, v] of Object.entries(routes.rest || {})) if (url.includes(k)) return json(v.status ?? 200, v.body);
    return json(404, { error: 'not_found' });
  };
  fn.calls = calls;
  return fn;
}
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
