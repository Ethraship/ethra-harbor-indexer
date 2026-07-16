import assert from "node:assert/strict";
import test from "node:test";

import { calculateRange } from "../src/indexer/blockRange";

test("calculateRange returns null when confirmations leave no safe work", () => {
  assert.equal(calculateRange(100, 102, 2, 500), null);
});

test("calculateRange returns a single safe block when only one block is available", () => {
  assert.deepEqual(calculateRange(100, 103, 2, 500), {
    fromBlock: 101,
    toBlock: 101,
    safeHead: 101,
    hasMore: false,
  });
});

test("calculateRange caps the range at the requested chunk size", () => {
  assert.deepEqual(calculateRange(100, 150, 2, 10), {
    fromBlock: 101,
    toBlock: 110,
    safeHead: 148,
    hasMore: true,
  });
});

test("calculateRange respects confirmation delay when safe head is inside the chunk", () => {
  assert.deepEqual(calculateRange(100, 108, 3, 10), {
    fromBlock: 101,
    toBlock: 105,
    safeHead: 105,
    hasMore: false,
  });
});
