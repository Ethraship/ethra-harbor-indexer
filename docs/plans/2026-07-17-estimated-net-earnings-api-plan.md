# Estimated Net Earnings API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable estimated net earnings and freshness metadata to the read-only account API for the single Ethra Harbor Morpho vault.

**Architecture:** Keep indexed ledger state unchanged and derive the new values at read time from existing account metrics, crystallized fee attribution, latest share-price snapshot, the vault cursor, and the latest nonzero performance-fee mint event. Add a small database helper for the last fee-mint block, then extend the account response shape and docs.

**Tech Stack:** Node.js, TypeScript, CommonJS, `better-sqlite3`, `ethers`, `node:test`, SQLite.

## Global Constraints

- Backend-only project: do not add frontend/mobile frameworks or wallet UX.
- Existing `lifetimeEarned.raw` keeps its current mark-to-market meaning.
- Add `grossLifetimeEarned.raw`, `estimatedNetLifetimeEarned.raw`, `estimatedPerformanceFee.raw`, and `blockContext` to `GET /accounts/:address`.
- `grossLifetimeEarned = lifetimeEarned + earnedPerformanceFee.valueRaw`.
- `estimatedNetLifetimeEarned = grossLifetimeEarned * (10000 - performanceFeeRateBps) / 10000`.
- `estimatedPerformanceFee = grossLifetimeEarned - estimatedNetLifetimeEarned`.
- `performanceFeeRateBps` is the string `"5000"` in API output for the current vault.
- If no share-price snapshot exists, valuation-dependent derived raw fields are `null`.
- `blockContext.currentBlock` is the latest share-price snapshot block.
- `blockContext.lastProcessedLogBlock` is the vault crawler cursor block.
- `blockContext.lastPerformanceFeeMintBlock` is the latest indexed `AccrueInterest` event with nonzero `performanceFeeShares`.
- `blockContext.blocksSincePerformanceFeeMint = currentBlock - lastPerformanceFeeMintBlock`, or `null` if either block is unknown.
- Store large integer blockchain values as strings or `bigint`; do not use floating point for token amounts, shares, blocks, or log indexes.
- Use TDD for behavior changes: write a failing focused test, confirm it fails for the expected reason, then implement.
- Update `README.md`, `docs/overview.md`, `docs/architecture.md`, and append `docs/evolution.md` after the behavior/API change.

---

### Task 1: Last Performance-Fee Mint Block Helper

**Files:**
- Modify: `src/db/vault.ts`
- Modify: `src/db/index.ts`
- Test: `test/vaultDb.test.ts`

**Interfaces:**
- Consumes: existing `accrue_interest_events` rows and existing db export barrel.
- Produces: `readLastPerformanceFeeMintBlock(db: Database.Database): number | null`.

- [ ] **Step 1: Write the failing test**

Add this test near the other vault DB read helper tests in `test/vaultDb.test.ts`:

