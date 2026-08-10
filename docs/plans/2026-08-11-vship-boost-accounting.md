# vSHIP Boost Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add indexer-owned additive boost accounting with fee-watermark soft crystallization so base and per-wallet boost changes never rewrite past vSHIP, plus gated admin APIs and account read fields.

**Architecture:** Keep existing USDC fee tables/math untouched. Add reward tables and a settle service that locks `estimatedPerformanceFee` deltas into crystallized vSHIP at the boost active for that segment. Admin routes register only when `ADMIN_API_TOKEN` is set; mutations require indexer sync + valuation readiness and a stale fee-mint ceiling.

**Tech Stack:** Node.js, TypeScript, CommonJS, `better-sqlite3`, `ethers`, `node:http`, `node:test`, SQLite.

## Global Constraints

- Indexer-only: do not modify `privy-earn-dashboard`.
- Do not alter existing deposit/withdraw/transfer/accrue/position/snapshot/vault reward table schemas.
- Boost is additive: `totalBoostBps = baseBoostBps + additionalBoostBps`.
- vSHIP price defaults to `$0.05` (`50000` raw, 6 decimals); no admin price API.
- Default base boost `40000` (4x); missing `wallet_boost` row ⇒ additional `0`.
- Soft crystallize on boost change using fee watermark; sticky watermark on fee dips (no negative mint).
- Identical boost PUT ⇒ no settle, no event.
- Eager settle: all eligible wallets on base change; one wallet on wallet change; one SQLite transaction.
- Admin routes exist only when `ADMIN_API_TOKEN` is present and non-empty; otherwise `/admin/*` ⇒ `404`.
- Enabled admin routes require `Authorization: Bearer <token>`; bad/missing ⇒ `401`.
- Mutation-readiness gate: safe head known, cursor synced to safe head, valuation snapshot usable; else `409`.
- Stale fee-mint gate: `blocksSincePerformanceFeeMint >= fee_mint_stale_blocks` (default `20000`) ⇒ `409`.
- Cutover assumes nuke + reindex; no genesis backfill code.
- Store chain/USDC/vSHIP integers as strings at DB boundary and `bigint` in memory.
- TDD: failing test → implement → pass → commit per task.
- Update indexer docs (`architecture`, `api-integration-guide`, `overview`, `evolution`, `README` as needed).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Parse optional `ADMIN_API_TOKEN` → `adminApiToken: string \| null` |
| `src/db/index.ts` | Migration `004_vship_boost_accounting` + seed `reward_config` + export rewards module |
| `src/db/rewards.ts` | CRUD for reward_config, wallet_boost, wallet_vship_state, audit tables |
| `src/rewards/vshipMath.ts` | Integer vSHIP conversion (dashboard-compatible) |
| `src/rewards/settle.ts` | Readiness/stale gates, settle one/all, apply boost mutations |
| `src/api/queries.ts` | Export fee helper; extend account response with `boost` + `vship` |
| `src/api/admin.ts` | Admin auth helper, boost/history handlers, history JSON serialization, and admin error mapping |
| `src/api/server.ts` | Allow PUT on admin paths when enabled; wire admin + keep public GET |
| `test/config.test.ts` | Token parsing |
| `test/rewardsDb.test.ts` | Migration seed + reward DB helpers |
| `test/vshipMath.test.ts` | Conversion math |
| `test/settle.test.ts` | Settlement + gates (no HTTP) |
| `test/api.test.ts` | Account fields + admin HTTP behavior |
| Docs under `docs/` + `README.md` | Contract updates |

---

### Task 1: Optional `ADMIN_API_TOKEN` Config

**Suggested execution agent:** `implementer_simple` — small, isolated config parsing with focused tests.

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig(env)`
- Produces: `AppConfig.adminApiToken: string | null` — `null` when env key absent, empty, or whitespace-only; otherwise trimmed token string.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.ts`:

