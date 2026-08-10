import assert from "node:assert/strict";
import test from "node:test";
import { calculateVShipRaw } from "../src/rewards/vshipMath";

test("1 USDC fee at 4x and $0.05 yields 80 vSHIP raw units", () => {
  // 1_000_000 raw USDC * 4 / 0.05 = 80 tokens at 6 decimals = 80_000_000
  assert.equal(
    calculateVShipRaw(1_000_000n, 40_000n, 50_000n, 6, 6),
    80_000_000n,
  );
});

test("additive 14x boost scales linearly", () => {
  assert.equal(
    calculateVShipRaw(1_000_000n, 140_000n, 50_000n, 6, 6),
    280_000_000n,
  );
});

test("non-positive fee returns 0", () => {
  assert.equal(calculateVShipRaw(0n, 40_000n, 50_000n, 6, 6), 0n);
});