```ts
test("readLastPerformanceFeeMintBlock returns the latest nonzero performance fee accrue block", () => {
  const db = openDatabase(":memory:");

  try {
    runMigrations(db);

    vaultDb.insertAccrueInterestEvent(db, {
      chainId: 8453,
      contractAddress: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      blockNumber: 48700001,
      blockHash: "0xblock-1",
      txHash: "0xtx-1",
      txIndex: 0,
      logIndex: 1,
      previousTotalAssets: "1000000",
      newTotalAssets: "1000001",
      performanceFeeShares: "0",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "0",
      rawLogJson: "{}",
      createdAt: 1712345600,
    });
    vaultDb.insertAccrueInterestEvent(db, {
      chainId: 8453,
      contractAddress: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      blockNumber: 48700003,
      blockHash: "0xblock-3",
      txHash: "0xtx-3",
      txIndex: 0,
      logIndex: 2,
      previousTotalAssets: "1000001",
      newTotalAssets: "1000002",
      performanceFeeShares: "15",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "15",
      rawLogJson: "{}",
      createdAt: 1712345601,
    });
    vaultDb.insertAccrueInterestEvent(db, {
      chainId: 8453,
      contractAddress: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      blockNumber: 48700003,
      blockHash: "0xblock-3",
      txHash: "0xtx-4",
      txIndex: 1,
      logIndex: 3,
      previousTotalAssets: "1000002",
      newTotalAssets: "1000003",
      performanceFeeShares: "25",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "40",
      rawLogJson: "{}",
      createdAt: 1712345602,
    });

    assert.equal(vaultDb.readLastPerformanceFeeMintBlock(db), 48700003);
  } finally {
    closeDatabase(db);
  }
});

test("readLastPerformanceFeeMintBlock returns null when no nonzero performance fee exists", () => {
  const db = openDatabase(":memory:");

  try {
    runMigrations(db);

    vaultDb.insertAccrueInterestEvent(db, {
      chainId: 8453,
      contractAddress: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      blockNumber: 48700001,
      blockHash: "0xblock-1",
      txHash: "0xtx-1",
      txIndex: 0,
      logIndex: 1,
      previousTotalAssets: "1000000",
      newTotalAssets: "1000001",
      performanceFeeShares: "0",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "0",
      rawLogJson: "{}",
      createdAt: 1712345600,
    });

    assert.equal(vaultDb.readLastPerformanceFeeMintBlock(db), null);
  } finally {
    closeDatabase(db);
  }
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --import tsx --test test/vaultDb.test.ts
```

Expected: FAIL because `vaultDb.readLastPerformanceFeeMintBlock` is not defined.

- [ ] **Step 3: Implement the minimal database helper**

In `src/db/vault.ts`, add:

```ts
export function readLastPerformanceFeeMintBlock(db: Database.Database): number | null {
  const row = db.prepare(`
    SELECT block_number
    FROM accrue_interest_events
    WHERE performance_fee_shares != '0'
    ORDER BY block_number DESC, tx_index DESC, log_index DESC
    LIMIT 1
  `).get() as { block_number: number } | undefined;

  return row ? row.block_number : null;
}
```

Ensure `src/db/index.ts` still exports it via the existing vault export pattern.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node --import tsx --test test/vaultDb.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run:

```bash
npm test
```

Expected: PASS. If the sandbox blocks local API server tests with `listen EPERM`, rerun the same command with the allowed localhost escalation.

- [ ] **Step 6: Commit**

```bash
git add src/db/vault.ts src/db/index.ts test/vaultDb.test.ts
git commit -m "feat: expose last performance fee mint block"
```

---

### Task 2: Account API Estimated Net Earnings

**Files:**
- Modify: `src/api/queries.ts`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `readLastPerformanceFeeMintBlock(db)`, `readVaultCursor(db, config)`, existing `readAccountPosition`, `readVaultStateSnapshot`, and `readLatestSnapshot`.
- Produces: extended `AccountMetricsResponse` with `grossLifetimeEarned`, `estimatedNetLifetimeEarned`, `estimatedPerformanceFee`, and `blockContext`.

- [ ] **Step 1: Write the failing account API test for estimated values and block context**

Update the expected `/accounts/:known` body in `test/api.test.ts` test `"api serves account, vault, and health metrics from indexed state"` to include:

```ts
grossLifetimeEarned: {
  raw: "1150000",
},
estimatedNetLifetimeEarned: {
  raw: "575000",
  performanceFeeRateBps: "5000",
},
estimatedPerformanceFee: {
  raw: "575000",
},
blockContext: {
  currentBlock: 48700010,
  lastProcessedLogBlock: 48578254,
  lastPerformanceFeeMintBlock: null,
  blocksSincePerformanceFeeMint: null,
},
```

Add this new focused test to the same file:

