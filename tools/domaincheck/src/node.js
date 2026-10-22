import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
const port = Number(process.env.PORT || 8789);
serve({ fetch: createApp(configFromEnv(process.env)).fetch, port });
console.log(`DomainCheck on http://localhost:${port}`);
