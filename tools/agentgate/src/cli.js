#!/usr/bin/env node
// Usage: agentgate-check <badge|account> [--network mainnet|testnet|devnet]
import { checkAgent } from './registry.js';
const args = process.argv.slice(2);
const ni = args.indexOf('--network');
const network = ni >= 0 ? args[ni + 1] : 'mainnet';
const id = args.find((a, i) => !a.startsWith('--') && i !== ni + 1);
if (!id) { console.error('usage: agentgate-check <badge|account> [--network mainnet|testnet|devnet]'); process.exit(2); }
const r = await checkAgent(id, { network });
console.log(JSON.stringify(r, null, 2));
process.exit(r.verified ? 0 : 1);
