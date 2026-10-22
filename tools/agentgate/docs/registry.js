// AgentGate registry adapters.
//
// A "provider" answers one question: is this agent registered in the Concordium
// Agent Registry (CIS-8004), Active, and does its published Agent Card match the
// hash committed on-chain (i.e. is it "Verified by Concordium")?
//
// Real, public, documented backends used by ConcordiumPublicProvider:
//   - Badge-check REST (mainnet):  GET https://agent-registry-mcp.concordium.com/v1/badge-check/{badge|account}
//     docs: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/concordium-badge.html
//   - Hosted Agent Registry MCP (mainnet/testnet/devnet), JSON-RPC over HTTP: https://agent-registry-mcp.concordium.com/mcp
//     tools: agent_by_token_address, agents_by_owner, verify_agent_card
//     docs: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/mcp-service.html
//
// MockProvider is an in-memory provider for tests and the offline demo. It is
// NOT connected to any chain and must never be used to make real access decisions.

export const DEFAULT_BASE_URL = 'https://agent-registry-mcp.concordium.com';
export const NETWORKS = ['mainnet', 'testnet', 'devnet'];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Classify an identifier.
 * - CIS-2 token address (the badge string): short Base58Check, ~16-30 chars.
 * - Concordium account address: Base58Check, 50 chars.
 * - CAIP-19 badge form "ccd:<genesis>/cis-2:<short>" is accepted and reduced to <short>.
 * @param {string} input
 * @returns {{kind:'badge'|'account'|'invalid', value:string}}
 */
export function classifyId(input) {
  if (typeof input !== 'string') return { kind: 'invalid', value: String(input) };
  let v = input.trim();
  const caip = v.match(/\/cis-2:([1-9A-HJ-NP-Za-km-z]+)$/);
  if (caip) v = caip[1];
  if (!BASE58.test(v)) return { kind: 'invalid', value: v };
  if (v.length === 50) return { kind: 'account', value: v };
  if (v.length >= 12 && v.length <= 40) return { kind: 'badge', value: v };
  return { kind: 'invalid', value: v };
}

/**
 * Normalized result shape returned by every provider.
 * @typedef {Object} AgentCheck
 * @property {string} id            input as given (normalized)
 * @property {'badge'|'account'} kind
 * @property {string} network
 * @property {boolean} found        an on-chain CIS-8004 record exists
 * @property {boolean} active       status === 'Active'
 * @property {boolean|null} cardHashMatches  Agent Card SHA-256 equals on-chain metadata_hash (null = not checked)
 * @property {boolean} verified     found && active && cardHashMatches !== false
 * @property {string|null} tokenAddress
 * @property {string|number|null} tokenId
 * @property {string|null} owner     Concordium owner account
 * @property {string|null} agentWallet
 * @property {string|null} agentUri
 * @property {string} source        which backend answered ('concordium-badge-check' | 'concordium-mcp' | 'mock')
 * @property {boolean} mock         true only for MockProvider results
 * @property {Array<{severity:string,message:string}>} issues
 */

function emptyResult(id, kind, network, source, mock = false) {
  return {
    id, kind, network, found: false, active: false, cardHashMatches: null, verified: false,
    tokenAddress: kind === 'badge' ? id : null, tokenId: null, owner: kind === 'account' ? id : null,
    agentWallet: null, agentUri: null, source, mock, issues: [],
  };
}

function finalize(r) {
  r.verified = Boolean(r.found && r.active && r.cardHashMatches !== false);
  return r;
}

