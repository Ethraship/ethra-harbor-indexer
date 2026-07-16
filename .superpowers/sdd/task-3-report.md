# Task 3 Report: DB Migration And Repositories

## What you implemented

- Added `002_vault_position_indexer` to [src/db/index.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/index.ts) with the required new tables:
  - `withdraw_events`
  - `transfer_events`
  - `accrue_interest_events`
  - `account_positions`
  - `vault_reward_state`
  - `share_price_snapshots`
- Updated migration handling to apply both schema versions on fresh/reset databases and to fail fast with an explicit reset error if an older local DB already has `001_initial_schema` without the new vault migration.
- Added [src/db/vault.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/vault.ts) with pure repository primitives only:
  - `getOrCreateVaultCursor`
  - `readVaultState`
  - `readAccountPosition`
  - `insertSnapshot`
  - `readLatestSnapshot`
  - `insertWithdrawEvent`
  - `insertTransferEvent`
  - `insertAccrueInterestEvent`
  - `upsertVaultState`
  - `upsertAccountPosition`
- Re-exported vault DB helpers from [src/db/index.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/index.ts).
- Added focused vault DB coverage in [test/vaultDb.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/vaultDb.test.ts).
- Updated [test/db.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/db.test.ts) so the pre-existing schema smoke test matches the new Task 3 schema and allows `npm test` to pass.

## What you tested and test results

- `node --import tsx --test test/vaultDb.test.ts`
  - First run failed as expected before implementation.
  - Second run passed: `3` tests passed, `0` failed.
- `npm test`
  - First run exposed one stale schema expectation in `test/db.test.ts`.
  - Second run passed after the narrow test update: `48` tests passed, `0` failed.

## TDD Evidence

### RED command + relevant failing output

Command:

```bash
node --import tsx --test test/vaultDb.test.ts
```

Relevant failing output:

```text
not ok 1 - runMigrations creates the vault schema without changing deposit_events
Expected values to be strictly deep-equal:
+ actual - expected
[
- 'account_positions',
- 'accrue_interest_events',
  'crawl_errors',
  'deposit_events',
  'indexer_state',
  'migrations',
- 'share_price_snapshots',
  'sqlite_sequence',
- 'transfer_events',
- 'vault_reward_state',
- 'withdraw_events'
]

not ok 2 - getOrCreateVaultCursor seeds START_BLOCK and vault reads return zero defaults
Expected values to be strictly equal:
+ actual - expected
+ 'undefined'
- 'function'

not ok 3 - readLatestSnapshot returns null when empty and the highest block snapshot after inserts
Expected values to be strictly equal:
+ actual - expected
+ 'undefined'
- 'function'
```

### GREEN command + relevant passing output

Command:

```bash
node --import tsx --test test/vaultDb.test.ts
```

Relevant passing output:

```text
ok 1 - runMigrations creates the vault schema without changing deposit_events
ok 2 - getOrCreateVaultCursor seeds START_BLOCK and vault reads return zero defaults
ok 3 - readLatestSnapshot returns null when empty and the highest block snapshot after inserts
1..3
# tests 3
# pass 3
# fail 0
```

## Files changed

- [src/db/index.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/index.ts)
- [src/db/vault.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/vault.ts)
- [test/vaultDb.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/vaultDb.test.ts)
- [test/db.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/db.test.ts)

## Self-review findings

- Scope stayed inside schema and repository primitives; `applyChunk` and any accumulator logic were not implemented.
- All blockchain-sized values added in this task are persisted as decimal strings.
- The reset requirement is explicit: an existing local DB on migration `001_initial_schema` now raises a clear error instead of silently mutating older state.
- `readVaultState` and `readAccountPosition` return zero defaults when no row exists, matching the task brief and focused tests.

## Any issues or concerns

- The task brief named only `test/vaultDb.test.ts`, but `npm test` also required a small update to `test/db.test.ts` because its old schema expectation conflicted with Task 3’s new migration.
- I did not modify crawler behavior.

## Fix section

### What I fixed

- Changed `readVaultState` in [src/db/vault.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/vault.ts) to accept `config: AppConfig` and read the active vault row via `vaultCursorId(config)` instead of falling back to the first `base:vault:*` row.
- Added a regression test in [test/vaultDb.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/vaultDb.test.ts) that seeds two vault configs and confirms each one reads back its own persisted reward state.
- Added a regression test in [test/vaultDb.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/vaultDb.test.ts) that seeds `migrations` with only `001_initial_schema` and verifies `runMigrations` throws the explicit reset error instead of applying `002_vault_position_indexer`.

### Commands run and results

- `node --import tsx --test test/vaultDb.test.ts`
  - Passed: `5` tests passed, `0` failed.
- `npm test`
  - Passed: `50` tests passed, `0` failed.

### Files changed

- [src/db/vault.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/src/db/vault.ts)
- [test/vaultDb.test.ts](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/test/vaultDb.test.ts)
- [.superpowers/sdd/task-3-report.md](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/.superpowers/sdd/task-3-report.md)
- [docs/evolution.md](/Users/mohsinriaz/Mohsin/Development/Ethra/ethra-harbor-indexer/docs/evolution.md)

### Concerns

- None.
