import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
const port = Number(process.env.PORT || 8788);
serve({ fetch: createApp(configFromEnv(process.env)).fetch, port });
console.log(`InjectScan on http://localhost:${port}`);
