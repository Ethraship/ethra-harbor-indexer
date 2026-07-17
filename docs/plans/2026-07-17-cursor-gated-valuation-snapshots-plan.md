# Cursor-Gated Valuation Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent account and vault valuations from using a share-price snapshot whose block has not yet been processed by the vault log crawler.

**Architecture:** Keep capturing head snapshots on the independent snapshot timer, but separate the newest observed snapshot from the newest eligible valuation snapshot. Repository code selects the newest snapshot at or below the persisted crawler cursor; both API endpoints use that snapshot for valuation while reporting the newest observed snapshot block as freshness metadata.

**Tech Stack:** Node.js, TypeScript, CommonJS, `better-sqlite3`, built-in `node:http`, static JavaScript, `node:test`, SQLite.

## Global Constraints

- Implement the approved design in `docs/superpowers/specs/2026-07-17-cursor-gated-valuation-snapshots-design.md`.
- Apply the same invariant to `GET /accounts/:address` and `GET /vault`: `valuationSnapshot.blockNumber <= lastProcessedLogBlock`.
- Continue storing all snapshots; do not add a promotion worker, promoted flag, scheduler coupling, heuristic threshold, or schema migration.
- `blockContext.currentBlock` means the newest observed snapshot block, while `valuationBlock` means the eligible snapshot actually used for valuation.
- Keep API reads SQLite-only, synchronous, read-only, and free of RPC calls.
- Preserve exact integer math with strings and `bigint`; do not introduce floating-point token, share, or block calculations.
- Preserve current indexed-state semantics: indexed share totals and cumulative fee-share totals continue to come from crawler state.
- If snapshots exist but none is at or below the cursor, valuation-dependent fields are `null` while observed and cursor block metadata remain available.
- Work with the existing uncommitted dashboard, API-test, dashboard-test, and evolution-document changes; do not revert or overwrite them.
- Use TDD for every behavior change: write the focused failing test, observe the expected failure, implement minimally, then rerun the test.
- No database reset is required.

---

### Task 1: Cursor-Bounded Snapshot Repository Query

**Files:**
- Modify: `src/db/vault.ts:637`
- Modify: `test/vaultDb.test.ts:42`
- Test: `test/vaultDb.test.ts:422`

**Interfaces:**
- Consumes: `share_price_snapshots` and an inclusive `maxBlockNumber: number`.
- Produces: `readLatestSnapshotAtOrBefore(db: Database.Database, maxBlockNumber: number): Snapshot | null` through the existing `src/db/index.ts` wildcard export.

- [x] **Step 1: Extend the test-only DB interface and write the failing repository test**

Add this member to `VaultDbApi` in `test/vaultDb.test.ts`:

```ts
readLatestSnapshotAtOrBefore(
  db: Parameters<typeof dbApi.closeDatabase>[0],
  maxBlockNumber: number,
): Snapshot | null;
```

Add this test after the existing `readLatestSnapshot` test:

```ts
test("readLatestSnapshotAtOrBefore returns the newest deterministic eligible snapshot", () => {
  const db = dbApi.openDatabase(":memory:");
  const vaultDb = dbApi as VaultDbApi;

  try {
    dbApi.runMigrations(db);

    assert.equal(typeof vaultDb.readLatestSnapshotAtOrBefore, "function");
    assert.equal(vaultDb.readLatestSnapshotAtOrBefore(db, 99), null);

    vaultDb.insertSnapshot(db, {
      blockNumber: 100,
      totalAssetsRaw: "1000",
      totalSupplyRaw: "500",
      capturedAt: 1000,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 110,
      totalAssetsRaw: "1100",
      totalSupplyRaw: "550",
      capturedAt: 1100,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 110,
      totalAssetsRaw: "1150",
      totalSupplyRaw: "575",
      capturedAt: 1200,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 110,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1200,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 120,
      totalAssetsRaw: "1300",
      totalSupplyRaw: "650",
      capturedAt: 1300,
    });

    assert.deepEqual(vaultDb.readLatestSnapshotAtOrBefore(db, 109), {
      blockNumber: 100,
      totalAssetsRaw: "1000",
      totalSupplyRaw: "500",
      capturedAt: 1000,
    });
    assert.deepEqual(vaultDb.readLatestSnapshotAtOrBefore(db, 110), {
      blockNumber: 110,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1200,
    });
    assert.deepEqual(vaultDb.readLatestSnapshotAtOrBefore(db, 119), {
      blockNumber: 110,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1200,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});
```

- [x] **Step 2: Run the focused repository test and confirm the intended failure**

Run:

```bash
node --import tsx --test test/vaultDb.test.ts
```

Expected: FAIL because `readLatestSnapshotAtOrBefore` is not exported.

- [x] **Step 3: Implement the inclusive snapshot query**