```ts
test("api reports last performance fee mint freshness in account block context", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x5555555555555555555555555555555555555555";
  const server = createApiServer({ db, config });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);
  getOrCreateVaultCursor(db, config);
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700008);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "2000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700000,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700000,
    updatedLogIndex: 3,
  });
  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "3000302",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345600,
  });
  insertAccrueInterestEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48700004,
    blockHash: "0xblock-4",
    txHash: "0xtx-4",
    txIndex: 0,
    logIndex: 1,
    previousTotalAssets: "3000000",
    newTotalAssets: "3000001",
    performanceFeeShares: "0",
    managementFeeShares: "0",
    totalSupplyBeforeRaw: "2000000000000000000",
    globalIndexAfterRaw: "0",
    rawLogJson: "{}",
    createdAt: 1712345600,
  });
  insertAccrueInterestEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48700005,
    blockHash: "0xblock-5",
    txHash: "0xtx-5",
    txIndex: 0,
    logIndex: 2,
    previousTotalAssets: "3000001",
    newTotalAssets: "3000002",
    performanceFeeShares: "1",
    managementFeeShares: "0",
    totalSupplyBeforeRaw: "2000000000000000000",
    globalIndexAfterRaw: "1",
    rawLogJson: "{}",
    createdAt: 1712345601,
  });

  const baseUrl = await startServer(server);
  const accountRes = await fetch(`${baseUrl}/accounts/${account}`);

  assert.equal(accountRes.status, 200);
  const body = await accountRes.json();

  assert.deepEqual(body.grossLifetimeEarned, {
    raw: "500151",
  });
  assert.deepEqual(body.estimatedNetLifetimeEarned, {
    raw: "250075",
    performanceFeeRateBps: "5000",
  });
  assert.deepEqual(body.estimatedPerformanceFee, {
    raw: "250076",
  });
  assert.deepEqual(body.blockContext, {
    currentBlock: 48700010,
    lastProcessedLogBlock: 48700008,
    lastPerformanceFeeMintBlock: 48700005,
    blocksSincePerformanceFeeMint: 5,
  });
});
```

Also import `insertAccrueInterestEvent` from `../src/db`.

- [ ] **Step 2: Write the failing no-snapshot expectation**

Update the expected body in `"api returns raw metrics with null valuation fields when no snapshot exists"` to include:

```ts
grossLifetimeEarned: {
  raw: null,
},
estimatedNetLifetimeEarned: {
  raw: null,
  performanceFeeRateBps: "5000",
},
estimatedPerformanceFee: {
  raw: null,
},
blockContext: {
  currentBlock: null,
  lastProcessedLogBlock: 48578254,
  lastPerformanceFeeMintBlock: null,
  blocksSincePerformanceFeeMint: null,
},
```

- [ ] **Step 3: Run the focused test to verify it fails**

Run:

```bash
node --import tsx --test test/api.test.ts
```

Expected: FAIL because the new account response fields are missing.

- [ ] **Step 4: Implement the API response fields**

In `src/api/queries.ts`:

1. Import `readLastPerformanceFeeMintBlock` and `readVaultCursor`.
2. Add a named constant:

```ts
const PERFORMANCE_FEE_RATE_BPS = 5000n;
const BPS_SCALE = 10000n;
```

3. Extend `AccountMetricsResponse`:

```ts
  grossLifetimeEarned: {
    raw: string | null;
  };
  estimatedNetLifetimeEarned: {
    raw: string | null;
    performanceFeeRateBps: string;
  };
  estimatedPerformanceFee: {
    raw: string | null;
  };
  blockContext: {
    currentBlock: number | null;
    lastProcessedLogBlock: number | null;
    lastPerformanceFeeMintBlock: number | null;
    blocksSincePerformanceFeeMint: number | null;
  };
```

4. Add a helper:

```ts
function blockContext(
  currentBlock: number | null,
  lastProcessedLogBlock: number | null,
  lastPerformanceFeeMintBlock: number | null,
): AccountMetricsResponse["blockContext"] {
  return {
    currentBlock,
    lastProcessedLogBlock,
    lastPerformanceFeeMintBlock,
    blocksSincePerformanceFeeMint:
      currentBlock !== null && lastPerformanceFeeMintBlock !== null
        ? currentBlock - lastPerformanceFeeMintBlock
        : null,
  };
}
```