```ts
test("loadConfig defaults adminApiToken to null", () => {
  const config = loadConfig({});
  assert.equal(config.adminApiToken, null);
});

test("loadConfig treats empty or whitespace ADMIN_API_TOKEN as null", () => {
  assert.equal(loadConfig({ ADMIN_API_TOKEN: "" }).adminApiToken, null);
  assert.equal(loadConfig({ ADMIN_API_TOKEN: "   " }).adminApiToken, null);
});

test("loadConfig trims a configured ADMIN_API_TOKEN", () => {
  assert.equal(
    loadConfig({ ADMIN_API_TOKEN: "  secret-token  " }).adminApiToken,
    "secret-token",
  );
});
```

Update the existing defaults deep-equal test to include `adminApiToken: null`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/config.test.ts`

Expected: FAIL because `adminApiToken` is undefined / not on `AppConfig`.

- [ ] **Step 3: Implement config field**

In `src/config.ts`:

```ts
export interface AppConfig {
  // ...existing fields...
  adminApiToken: string | null;
}

function readOptionalSecret(env: NodeJS.ProcessEnv, key: "ADMIN_API_TOKEN"): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// in loadConfig return:
adminApiToken: readOptionalSecret(env, "ADMIN_API_TOKEN"),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "$(cat <<'EOF'
feat: add optional ADMIN_API_TOKEN to indexer config

EOF
)"
```

---

### Task 2: Reward Tables Migration and DB Helpers

**Suggested execution agent:** `implementer_complex` — schema, bigint persistence, and audit ordering must stay consistent across several helpers.

**Files:**
- Modify: `src/db/index.ts`
- Create: `src/db/rewards.ts`
- Create: `test/rewardsDb.test.ts`
- Modify: `test/db.test.ts` (if it asserts migration count/names)

**Interfaces:**
- Consumes: `openDatabase`, `runMigrations`
- Produces:
  - `readRewardConfig(db): RewardConfigRow`
  - `updateBaseBoostBps(db, baseBoostBps: bigint, updatedAt: number): void`
  - `readWalletAdditionalBoostBps(db, address: string): bigint` // `0n` if missing
  - `upsertWalletAdditionalBoostBps(db, address: string, additionalBoostBps: bigint, updatedAt: number): void`
  - `readWalletVshipState(db, address: string): { feeWatermarkRaw: bigint; crystallizedVshipRaw: bigint } | null`
  - `upsertWalletVshipState(db, address: string, feeWatermarkRaw: bigint, crystallizedVshipRaw: bigint, updatedAt: number): void`
  - `insertBoostChangeEvent(...)` / `listBoostChangeEvents(db, limit?: number)`
  - `insertVshipSettlementEvent(...)` / `listVshipSettlementEvents(db, address: string, limit?: number)`
  - `BoostChangeEventRow` with `oldBps` / `newBps` as bigint
  - `VshipSettlementEventRow` with fee, boost, and vSHIP raw values as bigint
  - `listWalletBoostAddresses(db): string[]`
  - `listWalletVshipAddresses(db): string[]`

- [ ] **Step 1: Write the failing tests**

Create `test/rewardsDb.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { closeDatabase, openDatabase, runMigrations } from "../src/db";
import {
  readRewardConfig,
  readWalletAdditionalBoostBps,
  upsertWalletAdditionalBoostBps,
  upsertWalletVshipState,
  readWalletVshipState,
  insertBoostChangeEvent,
  listBoostChangeEvents,
  insertVshipSettlementEvent,
  listVshipSettlementEvents,
} from "../src/db/rewards";

test("migration seeds reward_config at 4x and $0.05", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const config = readRewardConfig(db);
    assert.equal(config.baseBoostBps, 40000n);
    assert.equal(config.vshipPriceUsdRaw, 50000n);
    assert.equal(config.vshipPriceUsdDecimals, 6);
    assert.equal(config.vshipTokenDecimals, 6);
    assert.equal(config.feeMintStaleBlocks, 20000);
  } finally {
    closeDatabase(db);
  }
});

test("wallet boost and vship state round-trip", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const address = "0x1111111111111111111111111111111111111111";
    assert.equal(readWalletAdditionalBoostBps(db, address), 0n);
    upsertWalletAdditionalBoostBps(db, address, 100000n, 1);
    assert.equal(readWalletAdditionalBoostBps(db, address), 100000n);
    upsertWalletVshipState(db, address, 75n, 6000n, 2);
    assert.deepEqual(readWalletVshipState(db, address), {
      feeWatermarkRaw: 75n,
      crystallizedVshipRaw: 6000n,
    });
  } finally {
    closeDatabase(db);
  }
});