Add this helper beside `readLatestSnapshot` in `src/db/vault.ts`:

```ts
export function readLatestSnapshotAtOrBefore(
  db: Database.Database,
  maxBlockNumber: number,
): Snapshot | null {
  const row = db.prepare(`
    SELECT
      id,
      block_number,
      total_assets_raw,
      total_supply_raw,
      captured_at
    FROM share_price_snapshots
    WHERE block_number <= ?
    ORDER BY block_number DESC, captured_at DESC, id DESC
    LIMIT 1
  `).get(maxBlockNumber) as {
    id: number;
    block_number: number;
    total_assets_raw: string;
    total_supply_raw: string;
    captured_at: number;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    blockNumber: row.block_number,
    totalAssetsRaw: row.total_assets_raw,
    totalSupplyRaw: row.total_supply_raw,
    capturedAt: row.captured_at,
  };
}
```

Do not change the schema or `src/db/index.ts`; the existing `export * from "./vault"` exposes the helper.

- [x] **Step 4: Run the focused test and build**

Run:

```bash
node --import tsx --test test/vaultDb.test.ts
npm run build
```

Expected: both commands PASS.

- [x] **Step 5: Commit the repository unit**

```bash
git add src/db/vault.ts test/vaultDb.test.ts
git commit -m "feat: select snapshots through crawler cursor"
```

---

### Task 2: Gate Account and Vault API Valuation

**Files:**
- Modify: `src/api/queries.ts:5`
- Modify: `src/api/queries.ts:27`
- Modify: `src/api/queries.ts:96`
- Modify: `src/api/queries.ts:195`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `readLatestSnapshot(db)`, `readLatestSnapshotAtOrBefore(db, maxBlockNumber)`, and `readVaultCursor(db, config)`.
- Produces: account valuation based on the eligible snapshot and `VaultMetricsResponse.blockContext: { currentBlock: number | null; lastProcessedLogBlock: number | null }`.

- [x] **Step 1: Write the failing account-and-vault promotion test**

Add this integration test to `test/api.test.ts`:

```ts
test("api promotes one cursor-eligible snapshot for account and vault valuation", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x6666666666666666666666666666666666666666";
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
  `).run(48700110);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700110,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "0",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700110,
    updatedLogIndex: 0,
  });
  insertSnapshot(db, {
    blockNumber: 48700100,
    totalAssetsRaw: "1000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1712345600,
  });
  insertSnapshot(db, {
    blockNumber: 48700120,
    totalAssetsRaw: "2000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1712345660,
  });

  const baseUrl = await startServer(server);
  const firstAccount = await (await fetch(`${baseUrl}/accounts/${account}`)).json();
  const firstVault = await (await fetch(`${baseUrl}/vault`)).json();

  assert.deepEqual(firstAccount.activeDeposit, {
    shares: "1000000000000000000",
    valueRaw: "1000000",
  });
  assert.deepEqual(firstAccount.blockContext, {
    currentBlock: 48700120,
    lastProcessedLogBlock: 48700110,
    lastPerformanceFeeMintBlock: null,
    blocksSincePerformanceFeeMint: null,
  });
  assert.equal(firstAccount.valuationBlock, 48700100);
  assert.equal(firstVault.totalAssetsRaw, "1000000");
  assert.equal(firstVault.valuationBlock, 48700100);
  assert.deepEqual(firstVault.blockContext, {
    currentBlock: 48700120,
    lastProcessedLogBlock: 48700110,
  });

  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700120);

  const promotedAccount = await (await fetch(`${baseUrl}/accounts/${account}`)).json();
  const promotedVault = await (await fetch(`${baseUrl}/vault`)).json();

  assert.equal(promotedAccount.activeDeposit.valueRaw, "2000000");
  assert.equal(promotedAccount.valuationBlock, 48700120);
  assert.equal(promotedVault.totalAssetsRaw, "2000000");
  assert.equal(promotedVault.valuationBlock, 48700120);
});
```

- [x] **Step 2: Update existing API fixtures to state their cursor/snapshot relationship**

For tests that expect a non-null valuation, advance the cursor to the expected
snapshot block before making requests:

```ts
db.prepare(`
  UPDATE indexer_state
  SET last_scanned_block = ?
`).run(48700010);
```

Apply that fixture update to:

- `"api serves account, vault, and health metrics from indexed state"`
- `"api returns zeros for unknown accounts and 400 for invalid addresses"`

In the first test, update expected health/account cursor fields from `48578254`
to `48700010` and add this exact vault field:

```ts
blockContext: {
  currentBlock: 48700010,
  lastProcessedLogBlock: 48700010,
},
```

In `"api reports last performance fee mint freshness in account block context"`,
keep the cursor at `48700008`, retain the observed snapshot at `48700010`, and
insert this eligible snapshot before it:

```ts
insertSnapshot(db, {
  blockNumber: 48700006,
  totalAssetsRaw: "3000302",
  totalSupplyRaw: "2000000000000000000",
  capturedAt: 1712345540,
});
```

Assert that the existing earnings values remain unchanged, `currentBlock`
remains `48700010`, and:

```ts
assert.equal(body.valuationBlock, 48700006);
assert.equal(body.valuationTime, 1712345540);
```

Add vault block context to the null-snapshot expectations:

```ts
// Fresh DB, no cursor and no snapshots
blockContext: {
  currentBlock: null,
  lastProcessedLogBlock: null,
},

