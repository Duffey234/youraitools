# PayGuard: OFAC sanctions screening for crypto addresses (MCP server + x402 API)

> **Start here:** copy-paste MCP configs for Claude, Cursor and Windsurf, x402 client code, AgentKit and LangChain wrappers: https://agentgate-source.pages.dev/start/  
> API: https://api.youraitools.co/payguard · fallback (same Worker): https://payguard.agentgate.workers.dev · npm: `@agentgate-builder/payguard`

**OFAC SDN sanctions screening for crypto addresses, for AI agents and payment flows, paid per call over [x402](https://docs.x402.org).**
One call reports whether an address appears in the US Treasury OFAC Specially Designated Nationals (SDN) list, and if so which entity, which sanctions programs and since when.

- Live API: https://api.youraitools.co/payguard (fallback: https://payguard.agentgate.workers.dev)
- Price: **$0.001 USDC** per address (`/v1/address`), **$0.01 USDC** per batch of up to 50 (`/v1/batch`), on Base (eip155:8453). Invalid input is never charged.
- Free tier: `/v1/preview` (sanctioned true/false + chain guess) and a remote MCP server at `/mcp` (10 calls/min per IP).
- Local MCP (stdio): `npx -y @agentgate-builder/payguard`. Free and offline: the same verdict as the free preview (sanctioned true/false, match count, chain guess) from a bundled list snapshot. Optional full details through the paid API with your own wallet ([below](#mcp)).
- Source: https://agentgate-source.pages.dev/x402-payguard/ (MIT) · npm: [@agentgate-builder/payguard](https://www.npmjs.com/package/@agentgate-builder/payguard) · all our tools: https://youraitools.co/built-by-us

> Informational screening against public OFAC SDN data. Not legal advice and not a compliance program.

## Why

Agents are starting to send money: x402 payments, payouts, refunds, bounties. Paying an address that OFAC has
designated is the one mistake that is both easy to check and expensive to get wrong. OFAC publishes the addresses
it designates ("Digital Currency Address - ETH / XBT / TRX / USDT ..." identifiers in the SDN list); PayGuard turns
that file into a fast exact-match lookup with the context a human reviewer needs.

## Quick start

```bash
# Free preview (the sample is a Lazarus Group address from the SDN list; the second is the USDC contract on Base)
curl -s "https://api.youraitools.co/payguard/v1/preview?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96"
curl -s "https://api.youraitools.co/payguard/v1/preview?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# Paid: answers 402 with x402 terms; any x402 client pays it
curl -i "https://api.youraitools.co/payguard/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96"
```

```js
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.BUYER_KEY)) }],
});
const r = await (await pay('https://api.youraitools.co/payguard/v1/address?address=' + encodeURIComponent(recipient))).json();
if (r.sanctioned) holdForReview(recipient, r.matches);
```

### Response (`GET /v1/address`)

```json
{
  "address": "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
  "sanctioned": true,
  "match_count": 1,
  "matches": [{ "entity": "LAZARUS GROUP", "entity_type": "Entity", "sdn_uid": 27307, "programs": ["DPRK3"],
                "list_date": "2019-09-13", "listed_currency": "ETH", "listed_as": "Digital Currency Address - ETH" }],
  "chain": { "format": "evm-hex20", "guess": "evm", "checksum": "eip55", "checksum_valid": true, "checksum_address": "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" },
  "source": "US Treasury OFAC Specially Designated Nationals (SDN) list",
  "source_url": "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
  "list_updated_at": "2026-10-21",
  "list_age_days": 0,
  "sdn_address_count": 1050,
  "disclaimer": "Informational screening against the public OFAC SDN list ... Not legal advice. ..."
}
```

`POST /v1/batch {"addresses": [...]}` (1-50) returns `count`, `sanctioned_count`, `any_sanctioned` and one result per address.

### MCP

```json
{ "mcpServers": { "payguard": { "type": "http", "url": "https://api.youraitools.co/payguard/mcp" } } }
{ "mcpServers": { "payguard": { "command": "npx", "args": ["-y", "@agentgate-builder/payguard"] } } }
```

Tools `screen_address` (remote and stdio) and `screen_addresses` (stdio, up to 50).

| | Remote `/mcp` | stdio (npm), default | stdio with `PAYGUARD_X402_PRIVATE_KEY` |
|---|---|---|---|
| Cost | free, 10 calls/min per IP | free, offline, unlimited | $0.001 per address, $0.01 per batch (USDC on Base, from your wallet) |
| Returns | sanctioned true/false, match count, chain guess | same, from the list snapshot bundled in the installed version (`list_updated_at`) | full result: SDN entity, type, uid, programs, list date, checksum; list refreshed daily |

The free tiers don't include entity, program or date details. Those come from the paid endpoint https://api.youraitools.co/payguard/v1/address, which every offline result points to (`full_details`).

**Paid mode in the stdio server.** Set `PAYGUARD_X402_PRIVATE_KEY` (or `X402_PRIVATE_KEY`) to the private key of a Base wallet holding a little USDC, and add the optional x402 client packages:

```json
{ "mcpServers": { "payguard": {
  "command": "npx",
  "args": ["-y", "-p", "@agentgate-builder/payguard", "-p", "@x402/fetch", "-p", "@x402/evm", "-p", "viem", "payguard"],
  "env": { "PAYGUARD_X402_PRIVATE_KEY": "0x<key of a wallet with a few cents of USDC on Base>" } } } }
```

The server then pays the hosted API per call over x402 with [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch). Guards: Base USDC only, at most $0.01 per payment, and only to PayGuard's pay-to address. Invalid input is rejected locally and never paid for. If a paid call fails, you get the offline preview plus the error. Use a dedicated low-balance wallet: the key stays in your MCP client's config and is never logged or sent anywhere except as an x402 payment signature. `PAYGUARD_API_URL` overrides the endpoint (e.g. the workers.dev fallback).

### Library

```js
import { previewAddress } from '@agentgate-builder/payguard';
previewAddress('0x098B716B8Aaf21512996dC57EB0615e2383E2f96');
// { sanctioned: true, match_count: 1, chain: { guess: 'evm', ... }, tier: 'preview', full_details: 'https://api.youraitools.co/payguard/v1/address', ... }
```

Since 0.2.0 the npm package ships a lite snapshot (lookup keys and match counts only) and exports `previewAddress`, `previewBatch`, `normalizeAddress` and `invalidInput`. The full engine with entity details (`src/screen.js`) runs only in the hosted Worker. Before 0.2.0, the package bundled the full list and exported `screenAddress`.

## Data and matching

- Source: the official SDN files from `sanctionslistservice.ofac.treas.gov` (`SDN.XML` for names, programs and every `Digital Currency Address - XXX` id; `SDN_ADVANCED.XML` for the date each entry was added). No third-party mirrors.
- `scripts/build-sdn.py` builds `src/data/sdn.js`; `scripts/refresh.sh` runs daily, and redeploys only when the list changed (with a guard against truncated downloads).
- Exact match. `0x` EVM hex and bech32 / cashaddr addresses are case-insensitive; base58 formats (BTC legacy, TRX, SOL, LTC, XMR ...) are matched exactly. `ethereum:` / `bitcoin:` style URI prefixes are stripped.
- Chain guess and checksum: EIP-55, base58check (BTC, LTC, DOGE, DASH, BTG, TRX, ZEC), bech32 / bech32m, cashaddr, XRP; Solana and Monero are recognised by format.

## Honest limits

- Only addresses OFAC publishes are matched. A clear result does not mean an address or its owner is unsanctioned: sanctions also cover persons and property that OFAC does not list by address, and funds can be one hop away.
- No EU / UK / UN lists and no on-chain exposure analysis.
- Inputs are looked up in memory and not stored or logged.

## Routes

| Route | Price | |
|---|---|---|
| `GET\|POST /v1/address` | $0.001 | full screening result |
| `POST /v1/batch` | $0.01 | up to 50 addresses |
| `GET\|POST /v1/preview` | free, 10/min/IP | sanctioned true/false + chain guess |
| `POST /mcp` | free, 10/min/IP | remote MCP, `screen_address` |
| `GET /v1/list`, `/v1/stats`, `/health` | free | list date and counts, usage counters |
| `GET /openapi.json`, `/.well-known/x402` | free | discovery |

x402 v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`) clients both work; only HTTP 200 responses are settled.

## Testnet payment routes (Solana devnet, Stellar testnet, GOAT Network Testnet3)

The same full screening result, paid on test networks. They are separate routes, so the Base mainnet terms above are unchanged. Solana and Stellar use the official x402 packages (`@x402/svm`, `@x402/stellar`) and the public, free [x402.org facilitator](https://x402.org/facilitator/supported), which pays the network fee. No real money moves. GOAT Testnet3 uses the standard EVM `exact` scheme (`@x402/evm`) with our own small facilitator; see [GOAT Network Testnet3](#goat-network-testnet3) below.

| Route | Network (CAIP-2) | Price | Pays to | Facilitator |
|---|---|---|---|---|
| `GET\|POST /solana-devnet/v1/address` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (v1 name `solana-devnet`) | 0.001 devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 1000 atomic) | `DmeY2NNcgbgSd2S7HTipepnCnFsfF6bhmBEms3ctknkq` | x402.org (fee payer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`) |
| `GET\|POST /stellar-testnet/v1/address` | `stellar:testnet` | 0.01 XLM (native XLM Stellar Asset Contract `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`, 100000 stroops) | `GD2I22CZ7K6BJR2JLN54LDM7TSXFSMTDWYFPJECWXZOHK3TFM6PEX44I` | x402.org (fees sponsored) |
| `GET\|POST /goat-testnet3/v1/address` | `eip155:48816` (GOAT Testnet3, chain id 48816) | 0.001 tUSDC (`0x4aa7292d13801011C3A638CA2C16fFa85a06Bc43`, 1000 atomic) or 0.001 GOAT test USDC (`0x29D1Ee93e9ecf6E50F309f498e40a6b42D352Fa1`) | `0x35A4577c2Bd3c6dC283285c879C3E5cfD252C6a1` | own: [goat-facilitator](https://goat-facilitator.agentgate.workers.dev) (signer `0x7730c7b13e10440dda3A2700845e7cE4dF901df4`, pays gas) |

Base URL: `https://api.youraitools.co/payguard` (or `https://payguard.agentgate.workers.dev`). All three routes speak x402 v2 only (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`).

```bash
# 402 terms (base64 JSON in the PAYMENT-REQUIRED header)
curl -si 'https://api.youraitools.co/payguard/solana-devnet/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96'
curl -si 'https://api.youraitools.co/payguard/stellar-testnet/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96'
curl -si 'https://api.youraitools.co/payguard/goat-testnet3/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96'

# Pay and get the result (scripts in this repo, npm install first)
SOLANA_KEYPAIR=./devnet-payer.json node scripts/solana-devnet-pay.mjs      # needs devnet USDC (faucet.circle.com, Solana Devnet); no SOL needed
STELLAR_SECRET_FILE=./stellar-payer.txt node scripts/stellar-testnet-pay.mjs # file has a line secret=S...; fund the account with Friendbot
GOAT_PAYER_FILE=./goat-payer.txt node scripts/goat-testnet3-pay.mjs        # file has a line private_key=0x...; needs tUSDC only (no gas)
```

Client code (Stellar; Solana is the same with `ExactSvmScheme` from `@x402/svm/exact/client` and a `@solana/kit` signer):

```js
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

const signer = createEd25519Signer(process.env.STELLAR_SECRET, 'stellar:testnet');
const client = x402Client.fromConfig({
  schemes: [{ network: 'stellar:testnet', client: new ExactStellarScheme(signer) }],
  // XLM is not a default x402 asset, so opt in to it (cap 0.1 XLM per payment)
  spendControls: { allowedAssets: [{ network: 'stellar:testnet', asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', maxAmountPerPayment: '1000000' }] },
});
const pay = wrapFetchWithPayment(fetch, client);
const res = await pay('https://api.youraitools.co/payguard/stellar-testnet/v1/address?address=0x098B716B8Aaf21512996dC57EB0615e2383E2f96');
console.log(res.status, await res.json()); // 200, sanctioned: true (LAZARUS GROUP, DPRK3), payment.network "stellar:testnet"
```

### GOAT Network Testnet3

- Network: GOAT Testnet3, CAIP-2 `eip155:48816` (chain id 48816 / 0xBEB0), RPC `https://rpc.testnet3.goat.network`, explorer https://explorer.testnet3.goat.network. Native gas is testnet BTC.
- Scheme: standard x402 v2 `exact` for EVM (EIP-3009 `transferWithAuthorization`, `@x402/evm` `ExactEvmScheme`). The payer signs only; nothing needs gas on the payer side.
- Facilitator: our own small one, https://goat-facilitator.agentgate.workers.dev (`GET /supported`, `POST /verify`, `POST /settle`), built on `@x402/core` `x402Facilitator` + `@x402/evm` `ExactEvmScheme`. It pays the testnet BTC gas and only settles the two tokens below, to PayGuard's receiver, up to 1 token per payment. Source: [x402-goat-facilitator](https://agentgate-source.pages.dev/x402-goat-facilitator/). This is not a GoatX402 merchant integration.
- Tokens (both 6 decimals, EIP-712 version "1"): `tUSDC` "PayGuard Test USD" `0x4aa7292d13801011C3A638CA2C16fFa85a06Bc43` (our EIP-3009 test token; anyone can call `faucet()` or `faucetTo(address)` for 10 tUSDC per address per day), and GOAT's x402 test USDC `0x29D1Ee93e9ecf6E50F309f498e40a6b42D352Fa1` ("USD Coin"; owner-mint only, so it's accepted for wallets that already hold it). We used our own token because GOAT's test USDC has no public faucet.
- Client: same as the Stellar example, with `new ExactEvmScheme(toClientEvmSigner(account, publicClient))` from `@x402/evm/exact/client` and `spendControls.allowedAssets: [{ network: 'eip155:48816', asset: '0x4aa7292d13801011C3A638CA2C16fFa85a06Bc43', maxAmountPerPayment: '10000' }]` (see scripts/goat-testnet3-pay.mjs).

Proven payments:

- Stellar testnet, Oct 22 2026 02:07 UTC: HTTP 200 with the full result; settlement tx [`311982af…09e0bc`](https://stellar.expert/explorer/testnet/tx/311982af293de5a99037f0ea8374665bd8a607d33ca5e8d317153ab0db09e0bc) (ledger 5322251).
- Solana devnet: proven. A live paid call settled through the x402.org facilitator and returned the full result (HTTP 200): [devnet transaction](https://explorer.solana.com/tx/3fttUoonvKCLfNfQ2YDZgqXBSUC75N1WgE7ajvodxmqkumar2QZbqTtcM2B4fVUU98vq4bEY722mRsVUtqvQJdrn?cluster=devnet).
- GOAT Testnet3, Oct 22 2026 12:26 UTC (SELF test payment): HTTP 200 with the full result; settlement tx [`0xcbb856ff…d87cbb`](https://explorer.testnet3.goat.network/tx/0xcbb856ffcb47419c7f7d977f84f5b37b49d5d87ea5cdea0b16416990cbd87cbb) (block 17677590, 0.001 tUSDC from `0x7EBC…2f69` to `0x35A4…C6a1`, gas paid by our facilitator).

## Develop

```bash
npm install
npm test                    # engine (real bundled list), x402 v2 + v1, proxy, CDP facilitator switch, MCP, stdio free + paid mode
npm run build:lite          # regenerate src/data/sdn-lite.js (also runs on prepack)
npm run build:sdn           # rebuild the list from Treasury
node scripts/injectscan-listing.mjs   # listing text through InjectScan's rules
npx wrangler deploy
```

MIT licensed.
