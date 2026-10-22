import test from 'node:test';
import assert from 'node:assert/strict';
import { creationBlock } from '../src/discover.js';

test('creationBlock: k-ary search over historical eth_getCode finds the exact first block in a few batches', async () => {
  for (const created of [1, 2797221, 10983962, 52940552]) {
    let batches = 0;
    const rpc = { batch: async (calls) => { batches++; return calls.map((c) => ({ result: Number(BigInt(c.params[1])) >= created ? '0x6080' : '0x' })); } };
    assert.equal(await creationBlock(rpc, '0x' + '1'.repeat(40), 52950000), created);
    assert.ok(batches <= 8, `batches ${batches}`);
  }
  const broken = { batch: async (calls) => calls.map(() => ({ error: { message: 'missing trie node' } })) };
  assert.equal(await creationBlock(broken, '0x' + '1'.repeat(40), 1000000), null);
});
