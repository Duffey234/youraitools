# LeakGuard: stop AI agents leaking secrets

Agents paste logs, configs and tool outputs into LLMs, tools and webhooks all day, and sometimes a **seed phrase, private key
or API key** goes with them. LeakGuard checks text or a JSON payload **before it leaves**:

- **Wallet keys (critical):** BIP39 seed phrases (checksum verified), EVM private keys in context, Solana keypairs (JSON byte
  arrays and base58, verified as real ed25519 keypairs), Bitcoin WIF and BIP32 xprv (base58check).
- **Credentials:** GitHub, GitLab, AWS, Stripe, OpenAI, Anthropic, Google, Slack, Discord and Slack webhooks, Telegram bot
  tokens, SendGrid, npm, Hugging Face, Twilio, JWT, PEM private keys, credentials in URLs, `password=` / `api_key=` assignments.
- **PII:** cards (Luhn), IBAN (mod-97), US SSN, email, phone, public IPv4.

You get a verdict (`WALLET_KEY_EXPOSED` / `SECRETS_FOUND` / `PII_FOUND` / `CLEAN`), `safe_to_send`, findings with masked
previews (never the secret), a remediation line per finding and the redacted text. The **deep scan** also takes JSON payloads
(findings by JSON path, `redacted_json` with the same shape) and, for every leaked seed phrase or private key, derives the
public addresses it controls and reports native + USDC balances on Base, Ethereum, Polygon, Arbitrum One and Solana:
`funds_at_risk`, `used_empty`, `no_funds_found` or `unknown`.

InjectScan guards what comes **in** to an agent; LeakGuard guards what goes **out**.

## Hosted API (x402)

| Route | Price | What |
|---|---|---|
| `POST /v1/lite` `{"text": "..."}` | $0.005 | verdict, findings, remediation, redacted text (text up to 32 KB) |
| `POST /v1/scan` `{"text": "..."}` or `{"json": ...}` | $0.02 | lite + JSON payloads + leaked-wallet exposure + ordered actions (up to 256 KB) |
| `GET|POST /v1/preview` | free | verdict, safe_to_send, counts (8 KB, 10/min per IP) |
| `POST /mcp` | free | remote MCP, tool `scan_for_leaks` (preview tier) |

Base URL: https://api.youraitools.co/leakguard (fallback https://leakguard.agentgate.workers.dev). Pay in USDC with x402 v2
(Base, Solana, Polygon, Arbitrum One) or v1 (Base), or with a prepaid YourAITools credits key (`Authorization: Bearer yatc_...`).
Invalid or oversized input is never charged; only HTTP 200 results are settled. `GET ?text=` works too, but prefer POST for
anything sensitive.

**Privacy:** inputs are processed in memory for the duration of the request only: never logged, stored, cached or forwarded.
Only public addresses derived from leaked keys are sent to public RPCs (deep scan).

**Fail-closed:** if a balance lookup fails or times out, the wallet is `unknown` (assume funds at risk), the chain is listed in
`sources_failed` and `confidence` is `low`. It is never reported as empty.

## Local (offline, free)

```js
import { redact } from '@agentgate-builder/leakguard';   // zero dependencies; Node 20+, Workers, browsers
const r = await redact(text, { style: 'mask' });
// { verdict, safe_to_send, max_severity, counts, findings[], redacted }
```

MCP (stdio): `{ "mcpServers": { "leakguard": { "command": "npx", "args": ["-y", "@agentgate-builder/leakguard"] } } }`.
Tools `scan_for_leaks` and `redact_text` run locally. With `LEAKGUARD_X402_PRIVATE_KEY` set (and `@x402/fetch`, `@x402/evm`,
`viem` installed next to it) the server adds `check_leaked_wallets`, which pays the hosted deep scan ($0.02 USDC on Base;
spend guard: Base only, at most $0.02 per payment, only to the LeakGuard payee).

Docker: `docker build -t leakguard-mcp . && docker run -i --rm leakguard-mcp`.

## Limits

Pattern and validator based detection: it can miss secrets in unknown formats and can flag look-alikes. A clean result is not
a guarantee. Balances are a point-in-time lookup of native coin and USDC only; BIP39 passphrases and non-default derivation
paths are not covered; at most 8 addresses per scan.

MIT. BIP39 wordlist from @scure/bip39 (MIT). Source: https://agentgate-source.pages.dev/x402-leakguard/