export class RegistryError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/** Provider backed by Concordium's public badge-check REST API and hosted MCP endpoint. */
export class ConcordiumPublicProvider {
  /**
   * @param {{baseUrl?:string, fetch?:typeof fetch, timeoutMs?:number, checkCard?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    // Never store the bare global fetch on `this`: Cloudflare Workers throws "Illegal invocation" when it is called as a method.
    const userFetch = opts.fetch;
    this.fetch = (url, init) => (userFetch ? userFetch(url, init) : globalThis.fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.checkCard = opts.checkCard ?? true;
    this.name = 'concordium-public';
    this._rpcId = 0;
  }

  async _fetch(url, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      throw new RegistryError(`registry request failed: ${e.message}`, { cause: e });
    } finally {
      clearTimeout(t);
    }
  }

  /** Call a tool on the hosted Agent Registry MCP server (stateless JSON-RPC over HTTP). */
  async callTool(name, args) {
    const res = await this._fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this._rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) throw new RegistryError(`MCP HTTP ${res.status}`, { status: res.status });
    let body = await res.text();
    // Tolerate an SSE-framed response ("data: {...}").
    if (body.startsWith('event:') || body.startsWith('data:')) {
      const line = body.split('\n').find((l) => l.startsWith('data:'));
      body = line ? line.slice(5).trim() : body;
    }
    const msg = JSON.parse(body);
    if (msg.error) throw new RegistryError(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`);
    const text = msg.result?.content?.[0]?.text ?? '';
    if (msg.result?.isError) return { isError: true, text };
    try { return { isError: false, data: JSON.parse(text) }; } catch { return { isError: false, data: text }; }
  }

  /**
   * @param {string} input badge (CIS-2 token address) or Concordium account address
   * @param {{network?:string}} [opts]
   * @returns {Promise<AgentCheck>}
   */
  async check(input, { network = 'mainnet' } = {}) {
    if (!NETWORKS.includes(network)) throw new RegistryError(`unknown network: ${network}`);
    const { kind, value } = classifyId(input);
    if (kind === 'invalid') {
      const r = emptyResult(value, 'badge', network, this.name);
      r.issues.push({ severity: 'error', message: 'not a CIS-8004 badge token address or Concordium account address' });
      return finalize(r);
    }
    // The badge-check REST endpoint serves mainnet (it reports "network":"mainnet").
    if (network === 'mainnet') return this._badgeCheck(value, kind);
    return this._viaMcp(value, kind, network);
  }

  async _badgeCheck(value, kind) {
    const res = await this._fetch(`${this.baseUrl}/v1/badge-check/${encodeURIComponent(value)}`, { headers: { accept: 'application/json' } });
    const r = emptyResult(value, kind, 'mainnet', 'concordium-badge-check');
    let body;
    try { body = await res.json(); } catch { throw new RegistryError(`badge-check HTTP ${res.status} (non-JSON)`, { status: res.status }); }
    if (res.status === 400 || res.status === 404) {
      r.issues.push({ severity: 'error', message: body?.message || `badge-check HTTP ${res.status}` });
      return finalize(r);
    }
    if (!res.ok) throw new RegistryError(`badge-check HTTP ${res.status}`, { status: res.status });
    if (kind === 'account') {
      // Account form: {agent_count, summary, agents:[{...badge result...}]}. Verified if any owned agent is valid.
      const agents = Array.isArray(body.agents) ? body.agents : [];
      const best = agents.find((a) => a.badge_valid) || agents.find((a) => a.on_chain?.status === 'Active') || agents[0];
      r.owner = value;
      r.agentCount = agents.length;
      if (!best) { r.issues.push({ severity: 'error', message: 'account owns no CIS-8004 agents' }); return finalize(r); }
      applyBadgeBody(r, best);
      r.owner = value;
      return finalize(r);
    }
    applyBadgeBody(r, body);
    return finalize(r);
  }

  async _viaMcp(value, kind, network) {
    const r = emptyResult(value, kind, network, 'concordium-mcp');
    let rec;
    if (kind === 'badge') {
      const out = await this.callTool('agent_by_token_address', { token_address: value, network });
      if (out.isError) { r.issues.push({ severity: 'error', message: out.text.slice(0, 300) }); return finalize(r); }
      rec = out.data;
    } else {
      const out = await this.callTool('agents_by_owner', { owner_account: value, network, limit: 50 });
      if (out.isError) { r.issues.push({ severity: 'error', message: out.text.slice(0, 300) }); return finalize(r); }
      const agents = out.data?.agents || [];
      r.agentCount = agents.length;
      rec = agents.find((a) => a.status === 'Active') || agents[0];
      if (!rec) { r.issues.push({ severity: 'error', message: 'account owns no CIS-8004 agents' }); return finalize(r); }
    }
    if (!rec || typeof rec !== 'object') return finalize(r);
    r.found = true;
    r.tokenId = rec.token_id_u64 ?? rec.token_id ?? null;
    r.tokenAddress = rec.token_address || r.tokenAddress;
    r.owner = rec.owner_account || null;
    r.agentWallet = rec.agent_wallet || null;
    r.agentUri = rec.agent_uri || null;
    r.active = rec.status === 'Active';
    if (!r.active) r.issues.push({ severity: 'error', message: `agent status is ${rec.status}` });
    if (this.checkCard && r.tokenId !== null) {
      if (!r.agentUri) {
        r.cardHashMatches = false;
        r.issues.push({ severity: 'error', message: 'agent has no agent_uri (no Agent Card to verify)' });
      } else {
        const v = await this.callTool('verify_agent_card', { token_id: String(r.tokenId), network });
        if (v.isError) r.issues.push({ severity: 'warning', message: `card check failed: ${v.text.slice(0, 200)}` });
        else {
          r.cardHashMatches = Boolean(v.data?.match);
          if (!r.cardHashMatches) r.issues.push({ severity: 'error', message: `Agent Card hash does not match on-chain metadata_hash (fetch HTTP ${v.data?.fetched?.http_status ?? '?'})` });
        }
      }
    }
    return finalize(r);
  }
}

function applyBadgeBody(r, b) {
  const oc = b.on_chain || {};
  const checks = b.checks || {};
  r.found = Boolean(checks.on_chain_agent_found ?? oc.status);
  r.tokenId = b.token_id ?? null;
  r.tokenAddress = b.token_address || r.tokenAddress;
  r.owner = oc.owner_account || r.owner;
  r.agentUri = b.agent_uri || oc.agent_uri || null;
  r.active = oc.status === 'Active' || checks.status_active === true;
  if ('hash_matches_on_chain' in checks) r.cardHashMatches = Boolean(checks.hash_matches_on_chain);
  r.badgeValid = b.badge_valid ?? null;
  for (const i of b.issues || []) r.issues.push({ severity: i.severity || 'info', message: i.message || String(i) });
  if (r.found && !r.active) r.issues.push({ severity: 'error', message: `agent status is ${oc.status || 'not Active'}` });
}

/**
 * MOCK provider. In-memory fixtures; no network, no chain.
 * Use for tests and the offline demo only.
 */
export class MockProvider {
  /** @param {Record<string, Partial<AgentCheck> & {status?:'Active'|'Revoked'}>} [agents] keyed by badge or account */
  constructor(agents = MockProvider.defaultFixtures()) {
    this.agents = agents;
    this.name = 'mock';
    this.calls = 0;
  }

  static defaultFixtures() {
    return {
      // Clearly fake identifiers (Base58 alphabet, but not real token addresses).
      MockVerifiedAgent1111: { status: 'Active', cardHashMatches: true, tokenId: 1, owner: 'MOCK-OWNER-1', agentWallet: 'MOCK-WALLET-1', agentUri: 'https://example.invalid/agents/1/agent-card.json' },
      MockRevokedAgent22222: { status: 'Revoked', cardHashMatches: true, tokenId: 2, owner: 'MOCK-OWNER-2', agentWallet: 'MOCK-WALLET-2' },
      MockTamperedCard33333: { status: 'Active', cardHashMatches: false, tokenId: 3, owner: 'MOCK-OWNER-3', agentWallet: 'MOCK-WALLET-3' },
    };
  }

  async check(input, { network = 'testnet' } = {}) {
    this.calls++;
    const { kind, value } = classifyId(input);
    const r = emptyResult(value, kind === 'invalid' ? 'badge' : kind, network, 'mock', true);
    r.issues.push({ severity: 'info', message: 'MOCK provider: result is fixture data, not from Concordium' });
    const a = this.agents[value];
    if (kind === 'invalid') { r.issues.push({ severity: 'error', message: 'invalid identifier' }); return finalize(r); }
    if (!a) { r.issues.push({ severity: 'error', message: 'agent not found (mock)' }); return finalize(r); }
    Object.assign(r, {
      found: true, active: a.status === 'Active', cardHashMatches: a.cardHashMatches ?? true,
      tokenId: a.tokenId ?? null, tokenAddress: kind === 'badge' ? value : null, owner: a.owner ?? null,
      agentWallet: a.agentWallet ?? null, agentUri: a.agentUri ?? null,
    });
    if (!r.active) r.issues.push({ severity: 'error', message: `agent status is ${a.status}` });
    if (r.cardHashMatches === false) r.issues.push({ severity: 'error', message: 'Agent Card hash does not match on-chain metadata_hash' });
    return finalize(r);
  }
}

/** Small TTL cache wrapper around any provider. */
export class CachedProvider {
  constructor(inner, { ttlMs = 60000, now = () => Date.now() } = {}) {
    this.inner = inner; this.ttlMs = ttlMs; this.now = now; this.map = new Map();
    this.name = `cached(${inner.name})`;
  }
  async check(input, opts = {}) {
    const key = `${opts.network || ''}:${input}`;
    const hit = this.map.get(key);
    if (hit && hit.exp > this.now()) return hit.value;
    const value = await this.inner.check(input, opts);
    this.map.set(key, { value, exp: this.now() + this.ttlMs });
    return value;
  }
}

/** Convenience: check an agent with the public Concordium provider. */
export async function checkAgent(input, { network = 'mainnet', provider } = {}) {
  return (provider || new ConcordiumPublicProvider()).check(input, { network });
}
