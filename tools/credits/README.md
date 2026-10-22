# YourAITools Credits

Prepaid credits for the [YourAITools](https://youraitools.co/built-by-us) x402 agent APIs. Pay **once** over x402, get an API key, then call any of the tools with `Authorization: Bearer <key>`. Each call debits its normal per-call price, so there's no on-chain payment per call.

Live: https://api.youraitools.co/credits/ (also https://credits.agentgate.workers.dev)

| Route | Price | What you get |
|---|---|---|
| `GET\|POST /v1/pack/1` | $1 USDC | new key with $1.00 of credits |
| `GET\|POST /v1/pack/5` | $5 USDC | new key with $5.50 of credits (10% bonus) |
| `GET\|POST /v1/pack/sample` | $0.005 USDC | new key with $0.005 of credits (try the whole flow) |
| `GET\|POST /v1/topup/1`, `/v1/topup/5` | $1 / $5 | add $1.00 / $5.50 to an existing key (send the key) |
| `GET /v1/balance` | free | balance, spend per tool, recent calls (send the key) |
| `POST /v1/key/rotate` | free | move the balance to a new key; the old key stops working |
| `GET /v1/preview?pack=5`, `/v1/prices` | free | what a pack buys at today's prices |
| `POST /mcp` | free | remote MCP: `credits_quote`, `credits_balance` |

You can pay in USDC on Base, Polygon, Arbitrum One or Solana with x402 v2 (`PAYMENT-SIGNATURE`), or on Base with v1 (`X-PAYMENT`). A pack is settled only when its key is delivered: if settlement fails, the key is never shown and the account is deleted.

## Using a key

```bash
curl -s -H "Authorization: Bearer $KEY" "https://api.youraitools.co/payguard/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96"
# response headers: X-Credits-Charged: 0.001000, X-Credits-Remaining: 0.999000, X-Credits-Ref: r_...
```

- Accepted by every paid route of AgentGate, WebRead, InjectScan, DomainCheck, PayGuard, PkgGuard, StackDetect, TokenVerdict and SignCheck. The same key also works as `X-Credits-Key` or `X-Credit-Token`.
- A failed call (HTTP 400 or higher) is not charged; its debit goes back to the balance.
- When the balance is too low, the tool sends its normal x402 402 (the `PAYMENT-REQUIRED` terms are unchanged), plus `X-Credits-Error: insufficient_balance`, `X-Credits-Topup` and a `credits` hint in the JSON body.
- **Without a key nothing changes.** The x402 terms on every route are byte-identical to before. A HEAD request never spends credits.

## How it works

- **Accounts:** each key has its own SQLite-backed Durable Object (`CreditAccount`), named by the SHA-256 of the key. The key itself is never stored.
- **Debits:** a debit is a single Durable Object event (check plus write, protected by input gates), so concurrent calls can't overspend. Tests fire 200 concurrent debits.
- **Tool side:** the tools call the `CreditsGate` RPC entrypoint over a service binding. The tool-side code is `credits-gate.js`, a drop-in wrapper around `@x402/hono`'s `paymentMiddleware`.
- **Top-ups:** a top-up is held as pending inside the paid request and committed only after the x402 settlement succeeds.
- **Storage:** no KV writes. Counters use the same batched StatsCounter Durable Object as the tools.

## Terms

Credits are prepaid usage of the YourAITools APIs only, priced in USD at each route's normal per-call price. They are not money and not a token or investment. They have no cash value, can't be withdrawn and are not refundable. Whoever holds the key can spend the credits.

MIT licensed. `npm test` (node --test) · `wrangler deploy`.
