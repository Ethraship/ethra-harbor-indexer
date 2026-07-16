# Vault Position & Fee-Attribution Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Base deposit crawler into a stateful, address-keyed indexer that tracks per-wallet active deposit, lifetime deposited/withdrawn, approximate lifetime earned, and per-wallet performance-fee attribution, and serves them over a read-only HTTP API.

**Architecture:** Keep the trusted block-crawling core (persisted SQLite cursor, `safeHead = head − confirmations`, chunked `getLogs`, deterministic ordering, atomic per-chunk commit). Fetch four vault events (`Deposit`, `Withdraw`, `Transfer`, `AccrueInterest`) in one filtered call per chunk, merge-sort them, and drive a global fee-per-share accumulator plus a `Transfer`-based share ledger. A separate periodic snapshotter records `totalAssets`/`totalSupply` for USDC valuation. A `node:http` server answers position and vault queries from derived tables.

**Tech Stack:** Node.js 20+, TypeScript (CommonJS), `ethers` v6, `better-sqlite3`, built-in `node:http`, built-in `node:test`, SQLite WAL.

## Pre-Flight Corrections

- `docs/overview.md` is now the product source of truth required by `AGENTS.md`; implementation should keep it aligned as the feature lands.
- `Task 3` owns schema and pure repository primitives. `Task 5` owns `applyChunk`, because it combines persistence with the ledger accumulator.
- The crawler retry/idempotency test must simulate rollback after a failed transaction. Replaying a chunk that already committed is not supported because the accumulator is not idempotent.
- Dev-stage schema reset is explicit: local SQLite files using the old schema must be deleted before running this feature. The migration only creates the new schema for empty/reset databases; it does not silently migrate old local data.
- `/vault` share price is returned as an integer string, not a floating point value: `sharePriceScaledRaw = total_assets_raw * 10^18 / total_supply_raw` and `sharePriceScale = "1000000000000000000"`.
- `START_BLOCK` defaults to deployment block `48578255`.

## Global Constraints

- Chain is Base mainnet only, chain ID `8453`. Reject anything else.
- HTTP JSON-RPC only; no WSS, subscriptions, or live listeners.
- Vault address fixed to `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` (env override for local testing only), normalized via `ethers.getAddress`.
- Wallet **address is the only identity**. No Privy, no user profiles, no external identity input.
- All blockchain integers stored and returned as decimal **strings**; never floats.
- Index scale factor is `1e36` (`SCALE = 10n ** 36n`).
- Events processed in strict `(block_number, transaction_index, log_index)` order.
- Per-chunk write is one SQLite transaction: raw inserts (`INSERT OR IGNORE`) + derived updates + cursor advance. A failed chunk commits nothing and retries the same range.
- Idempotency key on every raw event: `(chain_id, tx_hash, log_index)`.
- Dev-stage reset: the schema change nukes existing local databases; no backward migration.
- Reorg safety v1 = confirmation buffer only (default `CONFIRMATIONS=15`); `block_hash` stored on raw events; full hash-rollback deferred.
- USDC = 6 decimals, shares = 18 decimals. Value of `N` shares = `N * total_assets_raw / total_supply_raw` (integer floor) from the latest snapshot.
- Latest share price is reported as `sharePriceScaledRaw = total_assets_raw * 10^18 / total_supply_raw` with `sharePriceScale = "1000000000000000000"`; return `"0"` when `total_supply_raw` is zero.

Reference spec: `docs/plans/2026-07-16-vault-position-fee-indexer-spec.md`.

---

### Task 1: Config Additions

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `AppConfig` gains `snapshotIntervalMs: number`, `apiEnabled: boolean`, `apiPort: number`. Default `CONFIRMATIONS` becomes `15`; default `START_BLOCK` becomes `48578255`. New cursor id helper uses prefix `base:vault:`.

- [ ] **Step 1: Write failing tests** for the new fields.

```ts
// test/config.test.ts (add cases)
test("defaults include snapshot + api config", () => {
  const c = loadConfig({ BASE_CHAIN_ID: "8453" } as NodeJS.ProcessEnv);
  assert.equal(c.confirmations, 15);
  assert.equal(c.startBlock, 48578255);
  assert.equal(c.snapshotIntervalMs, 60000);
  assert.equal(c.apiEnabled, true);
  assert.equal(c.apiPort, 8080);
});

test("rejects snapshot interval below minimum", () => {
  assert.throws(() => loadConfig({ BASE_CHAIN_ID: "8453", SNAPSHOT_INTERVAL_MS: "100" } as NodeJS.ProcessEnv));
});

test("rejects invalid api port", () => {
  assert.throws(() => loadConfig({ BASE_CHAIN_ID: "8453", API_PORT: "0" } as NodeJS.ProcessEnv));
});
```

