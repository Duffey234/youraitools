# TokenVerdict: Base token safety check (honeypot, taxes, owner powers) for AI agents (x402 + MCP)

**Safety check for a Base ERC-20 token before an agent or app interacts with it.** SAFE is not a guarantee and not financial advice. TokenVerdict checks one ERC-20 token on Base mainnet and returns **SAFE / CAUTION / DANGER** with a 0-100 score, a confidence level, and the reasons behind it:

- **Sellability / honeypot:** a simulated buy, wallet-to-wallet transfer and sell against the token's real pool (one `eth_call` with state overrides; nothing is ever sent on chain). Covers Uniswap v2 forks, Aerodrome classic, concentrated-liquidity pools (Uniswap v3, Aerodrome Slipstream, PancakeSwap v3, Algebra) and Uniswap v4 (native ETH or ERC-20 quote). Returns **buy, transfer and sell tax** and round-trip loss.
- **Owner powers:** mint, blacklist, pause, tax and limit setters, trading switches, balance edits, upgradeable proxy (EIP-1967 / beacon / legacy), renounced or contract owner. Uses the verified ABI, or bytecode selectors when the source isn't verified.
- **Liquidity:** depth across pools (DexScreener plus on-chain Uniswap v2/v3/v4, Aerodrome and PancakeSwap lookups) and LP burn on the main v2-style pool.
- **Holders:** top-10 concentration, with pool balances backed out (GeckoTerminal snapshot).
- **Verified source** (Sourcify) and **age** (exact contract creation block, found on-chain).

Built for agents, wallets, Telegram/Discord bots and apps that need a safety check on a token they found five minutes ago before interacting with it. SAFE is not a guarantee and not financial advice.

- **Hosted API:** https://api.youraitools.co/tokenverdict (also at https://tokenverdict.agentgate.workers.dev)
- **Prices (USDC on Base over [x402](https://x402.org), no API key, no signup):** `/v1/lite` $0.005 (verdict + reasons), `/v1/quick` $0.015 (full report with evidence), `/v1/deep` $0.05 (multi-pool simulation, pool table, creation block, GeckoTerminal cross-check). Invalid addresses, non-contracts, non-ERC-20s and source outages are never charged.
- **Free:** `/v1/preview` (verdict, score, flag counts; 10/min per IP), a shareable card at `/t/<token>` and a remote MCP server.
- Start here (all our tools, MCP configs, code samples): https://agentgate-source.pages.dev/start/

## Honest limits

This is automated, informational risk screening, **not financial advice, not an audit, no guarantee**. A token that passes today can be changed tomorrow by whoever controls it (upgrades, tax changes, blacklists, liquidity pulls). Specifically:

- The simulation runs at the current block with a small trade size; time-based traps, per-wallet limits, cooldowns, block-number or `tx.origin` tricks and sells that only fail later or above some size can pass.
- Owner powers are detected from function names/selectors; obfuscated logic can hide them, and their presence doesn't mean they will be used.
- LP lock is only confirmed for burned LP tokens on v2-style pools; third-party lockers and concentrated-liquidity positions aren't checked.
- Market data comes from free public APIs that rate-limit. When they don't answer, TokenVerdict falls back to on-chain pool lookups (main DEXes, WETH/USDC pairs only) and marks the result `degraded: true` with lower confidence. Holder concentration may then be unknown.
- Base mainnet only.

## MCP (Claude Desktop, Cursor, Windsurf, any MCP client)

Remote (free preview tier):
```json
{ "mcpServers": { "tokenverdict": { "type": "http", "url": "https://api.youraitools.co/tokenverdict/mcp" } } }
```

Local stdio (this package):
```json
{ "mcpServers": { "tokenverdict": { "command": "npx", "args": ["-y", "@agentgate-builder/tokenverdict"] } } }
```

Tool: `check_token(token)`. Free by default (verdict, score, flag counts). For the full quick report on every call ($0.015), set `TOKENVERDICT_X402_PRIVATE_KEY` to a Base wallet key holding a little USDC, and add the optional peers:
```json
{ "mcpServers": { "tokenverdict": { "command": "npx", "args": ["-y", "-p", "@agentgate-builder/tokenverdict", "-p", "@x402/fetch", "-p", "@x402/evm", "-p", "viem", "tokenverdict"], "env": { "TOKENVERDICT_X402_PRIVATE_KEY": "0x..." } } } }
```
The stdio server only pays the TokenVerdict pay-to address, on Base, at most $0.02 per call.

Docker: `docker build -t tokenverdict-mcp . && docker run -i --rm tokenverdict-mcp`

## HTTP

```bash
# free preview
curl -s "https://api.youraitools.co/tokenverdict/v1/preview?token=0x532f27101965dd16442E59d40670FaF5eBB142E4"
# paid (any x402 client): GET ?token= or POST {"token": "0x..."}
curl -i "https://api.youraitools.co/tokenverdict/v1/quick?token=0x532f27101965dd16442E59d40670FaF5eBB142E4"   # 402 + PAYMENT-REQUIRED
```

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }] });
const r = await (await pay('https://api.youraitools.co/tokenverdict/v1/quick?token=0x...')).json();
if (r.verdict !== 'SAFE') console.log(r.verdict, r.score, r.reasons.map((x) => x.text));
```

Library (free preview):
```js
import { preview } from '@agentgate-builder/tokenverdict';
console.log(await preview('0x532f27101965dd16442e59d40670faf5ebb142e4'));
```

## Response (quick, abridged)

```json
{ "token": "0x826f…adeea", "symbol": "AYB", "verdict": "DANGER", "score": 0, "confidence": "high", "degraded": false,
  "reasons": [{ "severity": "danger", "code": "honeypot", "text": "HONEYPOT SIGNAL: a simulated buy worked but selling back failed (reverted: balance)." }, "…"],
  "checks": { "sellability": { "simulated": true, "buy_ok": true, "sell_ok": false, "buy_tax_pct": 0 }, "owner": {}, "powers": {}, "proxy": {}, "contract": {}, "liquidity": {}, "holders": {}, "age": {} },
  "limits": ["…"], "disclaimer": "Automated, informational risk signals … Not financial advice, not an audit, no guarantee …" }
```

## Self-hosting

Cloudflare Workers (free plan works): `npm install && npx wrangler deploy`. Set `PAY_TO`, prices and `FACILITATOR` (`payai` default, or `cdp` with `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` secrets) in `wrangler.toml`. The simulator contract is in `contracts/TVSim.sol` (`npm run build:sim` regenerates `src/simcode.js` with solc 0.8.26). Tests: `npm test` (offline, replaying recorded Base mainnet reports).

MIT. Part of the AgentGate tools by YourAITools: https://youraitools.co/built-by-us
