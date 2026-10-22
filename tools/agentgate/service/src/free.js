// Free tier: lets builders try AgentGate without a wallet.
//   GET  /v1/check-agent/preview?id=&network=   free, rate-limited, reduced response (the verdict)
//   POST /mcp                                   free remote MCP server (Streamable HTTP, stateless JSON), tool check_agent
//   GET  /v1/stats                              free usage counters
// The full record (owner account, agent wallet, Agent Card URI, token id, source) stays on the paid route.
import { classifyId, NETWORKS } from '../../src/registry.js';
import { isSmoke, waitUntilOf } from './stats.js';

export const PREVIEW_PATH = '/v1/check-agent/preview';
export const MCP_PATH = '/mcp';
export const STATS_PATH = '/v1/stats';
export const FREE_FIELDS = ['id', 'kind', 'network', 'found', 'active', 'verified', 'cardHashMatches', 'tokenAddress', 'issues'];

export function previewOf(r, paidUrl) {
  const out = Object.fromEntries(FREE_FIELDS.map((k) => [k, r[k] ?? null]));
  out.issues = (r.issues || []).map((i) => ({ severity: i.severity, message: i.message }));
  out.tier = 'free';
  out.full_record = { url: paidUrl, price: '0.005 USDC on Base (x402)', adds: ['owner', 'agentWallet', 'agentUri', 'tokenId', 'source'] };
  return out;
}

const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

/** Returns true when the caller is over the free limit. No limiter binding (Node/tests) => never limited. */
async function limited(limiter, c) {
  if (!limiter?.limit) return false;
  try { const { success } = await limiter.limit({ key: clientIp(c) }); return !success; } catch { return false; }
}

const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_TOOL = {
  name: 'check_agent',
  title: 'Check an AI agent in the Concordium Agent Registry',
  description: 'Check whether an AI agent is registered in the Concordium Agent Registry (CIS-8004), Active (not revoked), and Verified by Concordium (its Agent Card hash matches the on-chain metadata_hash). Accepts a badge (CIS-2 token address, e.g. Mf22soLh1NuZYFgBK8iSs, or CAIP-19 form) or a Concordium owner account address. Free tier: returns the verdict; the full record is available from the paid x402 endpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Badge (CIS-2 token address, short or CAIP-19 form) or Concordium account address' },
      network: { type: 'string', enum: NETWORKS, default: 'mainnet', description: 'Concordium network' },
    },
    required: ['id'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export function registerFreeRoutes(app, { provider, stats, limiter, paidPath, publicUrl, version = '0.2.3' }) {
  const paidUrl = (c) => `${(publicUrl || new URL(c.req.url).origin).replace(/\/$/, '')}${paidPath}`;
  const count = (c, ev) => { if (!isSmoke(c)) stats?.hit(ev, waitUntilOf(c)); };

  async function check(id, network) {
    if (!id || classifyId(id).kind === 'invalid') return { status: 400, body: { error: 'invalid_id', message: 'id must be a CIS-8004 badge (CIS-2 token address) or a Concordium account address' } };
    if (!NETWORKS.includes(network)) return { status: 400, body: { error: 'invalid_network', message: `network must be one of ${NETWORKS.join(', ')}` } };
    try { return { status: 200, result: await provider.check(id, { network }) }; } catch (e) { return { status: 502, body: { error: 'registry_unavailable', message: String(e.message || e) } }; }
  }

  app.get(PREVIEW_PATH, async (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    if (await limited(limiter, c)) { count(c, 'free_rate_limited'); c.header('Retry-After', '60'); return c.json({ error: 'rate_limited', message: `Free preview is limited per IP per minute. Use the paid endpoint for unlimited calls: ${paidUrl(c)}` }, 429); }
    const r = await check(c.req.query('id'), c.req.query('network') || 'mainnet');
    if (r.status !== 200) return c.json(r.body, r.status);
    count(c, 'free_preview');
    return c.json(previewOf(r.result, paidUrl(c)));
  });

  app.get(STATS_PATH, async (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(stats ? await stats.summary(30) : { enabled: false });
  });

  // Remote MCP (Streamable HTTP transport, stateless, JSON responses; no sessions, no SSE).
  app.get(MCP_PATH, (c) => c.json({ error: 'method_not_allowed', message: 'POST JSON-RPC to this endpoint (MCP Streamable HTTP, stateless).' }, 405, { Allow: 'POST' }));
  app.post(MCP_PATH, async (c) => {
    let msg;
    try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const batch = Array.isArray(msg);
    const replies = [];
    for (const m of batch ? msg : [msg]) {
      const reply = await handleRpc(m, c);
      if (reply) replies.push(reply);
    }
    if (!replies.length) return c.body(null, 202);
    return c.json(batch ? replies : replies[0]);
  });

  async function handleRpc(m, c) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const isNotification = m.id === undefined || m.id === null;
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id: m.id, result });
    const err = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return ok({
          protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentgate', title: 'AgentGate', version },
          instructions: 'check_agent reports whether an AI agent is registered, Active and Verified in the Concordium Agent Registry (CIS-8004).',
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: [MCP_TOOL] });
      case 'tools/call': {
        if (m.params?.name !== 'check_agent') return err(-32602, `Unknown tool: ${m.params?.name}`);
        if (await limited(limiter, c)) { count(c, 'free_rate_limited'); return ok({ isError: true, content: [{ type: 'text', text: `Free tier rate limit reached (per IP per minute). Retry in a minute, or use the paid x402 endpoint: ${paidUrl(c)}` }] }); }
        const a = m.params?.arguments || {};
        const r = await check(a.id, a.network || 'mainnet');
        if (r.status !== 200) return ok({ isError: true, content: [{ type: 'text', text: `${r.body.error}: ${r.body.message}` }] });
        count(c, 'free_mcp');
        const p = previewOf(r.result, paidUrl(c));
        const line = p.verified
          ? `VERIFIED: agent ${p.tokenAddress ?? p.id} on ${p.network} is registered, Active, and its Agent Card matches on-chain.`
          : `NOT VERIFIED: ${p.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ') || 'checks failed'}`;
        return ok({ content: [{ type: 'text', text: `${line}\n\n${JSON.stringify(p, null, 2)}` }], structuredContent: p, isError: false });
      }
      default:
        if (m.method.startsWith('notifications/')) return null;
        return err(-32601, `Method not found: ${m.method}`);
    }
  }
}
