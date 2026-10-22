// Discovery documents served by the Worker: GET /openapi.json (x402scan OpenAPI-first discovery),
// GET /.well-known/x402 (x402scan compatibility manifest), and /favicon.ico + /favicon.svg.
// Generated from the YourAITools draft (crypto/youraitools/guides/openapi/agentgate.openapi.json); price, server URL and payment
// terms are filled in from the live config so the docs can't drift from the 402 challenge.
import { SERVICE_META } from './service-meta.js';
const BASE = {
 "openapi": "3.1.0",
 "info": {
  "title": "AgentGate",
  "version": "0.2.3",
  "description": "Checks whether an AI agent is registered, Active and Verified in the Concordium Agent Registry (CIS-8004).",
  "x-guidance": "Usage: GET /v1/check-agent?id=<badge or Concordium account>&network=mainnet returns a Concordium Agent Registry verdict for an AI agent. $0.005 USDC on Base via x402. verified=true means registered, Active and Agent Card hash matches on-chain. Free verdict-only preview: GET /v1/check-agent/preview.",
  "contact": {
   "email": "hello@youraitools.co"
  }
 },
 "servers": [
  {
   "url": "https://agentgate.agentgate.workers.dev"
  }
 ],
 "paths": {
  "/v1/check-agent": {
   "get": {
    "operationId": "check_agent",
    "summary": "Concordium Agent Registry verdict + full record",
    "tags": [
     "paid"
    ],
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.005"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
    },
    "parameters": [
     {
      "name": "id",
      "in": "query",
      "required": true,
      "schema": {
       "type": "string"
      },
      "description": "Badge (CIS-2 token address, short or CAIP-19 form) or Concordium account address",
      "example": "Mf22soLh1NuZYFgBK8iSs"
     },
     {
      "name": "network",
      "in": "query",
      "required": false,
      "schema": {
       "type": "string",
       "enum": [
        "mainnet",
        "testnet",
        "devnet"
       ],
       "default": "mainnet"
      }
     }
    ],
    "responses": {
     "200": {
      "description": "Success (payment settled)",
      "content": {
       "application/json": {
        "schema": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string"
          },
          "kind": {
           "type": "string"
          },
          "network": {
           "type": "string"
          },
          "found": {
           "type": "boolean"
          },
          "active": {
           "type": "boolean"
          },
          "cardHashMatches": {
           "type": [
            "boolean",
            "null"
           ]
          },
          "verified": {
           "type": "boolean"
          },
          "tokenAddress": {
           "type": [
            "string",
            "null"
           ]
          },
          "tokenId": {
           "type": [
            "integer",
            "null"
           ]
          },
          "owner": {
           "type": [
            "string",
            "null"
           ]
          },
          "agentWallet": {
           "type": [
            "string",
            "null"
           ]
          },
          "agentUri": {
           "type": [
            "string",
            "null"
           ]
          },
          "source": {
           "type": "string"
          },
          "mock": {
           "type": "boolean"
          },
          "issues": {
           "type": "array"
          }
         }
        }
       }
      }
     },
     "400": {
      "description": "Invalid input (never charged)"
     },
     "402": {
      "description": "Payment Required (x402 v2 terms in the PAYMENT-REQUIRED header)"
     }
    }
   }
  },
  "/v1/check-agent/preview": {
   "get": {
    "operationId": "check_agent_preview",
    "summary": "Free verdict-only preview (20/min/IP)",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     },
     "429": {
      "description": "Free tier rate limit reached"
     }
    },
    "parameters": [
     {
      "name": "id",
      "in": "query",
      "required": true,
      "schema": {
       "type": "string"
      },
      "description": "Badge (CIS-2 token address, short or CAIP-19 form) or Concordium account address",
      "example": "Mf22soLh1NuZYFgBK8iSs"
     },
     {
      "name": "network",
      "in": "query",
      "required": false,
      "schema": {
       "type": "string",
       "enum": [
        "mainnet",
        "testnet",
        "devnet"
       ],
       "default": "mainnet"
      }
     }
    ]
   }
  },
  "/health": {
   "get": {
    "operationId": "health",
    "summary": "Health",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     }
    }
   }
  },
  "/v1/stats": {
   "get": {
    "operationId": "stats",
    "summary": "Public usage counters",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     }
    }
   }
  },
  "/mcp": {
   "post": {
    "operationId": "mcp",
    "summary": "Remote MCP (Streamable HTTP)",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     }
    }
   }
  },
  "/openapi.json": {
   "get": {
    "operationId": "openapi",
    "summary": "This OpenAPI document",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     }
    }
   }
  },
  "/.well-known/x402": {
   "get": {
    "operationId": "x402_manifest",
    "summary": "x402 discovery manifest (paid resources)",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     }
    }
   }
  },
  "/lax-offer.json": {
   "get": {
    "operationId": "lax_offer",
    "summary": "Kognai LAX registry offer",
    "security": [],
    "responses": {
     "200": {
      "description": "OK"
     }
    }
   }
  }
 }
};