5. In `getAccountMetrics`, read:

```ts
const lastProcessedLogBlock = readVaultCursor(db, config);
const lastPerformanceFeeMintBlock = readLastPerformanceFeeMintBlock(db);
```

6. In the no-snapshot return, include null derived raw fields and `blockContext(null, lastProcessedLogBlock, lastPerformanceFeeMintBlock)`.

7. In the snapshot return, use:

```ts
const netLifetimeEarned = lifetimeEarned > 0n ? lifetimeEarned : 0n;
const performanceFeeValue = valueOfShares(account.earnedPerfFeeSharesRaw, snapshot);
const grossLifetimeEarned = netLifetimeEarned + performanceFeeValue;
const estimatedNetLifetimeEarned =
  (grossLifetimeEarned * (BPS_SCALE - PERFORMANCE_FEE_RATE_BPS)) / BPS_SCALE;
const estimatedPerformanceFee = grossLifetimeEarned - estimatedNetLifetimeEarned;
```

Return those values as strings.

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```bash
node --import tsx --test test/api.test.ts
```

Expected: PASS. If the sandbox blocks local API server tests with `listen EPERM`, rerun the same command with the allowed localhost escalation.

- [ ] **Step 6: Run the full suite**

Run:

```bash
npm test
```

Expected: PASS. If the sandbox blocks local API server tests with `listen EPERM`, rerun the same command with the allowed localhost escalation.

- [ ] **Step 7: Commit**

```bash
git add src/api/queries.ts test/api.test.ts
git commit -m "feat: add estimated net account earnings"
```

---

### Task 3: Documentation For Estimated Earnings Semantics

**Files:**
- Modify: `README.md`
- Modify: `docs/overview.md`
- Modify: `docs/architecture.md`
- Modify: `docs/evolution.md`
- Modify: `docs/plans/2026-07-17-estimated-net-earnings-api-plan.md`

**Interfaces:**
- Consumes: API response fields from Task 2.
- Produces: updated user and architecture docs, plus this saved complete plan marked as executed.

- [ ] **Step 1: Update README API semantics**

In `README.md`, revise the per-address metrics section so it distinguishes:

- Mark-to-market lifetime earned: existing `lifetimeEarned`.
- Crystallized earned performance fee: existing `earnedPerformanceFee`.
- Gross generated yield: `grossLifetimeEarned`.
- Estimated user-kept net earned: `estimatedNetLifetimeEarned`.
- Estimated total performance fee: `estimatedPerformanceFee`.
- Freshness metadata: `blockContext`.

State that the estimate assumes the current single-vault performance fee rate of `5000` bps.

- [ ] **Step 2: Update product overview**

In `docs/overview.md`, update the "For each wallet address" bullets to include estimated net earnings and freshness metadata. Keep the backend-only scope unchanged.

- [ ] **Step 3: Update architecture docs**

In `docs/architecture.md`, update the API and valuation sections to say account reads derive estimated net earnings at read time from local SQLite state and the latest snapshot. Document that the API does not hit the chain during account reads.

- [ ] **Step 4: Append evolution entry**

Append this entry to `docs/evolution.md` with date `2026-07-17`:

```md
## 2026-07-17

- Area: account earnings API semantics
- Changed: added gross lifetime earned, estimated net lifetime earned, estimated performance fee, and block freshness metadata to account metrics while preserving the existing mark-to-market `lifetimeEarned` field.
- Why: Morpho performance-fee shares mint lazily on vault interaction, so snapshot-only mark-to-market earned can temporarily overstate user-kept earnings until the next fee mint crystallizes the split.
```

- [x] **Step 5: Saved plan execution record**

This plan was saved at `docs/plans/2026-07-17-estimated-net-earnings-api-plan.md` before implementation and updated during the docs task after implementation.

- [ ] **Step 6: Run documentation-safe verification**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/overview.md docs/architecture.md docs/evolution.md docs/plans/2026-07-17-estimated-net-earnings-api-plan.md
git commit -m "docs: explain estimated net earnings"
```