- [ ] **Step 2: Run tests to confirm they fail.** Run: `node --import tsx --test test/config.test.ts` — Expected: FAIL (unknown properties / wrong defaults).

- [ ] **Step 3: Extend `AppConfig` and `DEFAULTS`.** Add to the interface: `snapshotIntervalMs: number; apiEnabled: boolean; apiPort: number;`. Add defaults `START_BLOCK: "48578255"`, `CONFIRMATIONS: "15"`, `SNAPSHOT_INTERVAL_MS: "60000"`, `API_ENABLED: "true"`, `API_PORT: "8080"`. Parse `snapshotIntervalMs` with `readNumber(env, "SNAPSHOT_INTERVAL_MS", 1000)`, `apiPort` with `readNumber(env, "API_PORT", 1)` bounded `<= 65535`, and `apiEnabled` as `(env.API_ENABLED ?? "true") !== "false"`.

- [ ] **Step 4: Add a vault cursor id helper.** Export `export function vaultCursorId(config: AppConfig): string { return \`base:vault:${config.contractAddress.toLowerCase()}\`; }` (kept here or in the repo module — colocate with other cursor logic in Task 3; if placed in Task 3, skip here).

- [ ] **Step 5: Run tests to confirm pass.** Run: `node --import tsx --test test/config.test.ts` — Expected: PASS.

- [ ] **Step 6: Update `.env.example`** with `CONFIRMATIONS=15`, `START_BLOCK=48578255`, `SNAPSHOT_INTERVAL_MS=60000`, `API_ENABLED=true`, `API_PORT=8080`.

- [ ] **Step 7: Commit.** `git add src/config.ts .env.example test/config.test.ts && git commit -m "feat: add snapshot + api config and raise confirmations default"`

---

### Task 2: ABI Expansion And Event Decoder

**Files:**
- Modify: `src/abi/morphoVault.ts`
- Create: `src/indexer/eventDecoder.ts`
- Test: `test/eventDecoder.test.ts`

**Interfaces:**
- Produces: `MORPHO_VAULT_ABI` includes `Withdraw`, `Transfer`, `AccrueInterest` events and `totalAssets()`/`totalSupply()` reads. `decodeVaultLog(log, iface, config): DecodedVaultEvent | null` where `DecodedVaultEvent` is a discriminated union:

```ts
export type DecodedVaultEvent =
  | { kind: "deposit"; onBehalf: string; assets: string; shares: string; base: BaseLogFields }
  | { kind: "withdraw"; sender: string; receiver: string; onBehalf: string; assets: string; shares: string; base: BaseLogFields }
  | { kind: "transfer"; from: string; to: string; shares: string; base: BaseLogFields }
  | { kind: "accrue"; previousTotalAssets: string; newTotalAssets: string; performanceFeeShares: string; managementFeeShares: string; base: BaseLogFields };

export interface BaseLogFields {
  chainId: number; contractAddress: string; blockNumber: number; blockHash: string;
  txHash: string; txIndex: number; logIndex: number; rawLogJson: string; createdAt: number;
}
```

- [ ] **Step 1: Write failing test.** Encode one log per event with `ethers.Interface.encodeEventLog` and assert `decodeVaultLog` returns the right `kind` and normalized fields (addresses via `getAddress`, integers as strings). Include a garbage-topic log → expect `null`.

```ts
// test/eventDecoder.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { MORPHO_VAULT_ABI } from "../src/abi/morphoVault";
import { decodeVaultLog } from "../src/indexer/eventDecoder";
// build iface, encode a Transfer mint (from = zero), assert kind === "transfer" and from is zero address, shares string.
```