export const FAVICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 128 128\" width=\"128\" height=\"128\" role=\"img\" aria-label=\"AgentGate\">\n  <title>AgentGate</title>\n  <rect width=\"128\" height=\"128\" rx=\"28\" fill=\"#0f172a\"/>\n  <path d=\"M30 100V54a34 34 0 0 1 68 0v46\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"10\" stroke-linecap=\"round\"/>\n  <path d=\"M48 100V58a16 16 0 0 1 32 0v42\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"8\" stroke-linecap=\"round\"/>\n  <circle cx=\"64\" cy=\"76\" r=\"8\" fill=\"#f8fafc\"/>\n  <path d=\"M58 98l6-14 6 14z\" fill=\"#f8fafc\"/>\n</svg>";
const ICO_B64 = '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';
export const FAVICON_ICO = Uint8Array.from(atob(ICO_B64), (ch) => ch.charCodeAt(0));

export const OPENAPI_PATHS = ['/v1/check-agent', '/v1/check-agent/preview'];
const usd = (price) => String(price).replace(/^\$/, '');

/** OpenAPI 3.1 document with live price, origin and x402 terms. */
export function openapiDoc({ origin, price, network, payTo, asset }) {
  const doc = JSON.parse(JSON.stringify(BASE));
  doc.servers = [{ url: origin }];
  doc.info.contact = { name: 'AgentGate', email: 'hello@youraitools.co', url: 'https://youraitools.co/guides/x402-agent-verification' };
  doc.info.license = { name: 'MIT' };
  doc.externalDocs = { description: 'Integration guide', url: 'https://youraitools.co/guides/x402-agent-verification' };
  const op = doc.paths['/v1/check-agent'].get;
  op['x-payment-info'].price.amount = usd(price);
  // Informational: the exact runtime terms (the live 402 challenge is authoritative).
  op['x-x402'] = { scheme: 'exact', network, asset, payTo, amount: String(Math.round(Number(usd(price)) * 1e6)), assetSymbol: 'USDC', x402Versions: [2, 1] };
  doc.info['x-guidance'] = doc.info['x-guidance'].replace(/\$[0-9.]+ USDC/, `$${usd(price)} USDC`);
  // x402scan lists every path in this doc: publish only the paid route and its free preview.
  doc.paths = Object.fromEntries(Object.entries(doc.paths).filter(([p]) => OPENAPI_PATHS.includes(p)));
    doc.info['x-service-name'] = SERVICE_META.serviceName; doc.info['x-category'] = SERVICE_META.category;
  doc.info['x-categories'] = SERVICE_META.categories; doc.info['x-tags'] = SERVICE_META.tags; doc.info['x-logo'] = { url: SERVICE_META.iconUrl };
  return doc;
}

/** /.well-known/x402 manifest (x402scan compatibility format). */
export function wellKnownX402({ origin }) {
  return {
    version: 1,
    name: SERVICE_META.serviceName, category: SERVICE_META.category, categories: SERVICE_META.categories, tags: SERVICE_META.tags, iconUrl: SERVICE_META.iconUrl,
    resources: [`${origin}/v1/check-agent`],
    instructions: "GET /v1/check-agent?id=<badge or Concordium account>&network=mainnet. Price: $0.005 USDC on Base (eip155:8453), paid via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT). Free preview: GET /v1/check-agent/preview?id=. Full docs: /openapi.json",
    openapi: `${origin}/openapi.json`,
  };
}
