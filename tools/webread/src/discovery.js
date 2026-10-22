// Discovery documents served by the Worker: GET /openapi.json (x402scan OpenAPI-first discovery),
// GET /.well-known/x402 (x402scan compatibility manifest), and /favicon.ico + /favicon.svg.
// Generated from the YourAITools draft (crypto/youraitools/guides/openapi/webread.openapi.json); price, server URL and payment
// terms are filled in from the live config so the docs can't drift from the 402 challenge.
import { SERVICE_META } from './service-meta.js';
const BASE = {
 "openapi": "3.1.0",
 "info": {
  "title": "WebRead",
  "version": "0.1.4",
  "description": "Converts a public web page into clean Markdown for LLMs: main content only, absolute links, title/description/lang metadata. Respects robots.txt; only successful reads are charged.",
  "x-guidance": "Usage: GET /v1/read?url=<absolute http(s) URL>&maxChars=<100-200000> returns the page as Markdown. $0.002 USDC on Base via x402, charged only on HTTP 200. Free 2,000-character preview: GET /v1/read/preview?url=.",
  "contact": {
   "email": "hello@youraitools.co"
  }
 },
 "servers": [
  {
   "url": "https://webread.agentgate.workers.dev"
  }
 ],
 "paths": {
  "/v1/read": {
   "get": {
    "operationId": "read_url",
    "summary": "Web page to clean Markdown",
    "tags": [
     "paid"
    ],
    "x-payment-info": {
     "price": {
      "mode": "fixed",
      "currency": "USD",
      "amount": "0.002"
     },
     "protocols": [
      {
       "x402": {}
      }
     ]
    },
    "parameters": [
     {
      "name": "url",
      "in": "query",
      "required": true,
      "schema": {
       "type": "string",
       "format": "uri"
      },
      "description": "Absolute http(s) URL of a public web page (HTML or plain text)",
      "example": "https://example.com/"
     },
     {
      "name": "maxChars",
      "in": "query",
      "required": false,
      "schema": {
       "type": "integer",
       "minimum": 100,
       "maximum": 200000,
       "default": 200000
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
          "url": {
           "type": "string"
          },
          "finalUrl": {
           "type": "string"
          },
          "status": {
           "type": "integer"
          },
          "contentType": {
           "type": "string"
          },
          "title": {
           "type": [
            "string",
            "null"
           ]
          },
          "description": {
           "type": [
            "string",
            "null"
           ]
          },
          "lang": {
           "type": [
            "string",
            "null"
           ]
          },
          "canonical": {
           "type": [
            "string",
            "null"
           ]
          },
          "markdown": {
           "type": "string"
          },
          "chars": {
           "type": "integer"
          },
          "wordCount": {
           "type": "integer"
          },
          "links": {
           "type": "integer"
          },
          "truncated": {
           "type": "boolean"
          },
          "sourceBytes": {
           "type": "integer"
          },
          "redirects": {
           "type": "integer"
          },
          "fetchMs": {
           "type": "integer"
          },
          "robots": {
           "type": "string"
          },
          "fetchedAt": {
           "type": "string"
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
  "/v1/read/preview": {
   "get": {
    "operationId": "read_url_preview",
    "summary": "Free 2,000-character preview (10/min/IP)",
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
      "name": "url",
      "in": "query",
      "required": true,
      "schema": {
       "type": "string",
       "format": "uri"
      },
      "description": "Absolute http(s) URL of a public web page (HTML or plain text)",
      "example": "https://example.com/"
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
  }
 }
};

export const FAVICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" width=\"64\" height=\"64\" role=\"img\" aria-label=\"WebRead\"><rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#0f172a\"/><path d=\"M14 18h36v28H14z\" fill=\"none\" stroke=\"#7c9cff\" stroke-width=\"3\" stroke-linejoin=\"round\"/><path d=\"M14 25h36\" stroke=\"#7c9cff\" stroke-width=\"3\"/><path d=\"M21 34l4 6 4-8 4 8 4-6\" fill=\"none\" stroke=\"#4ade80\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M42 33v8m-3-3l3 3 3-3\" fill=\"none\" stroke=\"#e6e9f0\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>";
const ICO_B64 = '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';
export const FAVICON_ICO = Uint8Array.from(atob(ICO_B64), (ch) => ch.charCodeAt(0));

export const OPENAPI_PATHS = ['/v1/read', '/v1/read/preview'];
const usd = (price) => String(price).replace(/^\$/, '');

/** OpenAPI 3.1 document with live price, origin and x402 terms. */
export function openapiDoc({ origin, price, network, payTo, asset }) {
  const doc = JSON.parse(JSON.stringify(BASE));
  doc.servers = [{ url: origin }];
  doc.info.contact = { name: 'WebRead', email: 'hello@youraitools.co', url: 'https://youraitools.co/guides/pay-per-call-web-scraper-api' };
  doc.info.license = { name: 'MIT' };
  doc.externalDocs = { description: 'Integration guide', url: 'https://youraitools.co/guides/pay-per-call-web-scraper-api' };
  const op = doc.paths['/v1/read'].get;
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
    resources: [`${origin}/v1/read`],
    instructions: "GET /v1/read?url=<absolute http(s) URL>&maxChars=<100-200000>. Price: $0.002 USDC on Base (eip155:8453), paid via x402 v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT); only HTTP 200 reads are settled. Free preview: GET /v1/read/preview?url=. Full docs: /openapi.json",
    openapi: `${origin}/openapi.json`,
  };
}