// Seeded cursor, no snapshots
blockContext: {
  currentBlock: null,
  lastProcessedLogBlock: 48578254,
},
```

- [x] **Step 3: Run the API test and confirm the expected failure**

Run:

```bash
node --import tsx --test test/api.test.ts
```

Expected: FAIL because the pending block `48700120` is selected immediately and
the vault response does not yet contain `blockContext`.

- [x] **Step 4: Add shared snapshot selection to the API query layer**

Add `readLatestSnapshotAtOrBefore` to the DB imports in `src/api/queries.ts` and
introduce these types/helpers:

```ts
interface ValuationSnapshotContext {
  currentBlock: number | null;
  lastProcessedLogBlock: number | null;
  valuationSnapshot: ReturnType<typeof readLatestSnapshot>;
}

function readValuationSnapshotContext(
  db: Database.Database,
  config: AppConfig,
): ValuationSnapshotContext {
  const latestObservedSnapshot = readLatestSnapshot(db);
  const lastProcessedLogBlock = readVaultCursor(db, config);
  const valuationSnapshot =
    lastProcessedLogBlock === null
      ? null
      : readLatestSnapshotAtOrBefore(db, lastProcessedLogBlock);

  return {
    currentBlock: latestObservedSnapshot?.blockNumber ?? null,
    lastProcessedLogBlock,
    valuationSnapshot,
  };
}
```

Extend `VaultMetricsResponse`:

```ts
blockContext: {
  currentBlock: number | null;
  lastProcessedLogBlock: number | null;
};
```

In `getAccountMetrics`, replace the independent cursor/latest-snapshot reads
with:

```ts
const snapshotContext = readValuationSnapshotContext(db, config);
const snapshot = snapshotContext.valuationSnapshot;
const { currentBlock, lastProcessedLogBlock } = snapshotContext;
```

Use `currentBlock`, not `snapshot?.blockNumber`, in both account
`blockContext(...)` calls. Continue using `snapshot` for every valuation and for
`valuationBlock`/`valuationTime`.

In `getVaultMetrics`, use the same helper and return this field in both the null
and valued branches:

```ts
blockContext: {
  currentBlock: snapshotContext.currentBlock,
  lastProcessedLogBlock: snapshotContext.lastProcessedLogBlock,
},
```

Do not mutate or delete pending snapshot rows.

- [x] **Step 5: Run focused API tests and the TypeScript build**

Run:

```bash
node --import tsx --test test/api.test.ts
npm run build
```

Expected: both commands PASS. If local server binding returns `listen EPERM` in
the sandbox, rerun the API test with the approved localhost escalation.

- [x] **Step 6: Commit the API unit**

```bash
git add src/api/queries.ts test/api.test.ts
git commit -m "fix: gate API valuation snapshots by crawler cursor"
```

---

### Task 3: Show Vault Snapshot Freshness in the Dashboard

**Files:**
- Modify: `public/dashboard.js:165`
- Modify: `test/dashboard.test.ts:70`

**Interfaces:**
- Consumes: `GET /vault` response field `blockContext.currentBlock` and `blockContext.lastProcessedLogBlock`.
- Produces: visible `Current block`, `Last processed log`, and existing `Valuation block` vault metrics.

- [x] **Step 1: Extend the dashboard render test with a failing vault assertion**

Expose `renderVault` in the VM test hook:

```ts
vm.runInContext(
  `${script}\nglobalThis.__dashboardTest = { renderAccount, renderVault };`,
  context,
);

const dashboard = (
  context as typeof context & {
    __dashboardTest: {
      renderAccount: (data: unknown) => void;
      renderVault: (data: unknown) => void;
    };
  }
).__dashboardTest;
```

After the account assertions, render a pending vault snapshot state:

```ts
dashboard.renderVault({
  blockContext: {
    currentBlock: 48700120,
    lastProcessedLogBlock: 48700110,
  },
  cumulativePerformanceFeeSharesRaw: "0",
  cumulativePerformanceFeeValueRaw: "0",
  sharePriceScaledRaw: "1000000",
  totalAssetsRaw: "1000000",
  totalSupplyRaw: "1000000000000000000",
  valuationBlock: 48700100,
  valuationTime: 1712345600,
});