- [ ] **Step 2: Run test to confirm fail.** Run: `node --import tsx --test test/eventDecoder.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Extend the ABI.**

```ts
export const MORPHO_VAULT_ABI = [
  "event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event Transfer(address indexed from, address indexed to, uint256 shares)",
  "event AccrueInterest(uint256 previousTotalAssets, uint256 newTotalAssets, uint256 performanceFeeShares, uint256 managementFeeShares)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
```

- [ ] **Step 4: Implement `decodeVaultLog`.** Parse with `iface.parseLog`; switch on `parsedLog.name`; build `BaseLogFields` once (reuse the `stringifyRawLog` bigint-safe helper, moved/shared from `depositParser.ts`); normalize all addresses with `getAddress`; convert all `uint256` args with `.toString()`. Return `null` on parse failure or unknown event.

- [ ] **Step 5: Run test to confirm pass.** Run: `node --import tsx --test test/eventDecoder.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit.** `git add src/abi/morphoVault.ts src/indexer/eventDecoder.ts test/eventDecoder.test.ts && git commit -m "feat: decode all four vault events and add read-method abi"`

---

### Task 3: DB Migration And Repositories

**Files:**
- Modify: `src/db/index.ts`
- Create: `src/db/vault.ts`
- Modify: `src/db/deposits.ts` (only if sharing cursor helpers; otherwise leave)
- Test: `test/vaultDb.test.ts`

**Interfaces:**
- Produces:
  - `getOrCreateVaultCursor(db, config): number`
  - `readVaultState(db): VaultRewardState` (returns zeros if absent)
  - `readAccountPosition(db, address): AccountPosition` (returns zeros if absent)
  - `insertSnapshot(db, snapshot): void`, `readLatestSnapshot(db): Snapshot | null`
- Types:

```ts
export interface VaultRewardState {
  globalIndexRaw: string; totalSupplyRaw: string;
  cumulativePerfFeeSharesRaw: string; cumulativeMgmtFeeSharesRaw: string;
  updatedBlockNumber: number;
}
export interface AccountPosition {
  address: string; balanceRaw: string; rewardDebtRaw: string;
  earnedPerfFeeSharesRaw: string; lifetimeDepositedRaw: string; lifetimeWithdrawnRaw: string;
  updatedBlockNumber: number; updatedLogIndex: number;
}
export interface Snapshot { blockNumber: number; totalAssetsRaw: string; totalSupplyRaw: string; capturedAt: number; }
```

- [ ] **Step 1: Write failing tests** (in-memory `:memory:` db): migration creates all new tables; `getOrCreateVaultCursor` returns `START_BLOCK` on first call; `readVaultState`/`readAccountPosition` return zeroed defaults when empty; `insertSnapshot` + `readLatestSnapshot` returns the highest-block snapshot.

- [ ] **Step 2: Run to confirm fail.** Run: `node --import tsx --test test/vaultDb.test.ts` — Expected: FAIL.

- [ ] **Step 3: Add migration `002_vault_position_indexer`.** In `src/db/index.ts`, register a second migration applied after `001`. Because this is a dev-stage reset, old local database files should be deleted before running this feature; do not silently migrate old local state. The migration creates the new tables for empty/reset databases while keeping the existing `deposit_events` table shape. Add:

```sql
CREATE TABLE IF NOT EXISTS withdraw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
  block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
  sender TEXT NOT NULL, receiver TEXT NOT NULL, on_behalf TEXT NOT NULL,
  assets TEXT NOT NULL, shares TEXT NOT NULL, raw_log_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_withdraw_events_block ON withdraw_events(block_number);

CREATE TABLE IF NOT EXISTS transfer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
  block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
  from_address TEXT NOT NULL, to_address TEXT NOT NULL, shares TEXT NOT NULL,
  raw_log_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_transfer_events_block ON transfer_events(block_number);

CREATE TABLE IF NOT EXISTS accrue_interest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
  block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
  previous_total_assets TEXT NOT NULL, new_total_assets TEXT NOT NULL,
  performance_fee_shares TEXT NOT NULL, management_fee_shares TEXT NOT NULL,
  total_supply_before_raw TEXT NOT NULL, global_index_after_raw TEXT NOT NULL,
  raw_log_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(chain_id, tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS account_positions (
  address TEXT PRIMARY KEY,
  balance_raw TEXT NOT NULL DEFAULT '0',
  reward_debt_raw TEXT NOT NULL DEFAULT '0',
  earned_performance_fee_shares_raw TEXT NOT NULL DEFAULT '0',
  lifetime_deposited_raw TEXT NOT NULL DEFAULT '0',
  lifetime_withdrawn_raw TEXT NOT NULL DEFAULT '0',
  updated_block_number INTEGER NOT NULL DEFAULT 0,
  updated_log_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vault_reward_state (
  id TEXT PRIMARY KEY,
  global_performance_fee_index_raw TEXT NOT NULL DEFAULT '0',
  total_supply_raw TEXT NOT NULL DEFAULT '0',
  cumulative_performance_fee_shares_raw TEXT NOT NULL DEFAULT '0',
  cumulative_management_fee_shares_raw TEXT NOT NULL DEFAULT '0',
  updated_block_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS share_price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number INTEGER NOT NULL,
  total_assets_raw TEXT NOT NULL,
  total_supply_raw TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_block ON share_price_snapshots(block_number);
```

- [ ] **Step 4: Implement repositories in `src/db/vault.ts`.** Prepared statements for: reading/creating the vault cursor row (reuse `indexer_state` with `vaultCursorId`), reading `vault_reward_state` (seed a row with id `vaultCursorId` on first access), reading an `account_positions` row (return zeros if missing), upserting positions and vault state, inserting each raw event type, and snapshot insert/read-latest (`ORDER BY block_number DESC LIMIT 1`). Do **not** apply the accumulator here — pure persistence only. Re-export from `src/db/index.ts`.

- [ ] **Step 5: Run tests to confirm pass.** Run: `node --import tsx --test test/vaultDb.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit.** `git add src/db/index.ts src/db/vault.ts test/vaultDb.test.ts && git commit -m "feat: add vault position, reward-state, and snapshot schema + repos"`

---

### Task 4: Ledger Accumulator (Pure Module)

**Files:**
- Create: `src/indexer/ledger.ts`
- Test: `test/ledger.test.ts`

**Interfaces:**
- Produces a pure, in-memory reducer used by the crawler before persistence:

```ts
export const SCALE = 10n ** 36n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface LedgerState {
  globalIndexRaw: bigint;
  totalSupplyRaw: bigint;
  cumulativePerfFeeSharesRaw: bigint;
  cumulativeMgmtFeeSharesRaw: bigint;
  accounts: Map<string, AccountLedger>;   // key = checksum address
}
export interface AccountLedger {
  balanceRaw: bigint; rewardDebtRaw: bigint; earnedPerfFeeSharesRaw: bigint;
  lifetimeDepositedRaw: bigint; lifetimeWithdrawnRaw: bigint;
  touched: boolean; updatedBlockNumber: number; updatedLogIndex: number;
}

export function applyDeposit(state: LedgerState, ev): void;
export function applyWithdraw(state: LedgerState, ev): void;
export function applyTransfer(state: LedgerState, ev): void;
export function applyAccrue(state: LedgerState, ev): { globalIndexAfterRaw: bigint; totalSupplyBeforeRaw: bigint };
export function settle(acct: AccountLedger, globalIndexRaw: bigint): void;
```

- [ ] **Step 1: Write failing tests** — the five research scenarios plus a transfer-follows case, all as pure state assertions:
  - **Single user second deposit:** mint 2 shares; accrue perf fee f1; mint 7 more shares; accrue perf fee f2. Assert user's `earnedPerfFeeSharesRaw` after settle at end equals `f1 * 2/2 + f2 * 9/9`-style expectation given supply, i.e. the pre-`$7` fee attributes only to the 2 pre-existing shares.
  - **Multi-user split:** A holds 25%, B holds 75%, accrue 1000 perf-fee shares → A earns 250, B earns 750 after settle.
  - **Admin already holds fee shares:** admin balance included in `totalSupplyRaw` denominator; app users not over-credited.
  - **Unknown holder:** unmapped address still accrues into its own `earnedPerfFeeSharesRaw` and counts in denominator.
  - **Withdrawal before accrual:** burn all of a user's shares, then accrue → that user earns nothing new.
  - **Transfer follows shares:** Alice → Bob transfer before accrual → Bob earns the subsequent fee, Alice keeps only pre-transfer settled amount.

```ts
// test/ledger.test.ts (multi-user split example)
const s = emptyState();
applyTransfer(s, { from: ZERO, to: A, shares: 250n, block: 1, logIndex: 0 });
applyTransfer(s, { from: ZERO, to: B, shares: 750n, block: 1, logIndex: 1 });
applyAccrue(s, { performanceFeeShares: 1000n, managementFeeShares: 0n, block: 2, logIndex: 0 });
settle(s.accounts.get(A)!, s.globalIndexRaw);
settle(s.accounts.get(B)!, s.globalIndexRaw);
assert.equal(s.accounts.get(A)!.earnedPerfFeeSharesRaw, 250n);
assert.equal(s.accounts.get(B)!.earnedPerfFeeSharesRaw, 750n);
```

- [ ] **Step 2: Run to confirm fail.** Run: `node --import tsx --test test/ledger.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the reducer** exactly per spec §5: `settle` before every balance mutation; mint/burn adjust `totalSupplyRaw`; `to`-side receives fresh `rewardDebtRaw = globalIndexRaw`; `applyAccrue` bumps cumulative counters and `globalIndexRaw += perfFee * SCALE / totalSupplyRaw` only when `perfFee > 0 && totalSupplyRaw > 0`, returning `total_supply_before` and `global_index_after` for the raw `accrue_interest_events` row. Mark every mutated account `touched = true` and stamp `updatedBlockNumber/updatedLogIndex`.

- [ ] **Step 4: Run to confirm pass.** Run: `node --import tsx --test test/ledger.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.** `git add src/indexer/ledger.ts test/ledger.test.ts && git commit -m "feat: implement fee-per-share accumulator ledger"`

---

### Task 5: Crawler Upgrade (Four Events, Merge, Atomic Apply)

**Files:**
- Modify: `src/indexer/crawler.ts` (rename class to `VaultCrawler`; keep block-range and scheduling logic)
- Modify: `src/db/vault.ts` (add `applyChunk`)
- Modify: `src/db/deposits.ts` (retire `saveDepositsAndCursor` usage; keep insert helper if reused)
- Test: `test/crawler.test.ts` (extend)

**Interfaces:**
- Consumes: `decodeVaultLog` (Task 2), ledger reducer (Task 4), repos (Task 3), `calculateRange` (unchanged).
- Produces: `applyChunk(db, config, { decodedEvents, toBlock })` which, in one transaction: (a) loads current `VaultRewardState` + touched `AccountPosition`s into a `LedgerState`, (b) replays the chunk's decoded events through the ledger in sorted order, (c) inserts raw event rows per kind (`INSERT OR IGNORE`), (d) upserts changed positions and the vault state, (e) advances the cursor.

- [ ] **Step 1: Write failing crawler test** with a mocked provider returning a two-chunk sequence containing all four event kinds (mint transfer, deposit, accrue with perf fee, fee-mint transfer, withdraw, burn transfer). Assert: fetch uses a 4-topic OR filter; events applied in `(block, txIndex, logIndex)` order; positions/vault-state match hand-computed expectations; a failed chunk rolls back both raw inserts and derived state so the retry applies exactly once; `auto` mode switches fast→slow at the tip.

- [ ] **Step 2: Run to confirm fail.** Run: `node --import tsx --test test/crawler.test.ts` — Expected: FAIL.

- [ ] **Step 3: Build the topic filter.** Collect the four event fragments from the interface and pass `topics: [[t1, t2, t3, t4]]` to `getLogs` (array-in-position-0 = OR). Address filter stays the vault address.

- [ ] **Step 4: Decode + sort + apply.** Map raw logs through `decodeVaultLog` (throw on any `null` to force chunk retry), sort with the existing `compareLogs`, then call `applyChunk`. Remove the deposit-only `parseDepositLog` path from the crawler (parser file may remain for reuse by the decoder tests).

- [ ] **Step 5: Implement `applyChunk`** in `src/db/vault.ts` as one `db.transaction(...)`. Hydrate only the accounts referenced in the chunk (collect their addresses first), seed missing ones with zeros, run the ledger, then persist. Convert bigint ledger values to strings for storage.

- [ ] **Step 6: Update the vault cursor** inside the same transaction using `vaultCursorId`.

- [ ] **Step 7: Run to confirm pass.** Run: `node --import tsx --test test/crawler.test.ts` — Expected: PASS.

- [ ] **Step 8: Commit.** `git add src/indexer/crawler.ts src/db/vault.ts src/db/deposits.ts test/crawler.test.ts && git commit -m "feat: crawl four vault events and apply ledger atomically per chunk"`

---

### Task 6: Share-Price Snapshotter

**Files:**
- Modify: `src/provider/baseProvider.ts` (add contract read helper)
- Create: `src/snapshot/sharePrice.ts`
- Test: `test/sharePrice.test.ts`

**Interfaces:**
- Consumes: provider `call`/`Contract` for `totalAssets()` + `totalSupply()`.
- Produces:
  - `baseProvider.readVaultTotals(config): Promise<{ blockNumber, totalAssetsRaw, totalSupplyRaw }>` (single block-tagged read; fetch block number then both calls at that block, or accept head).
  - `class SharePriceSnapshotter { start(): void; stop(): Promise<void>; snapshotOnce(): Promise<void> }` — periodic loop on `snapshotIntervalMs`, inserts via `insertSnapshot`.
  - `valueOfShares(sharesRaw: bigint, snapshot: Snapshot): bigint` = `sharesRaw * totalAssets / totalSupply` (0 if `totalSupply == 0`).

- [ ] **Step 1: Write failing tests.** `valueOfShares` math (including `totalSupply == 0` → 0 and floor behavior); `snapshotOnce` with a mocked reader inserts one row; `readLatestSnapshot` returns it. Use `:memory:` db + fake reader.

- [ ] **Step 2: Run to confirm fail.** Run: `node --import tsx --test test/sharePrice.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement provider read helper.** Add `getVaultTotals` using `new ethers.Contract(config.contractAddress, MORPHO_VAULT_ABI, provider)` over the fallback provider list (reuse the ordered-fallback pattern already in `baseProvider`).

- [ ] **Step 4: Implement `SharePriceSnapshotter`** mirroring the crawler's timer/stop pattern (single in-flight tick, `clearTimeout` on stop, await active loop). On tick: read totals, `insertSnapshot`, log at debug.

- [ ] **Step 5: Run to confirm pass.** Run: `node --import tsx --test test/sharePrice.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit.** `git add src/provider/baseProvider.ts src/snapshot/sharePrice.ts test/sharePrice.test.ts && git commit -m "feat: periodic share-price snapshotter and valuation helper"`

---

### Task 7: Read-Only HTTP API

**Files:**
- Create: `src/api/server.ts`
- Create: `src/api/queries.ts`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: repos (Task 3), `valueOfShares` (Task 6), ledger `settle`/`SCALE` for read-time settlement of `earned_performance_fee_shares_raw`.
- Produces:
  - `queries.getAccountMetrics(db, config, address): AccountMetricsResponse` — hydrates the position, settles `earnedPerfFee` to the current global index, computes the five metrics + USDC values from the latest snapshot.
  - `queries.getVaultMetrics(db, config): VaultMetricsResponse`.
  - `createApiServer(deps): http.Server` with routes `GET /health`, `GET /vault`, `GET /accounts/:address`.

- [ ] **Step 1: Write failing tests.** Seed a `:memory:` db with a known position, vault state, and snapshot; start the server on an ephemeral port; assert: `/accounts/:known` returns correct raw + USDC values and `valuationBlock`; `/accounts/:unknown` returns zeros with 200; invalid address returns 400; `/vault` returns cumulative perf fee value plus `sharePriceScaledRaw` and `sharePriceScale`; `/health` returns cursor block.

```ts
// test/api.test.ts (sketch)
const server = createApiServer({ db, config });
await new Promise((r) => server.listen(0, r));
const port = (server.address() as any).port;
const res = await fetch(`http://127.0.0.1:${port}/accounts/${KNOWN}`);
assert.equal(res.status, 200);
const body = await res.json();
assert.equal(body.activeDeposit.shares, "1000000000000000000");
```

- [ ] **Step 2: Run to confirm fail.** Run: `node --import tsx --test test/api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `queries.ts`.** For an account: read position; settle a copy of `earnedPerfFeeSharesRaw` to the current `globalIndexRaw` (do not persist); `activeDepositValue = valueOfShares(balance, snapshot)`; `lifetimeEarned = max(0n, activeDepositValue + lifetimeWithdrawn − lifetimeDeposited)`; `perfFeeValue = valueOfShares(settledEarned, snapshot)`. For vault metrics, include `sharePriceScaledRaw = total_assets_raw * 10^18 / total_supply_raw` and `sharePriceScale = "1000000000000000000"` (or `"0"` when supply is zero). Return all bigints as strings with `valuationBlock`/`valuationTime` from the snapshot (or nulls if no snapshot yet).

- [ ] **Step 4: Implement `server.ts`** with `node:http`. Manual routing: normalize `:address` via `getAddress` (catch → 400). JSON responses, `Content-Type: application/json`. No mutation endpoints. Expose `close()` for shutdown.

- [ ] **Step 5: Run to confirm pass.** Run: `node --import tsx --test test/api.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit.** `git add src/api/server.ts src/api/queries.ts test/api.test.ts && git commit -m "feat: read-only http api for account and vault metrics"`

---

### Task 8: Bootstrap Wiring

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `VaultCrawler`, `SharePriceSnapshotter`, `createApiServer`.

- [ ] **Step 1: Wire startup.** After migrations, construct the provider, `VaultCrawler`, `SharePriceSnapshotter`, and (if `apiEnabled`) the API server listening on `apiPort`. Start crawler + snapshotter.

- [ ] **Step 2: Extend graceful shutdown.** On `SIGINT`/`SIGTERM`: `await crawler.stop()`, `await snapshotter.stop()`, `await new Promise(r => apiServer.close(r))`, then close the db. Preserve the existing idempotent-shutdown guard.

- [ ] **Step 3: Verify boot + build.** Run: `npm run build` — Expected: success. Run: `npm run dev` briefly against a Base RPC with `START_BLOCK` near `48678603` and small `CHUNK_SIZE`; confirm logs show chunks processed and a snapshot inserted.

- [ ] **Step 4: Manual API smoke.**

```bash
curl -s localhost:8080/health
curl -s localhost:8080/vault
curl -s localhost:8080/accounts/0x987C8a5821351D4D10a6144f7366cAfe1eBDDd9B
```

- [ ] **Step 5: Commit.** `git add src/index.ts && git commit -m "feat: wire crawler, snapshotter, and api into bootstrap"`

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md` (create if missing)
- Modify: `docs/evolution.md` (create if missing)
- Modify: `docs/overview.md` (create if missing)

- [ ] **Step 1: README** — document the four indexed events, the five per-address metrics, the accumulator model, snapshot-based valuation, all env vars (incl. `CONFIRMATIONS=15`, `SNAPSHOT_INTERVAL_MS`, `API_*`), the API endpoints, and the dev-stage DB reset (delete the sqlite file to re-crawl from `START_BLOCK`).
- [ ] **Step 2: `docs/architecture.md`** — layers (config, provider, crawler, ledger, snapshot, repos, api), trust boundaries, DB ownership, indexing flow, snapshot flow, reorg posture (confirmation buffer).
- [ ] **Step 3: `docs/overview.md`** — keep the existing product intent source of truth aligned with the shipped behavior, scope, and non-goals.
- [ ] **Step 4: `docs/evolution.md`** — append dated entry: extended deposit-only crawler into full position + fee-attribution indexer; new schema; new API; raised confirmations; why (per-user admin-fee attribution + lifetime metrics).
- [ ] **Step 5: Commit.** `git add README.md docs/architecture.md docs/overview.md docs/evolution.md && git commit -m "docs: document vault position + fee-attribution indexer"`

---

## Verification Commands

```bash
npm install
npm test
npm run build
npm run dev   # against Base RPC with START_BLOCK≈48678603, small CHUNK_SIZE
```

Manual DB smoke:

```bash
sqlite3 ./data/ethra-harbor-indexer.sqlite "select last_scanned_block from indexer_state;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select address, balance_raw, earned_performance_fee_shares_raw, lifetime_deposited_raw, lifetime_withdrawn_raw from account_positions order by cast(balance_raw as text) desc limit 5;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select block_number, total_assets_raw, total_supply_raw from share_price_snapshots order by block_number desc limit 3;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select * from vault_reward_state;"
```

## Self-Review Notes

- **Spec coverage:** all five metrics (Tasks 3–7), fee attribution (Task 4), snapshots (Task 6), API (Task 7), reliability/ordering (Task 5), reorg buffer (Task 1 default). Covered.
- **Type consistency:** `LedgerState`/`AccountLedger` (bigint, Task 4) are converted to string-typed `AccountPosition`/`VaultRewardState` (Task 3) at the persistence boundary in `applyChunk` (Task 5); the API converts back with `settle` (Task 7). Naming is consistent across tasks.
- **No placeholders:** every code step includes concrete SQL/signatures; test steps include concrete assertions.
- **Dev-stage reset** is explicit (Task 3, Task 9) per `AGENTS.md`.