test("boost change and settlement events list newest first", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    insertBoostChangeEvent(db, {
      changedAt: 1,
      changeType: "base",
      address: null,
      oldBps: 40000n,
      newBps: 50000n,
      actor: "admin",
      settledWalletCount: 0,
    });
    insertBoostChangeEvent(db, {
      changedAt: 2,
      changeType: "wallet_additional",
      address: "0x1111111111111111111111111111111111111111",
      oldBps: 0n,
      newBps: 100000n,
      actor: "admin",
      settledWalletCount: 1,
    });
    const changes = listBoostChangeEvents(db);
    assert.equal(changes[0]!.changedAt, 2);
    insertVshipSettlementEvent(db, {
      settledAt: 10,
      address: "0x1111111111111111111111111111111111111111",
      feeBeforeRaw: 0n,
      feeAfterRaw: 100n,
      feeDeltaRaw: 100n,
      boostBpsApplied: 40000n,
      vshipMintedRaw: 8000n,
      crystallizedVshipAfterRaw: 8000n,
      reason: "wallet_boost_change",
    });
    const settlements = listVshipSettlementEvents(
      db,
      "0x1111111111111111111111111111111111111111",
    );
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.vshipMintedRaw, 8000n);
  } finally {
    closeDatabase(db);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/rewardsDb.test.ts`

Expected: FAIL (module/migration missing).

- [ ] **Step 3: Add migration `004_vship_boost_accounting`**

Append to `MIGRATIONS` in `src/db/index.ts`:

```sql
CREATE TABLE IF NOT EXISTS reward_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_boost_bps TEXT NOT NULL,
  vship_price_usd_raw TEXT NOT NULL,
  vship_price_usd_decimals INTEGER NOT NULL,
  vship_token_decimals INTEGER NOT NULL,
  fee_mint_stale_blocks INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO reward_config (
  id, base_boost_bps, vship_price_usd_raw, vship_price_usd_decimals,
  vship_token_decimals, fee_mint_stale_blocks, updated_at
) VALUES (1, '40000', '50000', 6, 6, 20000, 0);

CREATE TABLE IF NOT EXISTS wallet_boost (
  address TEXT PRIMARY KEY,
  additional_boost_bps TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_vship_state (
  address TEXT PRIMARY KEY,
  fee_watermark_raw TEXT NOT NULL,
  crystallized_vship_raw TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boost_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  address TEXT,
  old_bps TEXT NOT NULL,
  new_bps TEXT NOT NULL,
  actor TEXT NOT NULL,
  settled_wallet_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vship_settlement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settled_at INTEGER NOT NULL,
  address TEXT NOT NULL,
  fee_before_raw TEXT NOT NULL,
  fee_after_raw TEXT NOT NULL,
  fee_delta_raw TEXT NOT NULL,
  boost_bps_applied TEXT NOT NULL,
  vship_minted_raw TEXT NOT NULL,
  crystallized_vship_after_raw TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boost_change_events_changed_at
  ON boost_change_events(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_vship_settlement_events_address_settled_at
  ON vship_settlement_events(address, settled_at DESC);
```

Implement `src/db/rewards.ts` with the interfaces above (normalize addresses with `getAddress` at write boundaries if callers pass checksummed values; store checksummed form consistently). Export from `src/db/index.ts`: `export * from "./rewards";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/rewardsDb.test.ts test/db.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts src/db/rewards.ts test/rewardsDb.test.ts test/db.test.ts
git commit -m "$(cat <<'EOF'
feat: add vSHIP boost reward tables and helpers

EOF
)"
```

---

### Task 3: Integer vSHIP Math

**Suggested execution agent:** `implementer_simple` — isolated pure-bigint helper with fixed inputs and outputs.

**Files:**
- Create: `src/rewards/vshipMath.ts`
- Create: `test/vshipMath.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `calculateVShipRaw(feeRaw: bigint, boostBps: bigint, priceUsdRaw: bigint, priceUsdDecimals: number, tokenDecimals: number, feeDecimals?: number): bigint`
  - Defaults: `feeDecimals = 6`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/vshipMath.test.ts`

Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Mirror dashboard `calculateVShipRaw`:

```ts
const BPS = 10_000n;

function powerOfTen(decimals: number): bigint {
  let value = 1n;
  for (let i = 0; i < decimals; i += 1) value *= 10n;
  return value;
}

export function calculateVShipRaw(
  feeRaw: bigint,
  boostBps: bigint,
  priceUsdRaw: bigint,
  priceUsdDecimals: number,
  tokenDecimals: number,
  feeDecimals = 6,
): bigint {
  if (feeRaw <= 0n || boostBps < 0n || priceUsdRaw <= 0n) return 0n;
  const numerator =
    feeRaw * boostBps * powerOfTen(priceUsdDecimals) * powerOfTen(tokenDecimals);
  const denominator = powerOfTen(feeDecimals) * BPS * priceUsdRaw;
  return (numerator + denominator / 2n) / denominator;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/vshipMath.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rewards/vshipMath.ts test/vshipMath.test.ts
git commit -m "$(cat <<'EOF'
feat: add integer vSHIP conversion helper

EOF
)"
```

---

### Task 4: Settlement Service and Gates

**Suggested execution agent:** `implementer_complex` — financial settlement, readiness gates, eligible-wallet selection, and transaction boundaries are cross-cutting.

**Files:**
- Modify: `src/api/queries.ts` (extract/export estimated fee helper)
- Create: `src/rewards/settle.ts`
- Create: `test/settle.test.ts`

**Interfaces:**
- Consumes: reward DB helpers, `calculateVShipRaw`, account fee valuation
- Produces:
  - `readEstimatedPerformanceFeeRaw(db, config, address): bigint | null`
  - `assertMutationReady(db, config, safeHead: number | null): void` throws `MutationNotReadyError`
  - `assertFeeMintFresh(db, config): void` throws `StaleFeeMintError`
  - `settleWallet(db, config, address, boostBpsApplied, reason, settledAt): { minted: bigint }`
  - `setBaseBoost(db, config, newBaseBoostBps: bigint, safeHead: number | null, actor: string): { settledWalletCount: number; changed: boolean }`
  - `setWalletAdditionalBoost(db, config, address, newAdditionalBoostBps: bigint, safeHead: number | null, actor: string): { settledWalletCount: number; changed: boolean }`

**Eligible wallet union for base settle:** addresses from `wallet_vship_state` ∪ `wallet_boost` ∪ `account_positions` where `readEstimatedPerformanceFeeRaw` is non-null and `> 0` (compute over `account_positions` rows). Sort addresses ascending for determinism.

- [ ] **Step 1: Write the failing tests**

In `test/settle.test.ts`, seed a minimal indexed account with snapshot + position so `estimatedPerformanceFee` is known (reuse patterns from `test/api.test.ts`). Cover:

1. First settle of fee `1_000_000` at 4x mints `80_000_000` vSHIP and sets watermark.
2. Second settle with same fee mints `0`.
3. After fee grows by another `1_000_000` under 4x, settle mints another `80_000_000`.
4. Change additional boost `0 → 100000` settles under old 4x, then pending/new growth uses 14x.
5. Fee dip below watermark mints `0` and leaves watermark unchanged.
6. Identical boost PUT returns `changed: false` and inserts no events.
7. `assertMutationReady` throws when `safeHead` null, or cursor `< safeHead`, or no valuation snapshot.
8. `assertFeeMintFresh` throws when blocks since mint ≥ stale threshold (temporarily lower `fee_mint_stale_blocks` in DB for the test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/settle.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extract fee helper and implement settle**

Refactor `getAccountMetrics` so estimated fee computation is available as:

```ts
export function readEstimatedPerformanceFeeRaw(
  db: Database.Database,
  config: AppConfig,
  address: string,
): bigint | null
```

Return `null` when valuation is unavailable (same as today’s null `estimatedPerformanceFee.raw`).

Implement `src/rewards/settle.ts`:

```ts
export class MutationNotReadyError extends Error {
  readonly code = "indexer_not_ready" as const;
}
export class StaleFeeMintError extends Error {
  readonly code = "stale_fee_mint" as const;
}

// assertMutationReady:
// - safeHead === null → throw
// - cursorBlock === null || cursorBlock < safeHead → throw
// - readEstimatedPerformanceFeeRaw for a probe OR valuation snapshot missing → throw
//   (prefer checking valuation snapshot context directly)

// settleWallet:
// feeNow = readEstimatedPerformanceFeeRaw(...) ?? 0n  // treat null as 0 only after readiness passed
// state = readWalletVshipState or {0,0}
// delta = feeNow >= watermark ? feeNow - watermark : 0n
// minted = calculateVShipRaw(delta, boostBpsApplied, price...)
// crystallized = old + minted
// if feeNow >= watermark: watermark = feeNow
// upsert state; if minted > 0 or delta handled, always write settlement event when called from boost change even if minted 0? Spec: still settle; prefer insert event only when fee_delta > 0 OR always for audit of boost path.
// Spec intent: crystallize then change boost. Insert settlement event when fee_delta > 0; skip empty settlement rows.
```

`setBaseBoost` / `setWalletAdditionalBoost`:

1. `assertMutationReady` then `assertFeeMintFresh`
2. If new === old → `{ changed: false, settledWalletCount: 0 }`
3. Else transaction: settle eligible under **old** totals → write boost → insert `boost_change_events`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/settle.test.ts test/api.test.ts`

Expected: PASS (existing account API still works; fee helper extraction must not change USDC fields).

- [ ] **Step 5: Commit**

```bash
git add src/api/queries.ts src/rewards/settle.ts test/settle.test.ts
git commit -m "$(cat <<'EOF'
feat: add vSHIP settle service with readiness and stale gates

EOF
)"
```

---

### Task 5: Extend `GET /accounts/:address` with Boost and vSHIP

**Suggested execution agent:** `implementer_simple` — a bounded response extension using interfaces established by Tasks 2–4.

**Files:**
- Modify: `src/api/queries.ts`
- Modify: `test/api.test.ts`

**Interfaces:**
- Consumes: reward config/state, `calculateVShipRaw`
- Produces: account JSON fields `boost` and `vship` per spec

- [ ] **Step 1: Write the failing tests**

In `test/api.test.ts`:

```ts
test("account metrics include base boost and pending vSHIP from estimated fee", async (t) => {
  // seed account with estimatedPerformanceFee raw = 1_000_000
  // no wallet_vship_state
  // expect:
  // boost.baseBoostBps === "40000"
  // boost.additionalBoostBps === "0"
  // boost.totalBoostBps === "40000"
  // vship.crystallizedRaw === "0"
  // vship.pendingRaw === "80000000"
  // vship.totalRaw === "80000000"
  // vship.feeWatermarkRaw === "0"
  // vship.priceUsdRaw === "50000"
});

test("pre-deposit wallet_boost still returns additional boost with zero vSHIP", async (t) => {
  // upsert wallet_boost only; no position
  // expect additionalBoostBps "100000", total "140000", vship totals "0"
});
```

Also assert an existing account fixture’s USDC fee fields remain unchanged numerically.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/api.test.ts`

Expected: FAIL (missing fields).

- [ ] **Step 3: Implement response extension**

In `getAccountMetrics`, after computing `estimatedPerformanceFee`:

```ts
const reward = readRewardConfig(db);
const additional = readWalletAdditionalBoostBps(db, address);
const totalBoost = reward.baseBoostBps + additional;
const state = readWalletVshipState(db, address);
const watermark = state?.feeWatermarkRaw ?? 0n;
const crystallized = state?.crystallizedVshipRaw ?? 0n;
const feeNow = estimatedPerformanceFeeRaw ?? 0n; // use bigint from helper
const pendingFee = feeNow > watermark ? feeNow - watermark : 0n;
const pending = calculateVShipRaw(
  pendingFee,
  totalBoost,
  reward.vshipPriceUsdRaw,
  reward.vshipPriceUsdDecimals,
  reward.vshipTokenDecimals,
);

// attach boost + vship string fields
```

When valuation is null, still return boost; set `pendingRaw`/`totalRaw` from crystallized only (pending `0`) and `feeWatermarkRaw` from state or `"0"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/queries.ts test/api.test.ts
git commit -m "$(cat <<'EOF'
feat: expose boost and vSHIP fields on account metrics

EOF
)"
```

---

### Task 6: Admin HTTP Routes

**Suggested execution agent:** `implementer_complex` — authenticated async HTTP handling, transactional mutations, error mapping, and bigint serialization meet here.

**Files:**
- Create: `src/api/admin.ts`
- Modify: `src/api/server.ts`
- Modify: `test/api.test.ts`

**Interfaces:**
- Consumes: `config.adminApiToken`, settle service, reward list helpers
- Produces: routes when token configured:
  - `PUT /admin/boost/base`
  - `PUT /admin/boost/wallets/:address`
  - `GET /admin/boost/changes`
  - `GET /admin/vship/settlements/:address`
  - History JSON uses decimal strings for every bigint field
  - Unexpected handler or transaction errors return `500` after SQLite rollback

- [ ] **Step 1: Write the failing tests**

```ts
test("admin routes are 404 when ADMIN_API_TOKEN is unset", async (t) => {
  const server = createApiServer({ db, config: createConfig(), health: { safeHead: 1 } });
  // PUT /admin/boost/base → 404
});

test("enabled admin routes require bearer token", async (t) => {
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  // PUT without header → 401
  // PUT with wrong token → 401
});

test("PUT base boost settles and updates config when ready", async (t) => {
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  // seed synced cursor == safeHead, snapshot, account with fee
  // PUT { baseBoostBps: "50000" } with Authorization Bearer secret → 200
  // GET account shows new base; crystallized locked; history endpoints return rows
});

test("PUT boost returns 409 when indexer not ready", async (t) => {
  // safeHead null or cursor behind → 409 { error: "indexer not ready" }
});

test("PUT boost returns 409 when fee mint is stale", async (t) => {
  // set fee_mint_stale_blocks low; blocksSince large → 409
});

test("GET admin history endpoints return newest-first rows", async (t) => {
  // after a wallet boost change, GET /admin/boost/changes and settlements
  // assert oldBps/newBps, fee raw values, boostBpsApplied, and vSHIP raw values
  // are decimal JSON strings rather than bigint values
});

test("PUT transaction failure returns 500 and rolls back all reward writes", async (t) => {
  // seed a ready account with fee and no wallet_vship_state
  // install a SQLite BEFORE UPDATE trigger on reward_config that raises ABORT
  // PUT a changed base boost with valid auth
  // expect 500 { error: "internal server error" }
  // expect base boost still 40000, no wallet_vship_state row,
  // and no boost-change or settlement events
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/api.test.ts`

Expected: FAIL (PUT still globally 404 / routes missing).

- [ ] **Step 3: Implement admin module and server wiring**

`src/api/admin.ts`:

```ts
export function requireAdminAuth(
  request: http.IncomingMessage,
  adminApiToken: string,
): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === adminApiToken;
}

export async function handleAdminRequest(...): Promise<boolean> {
  // return true if handled
}
```

Before writing admin history responses, map repository bigint fields to
decimal strings. Do not pass repository rows containing bigint directly to
`writeJson` / `JSON.stringify`:

```ts
function serializeBoostChangeEvent(row: BoostChangeEventRow) {
  return {
    ...row,
    oldBps: row.oldBps.toString(),
    newBps: row.newBps.toString(),
  };
}

function serializeVshipSettlementEvent(row: VshipSettlementEventRow) {
  return {
    ...row,
    feeBeforeRaw: row.feeBeforeRaw.toString(),
    feeAfterRaw: row.feeAfterRaw.toString(),
    feeDeltaRaw: row.feeDeltaRaw.toString(),
    boostBpsApplied: row.boostBpsApplied.toString(),
    vshipMintedRaw: row.vshipMintedRaw.toString(),
    crystallizedVshipAfterRaw: row.crystallizedVshipAfterRaw.toString(),
  };
}
```

In `createApiServer`:

```ts
const adminEnabled = config.adminApiToken !== null;

// Replace blanket non-GET/HEAD rejection with:
if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "PUT") {
  writeJson(response, 404, { error: "not found" });
  return;
}

if (url.pathname.startsWith("/admin")) {
  if (!adminEnabled) {
    writeJson(response, 404, { error: "not found" });
    return;
  }
  if (!requireAdminAuth(request, config.adminApiToken!)) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }
  // dispatch PUT/GET admin handlers; parse JSON body for PUT
  // map MutationNotReadyError / StaleFeeMintError → 409
  // invalid address/bps → 400
  // any other handler/SQLite error → 500 { error: "internal server error" }
  // do not expose the internal exception text
  return;
}
```

Pass `health?.safeHead ?? null` into settle calls.

Wrap admin dispatch in `try/catch`. Let the `db.transaction(...)` inside the
settlement service roll back first, then map an otherwise-unrecognized error
to `500`. The rollback test above must prove that settlement state and both
audit tables remain unchanged.

Body validation: `baseBoostBps` / `additionalBoostBps` must be non-negative integer strings (bigint parse, no decimals, `additional` and `base` ≥ 0).

- [ ] **Step 4: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/admin.ts src/api/server.ts test/api.test.ts
git commit -m "$(cat <<'EOF'
feat: add gated admin boost and vSHIP history APIs

EOF
)"
```

---

### Task 7: Documentation

**Suggested execution agent:** `implementer_simple` — documentation-only reconciliation after the runtime behavior is fixed.

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/api-integration-guide.md`
- Modify: `docs/overview.md`
- Modify: `docs/evolution.md`
- Modify: `README.md` (env + endpoints if listed)

- [ ] **Step 1: Update docs to match shipped behavior**

Document:

- New tables and settle semantics
- Admin routes conditional on `ADMIN_API_TOKEN`
- Mutation-readiness + stale fee-mint gates (`409`)
- Extended account `boost` / `vship` fields
- Cutover: nuke + reindex; no backfill
- Non-goals: Morpho move, dashboard wiring, chain txs

- [ ] **Step 2: Skim for contradictions**

Confirm overview no longer claims “read-only HTTP only” without mentioning optional admin writes when token configured.

- [ ] **Step 3: Commit**

```bash
git add docs README.md
git commit -m "$(cat <<'EOF'
docs: document vSHIP boost accounting and admin APIs

EOF
)"
```

---

## Spec Coverage Self-Check

| Spec requirement | Task |
| --- | --- |
| Additive boost, $0.05, default 4x | 2, 3, 5 |
| Watermark soft crystallize, no backprop, sticky dip | 4 |
| Eager settle base/wallet, one txn | 4, 6 |
| New tables only; USDC tables untouched | 2 |
| History tables + admin history GETs | 2, 6 |
| History bigint fields serialized as JSON decimal strings | 6 |
| Admin auth only when token configured (else 404) | 1, 6 |
| Mutation-readiness gate | 4, 6 |
| Stale fee-mint gate (~20k) | 2, 4, 6 |
| Account boost/vSHIP fields | 5 |
| Transaction failure returns 500 with full rollback | 4, 6 |
| Nuke+reindex cutover; no genesis backfill | 7 (ops note); no backfill code in 2–6 |
| Indexer-only / no Morpho / no dashboard wire | Global + 7 |
| Tests listed in spec | 3–6 |

## Placeholder / Consistency Notes

- Settlement event policy: insert `vship_settlement_events` only when `fee_delta > 0` to avoid noise; boost change still always writes `boost_change_events` when values change.
- `readEstimatedPerformanceFeeRaw` must match `getAccountMetrics` fee math exactly (including odd-unit cap behavior).
- Admin PUT responses should include at least `{ ok: true, changed, settledWalletCount, baseBoostBps? / additionalBoostBps? }` — keep JSON minimal and stringly for bps.
- Reward repository helpers may use bigint internally; every admin history HTTP response must serialize those values as decimal strings.