const vaultMetrics = document.getElementById("vault-metrics");
assert.equal(metricValue(vaultMetrics, "Current block"), "48,700,120");
assert.equal(metricValue(vaultMetrics, "Last processed log"), "48,700,110");
assert.equal(metricValue(vaultMetrics, "Valuation block"), "48,700,100");
```

- [x] **Step 2: Run the dashboard test and confirm the intended failure**

Run:

```bash
node --import tsx --test test/dashboard.test.ts
```

Expected: FAIL with `missing metric: Current block` under the vault metrics
container.

- [x] **Step 3: Render vault freshness from the API response**

At the start of `renderVault(data)` in `public/dashboard.js`, add:

```js
const blockContext = data.blockContext ?? {};
```

Add these metrics immediately before the existing valuation block metric:

```js
{
  label: "Current block",
  value: formatInteger(blockContext.currentBlock),
  raw: blockContext.currentBlock,
},
{
  label: "Last processed log",
  value: formatInteger(blockContext.lastProcessedLogBlock),
  raw: blockContext.lastProcessedLogBlock,
},
```

Keep the existing valuation block and valuation time fields. Do not add
client-side promotion logic or recompute earnings in the browser.

- [x] **Step 4: Run dashboard verification**

Run:

```bash
node --check public/dashboard.js
node --import tsx --test test/dashboard.test.ts
```

Expected: both commands PASS.

- [x] **Step 5: Commit the dashboard unit**

```bash
git add public/dashboard.js test/dashboard.test.ts
git commit -m "feat: show cursor-gated vault freshness"
```

---

### Task 4: Document, Verify, and Record the Completed Change

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/evolution.md`
- Update checkboxes: `docs/plans/2026-07-17-cursor-gated-valuation-snapshots-plan.md`

**Interfaces:**
- Consumes: completed repository, API, and dashboard behavior from Tasks 1-3.
- Produces: architecture and evolution documentation matching the running backend, plus recorded plan completion.

- [x] **Step 1: Update snapshot architecture semantics**

Replace the statement `Valuation uses the latest stored snapshot only` in
`docs/architecture.md` with this behavior:

```markdown
The latest stored snapshot is the newest observed head snapshot. API valuation
uses the newest snapshot whose `block_number` is less than or equal to the
persisted vault crawler cursor. Snapshots above the cursor remain stored but
pending until the crawler atomically processes their blocks and advances the
cursor.

This cursor gate applies to both account and vault valuation. It guarantees that
a valuation snapshot never runs ahead of indexed logs without coupling the
snapshot and crawler timers. `currentBlock` reports the newest observed snapshot
block, while `valuationBlock` reports the eligible snapshot used for financial
values.
```

Update the API section so `/vault` explicitly includes observed block, processed
cursor, and valuation block freshness metadata.

- [x] **Step 2: Append the required evolution entry**

Append under `## 2026-07-17` in `docs/evolution.md`:

```markdown
- Area: cursor-gated account and vault valuation
- Changed: account and vault API reads now value shares with the newest snapshot at or below the persisted vault crawler cursor, retain newer head snapshots as pending, and expose observed, processed, and valuation block freshness in the vault API and dashboard.
- Why: a head snapshot could previously observe post-fee-mint vault totals before the crawler processed the matching logs, causing a temporary estimated-net-earnings drop until the next crawl.
```

- [x] **Step 3: Run focused and full verification**

Run:

```bash
node --check public/dashboard.js
node --import tsx --test test/vaultDb.test.ts
node --import tsx --test test/api.test.ts
node --import tsx --test test/dashboard.test.ts
npm test
npm run build
git diff --check
```

Expected: every command PASS with zero test failures and no whitespace errors.
If sandbox restrictions block localhost API test listeners, rerun the affected
test command and `npm test` with the approved localhost escalation.

- [x] **Step 4: Review the final diff against the approved invariant**

Run:

```bash
git diff -- src/db/vault.ts src/api/queries.ts public/dashboard.js test/vaultDb.test.ts test/api.test.ts test/dashboard.test.ts docs/architecture.md docs/evolution.md
git status --short
```

Confirm all of the following before completion:

```text
Every valuation snapshot block is <= lastProcessedLogBlock.
Account and vault reads select the same eligible snapshot.
currentBlock still reports the newest observed snapshot.
Pending snapshots remain stored and require no mutation.
No API request performs an RPC call or database write.
No schema or dependency changed.
Unrelated worktree files remain untouched.
```

- [x] **Step 5: Mark this saved plan complete and commit documentation**

Change completed task checkboxes in this file from `[ ]` to `[x]`, then run:

```bash
git add docs/architecture.md docs/evolution.md docs/plans/2026-07-17-cursor-gated-valuation-snapshots-plan.md
git commit -m "docs: explain cursor-gated valuations"
```
