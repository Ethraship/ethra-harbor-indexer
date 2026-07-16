# Architecture

Last updated: 2026-07-16

## Stack

- Runtime: Node.js with TypeScript and CommonJS output
- Chain client: `ethers`
- Database: SQLite via `better-sqlite3`
- HTTP API: built-in `node:http`
- Tests: `node:test` with `tsx`

This is a backend-only service. It does not include frontend, mobile, wallet
UX, or user-profile systems.

## Layers

1. `src/config.ts`
   - Parses and validates all environment variables.
   - Enforces Base-only chain id, strict integer settings, valid HTTP(S) RPC
     URLs, and a checksum-normalized vault address.
2. `src/provider/baseProvider.ts`
   - Builds ordered Base JSON-RPC providers from `BASE_RPC_URL` plus optional
     `RECONCILE_RPC_URLS`.
   - Exposes `getBlockNumber`, `getLogs`, and `readVaultTotals`.
3. `src/indexer/crawler.ts`
   - Reads the persisted cursor, computes a confirmation-buffered block range,
     fetches one four-topic OR log query, decodes events, sorts them, and calls
     `applyChunk`.
4. `src/indexer/ledger.ts`
   - Holds the in-memory accumulator and per-account ledger mutation rules.
   - Treats `Transfer` as the canonical balance source, and `Deposit` /
     `Withdraw` as lifetime-asset attribution only.
5. `src/db/`
   - Owns migrations, raw event persistence, derived-state reads/writes,
     cursor storage, and crawl error recording.
6. `src/snapshot/sharePrice.ts`
   - Periodically reads `totalAssets()` and `totalSupply()` from chain and
     stores `share_price_snapshots`.
7. `src/api/`
   - Serves read-only JSON responses for health, vault metrics, and per-address
     metrics without mutating database state.
8. `src/index.ts`
   - Bootstraps config, DB, provider, crawler, snapshotter, optional API
     server, and graceful shutdown wiring.

## Trust Boundaries

- Chain data boundary:
  - The service trusts Base JSON-RPC responses as its source of truth for logs,
    head height, and vault totals.
  - It reduces provider fragility with ordered fallback RPCs, but it does not
    merge or reconcile divergent provider answers.
- Persistence boundary:
  - SQLite is the durable source for cursor state, raw event history, derived
    ledger state, snapshots, and crawl errors.
  - API reads depend only on SQLite, never direct RPC calls.
- Process boundary:
  - The HTTP API is read-only. It does not write to DB, mutate cursors, or hit
    RPC on request paths.

## Database Ownership

The indexer owns a single local SQLite file, defaulting to
`./data/ethra-harbor-indexer.sqlite`.

Owned tables:

- `migrations`
- `indexer_state`
- `deposit_events`
- `withdraw_events`
- `transfer_events`
- `accrue_interest_events`
- `account_positions`
- `vault_reward_state`
- `share_price_snapshots`
- `crawl_errors`

`indexer_state` stores a vault-specific cursor id:

`base:vault:0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`

During this development stage, incompatible persisted-shape changes are handled
by deleting the SQLite file and re-crawling from `START_BLOCK`. `runMigrations`
already throws an explicit reset-required error when it sees the old
deposit-only schema without the vault-position migration.

## RPC Provider Behavior

- `BASE_RPC_URL` is always first in the provider list.
- `RECONCILE_RPC_URLS` entries are trimmed, validated as HTTP(S), and appended
  in order.
- For `getBlockNumber`, `getLogs`, and `readVaultTotals`, the provider client
  tries each configured RPC sequentially until one succeeds, then throws the
  last error if all fail.
- Snapshot reads fetch `totalAssets()` and `totalSupply()` at the same observed
  block number from one provider attempt.

There are no WebSocket subscriptions, mempool listeners, or hidden network
fallbacks.

## Indexing Flow

1. Bootstrap opens SQLite, runs migrations, creates one shared provider client,
   and starts the crawler.
2. The crawler reads or creates the vault cursor from `indexer_state`.
3. It reads the current head and computes:
   - `safeHead = head - CONFIRMATIONS`
   - `fromBlock = cursor + 1`
   - `toBlock = min(safeHead, fromBlock + CHUNK_SIZE - 1)`
4. If no safe range exists, the crawler schedules the next loop based on
   `CRAWL_MODE`.
5. Otherwise it fetches one `getLogs` request for the four indexed event
   signatures from the configured vault address.
6. Each log is decoded and normalized, then events are sorted by
   `(block_number, transaction_index, log_index)`.
7. `applyChunk` persists raw rows, applies the in-memory ledger accumulator,
   upserts touched account rows and vault reward state, and advances the cursor
   to `toBlock` inside one SQLite transaction.
8. If any step fails, the chunk is not partially committed. The error is
   recorded in `crawl_errors`, and the range is retried on a later loop.

## Accumulator And Ledger Semantics

Global vault state:

- `global_performance_fee_index_raw`
- `total_supply_raw`
- `cumulative_performance_fee_shares_raw`
- `cumulative_management_fee_shares_raw`

Per-address state:

- `balance_raw`
- `reward_debt_raw`
- `earned_performance_fee_shares_raw`
- `lifetime_deposited_raw`
- `lifetime_withdrawn_raw`

Semantics:

- `Transfer` mints/burns/updates share balances and total supply.
- `Deposit` increments lifetime deposited for `onBehalf`.
- `Withdraw` increments lifetime withdrawn for `onBehalf`.
- `AccrueInterest` adds performance-fee shares to the cumulative state and
  advances the global fee-per-share index using the pre-mint supply.

This keeps fee attribution replayable from chain logs without per-accrual
fanout writes.

## Snapshot Flow

1. `SharePriceSnapshotter` starts alongside the crawler.
2. On each interval (`SNAPSHOT_INTERVAL_MS`), it calls `readVaultTotals`.
3. The returned `blockNumber`, `totalAssetsRaw`, and `totalSupplyRaw` are
   inserted into `share_price_snapshots` with `captured_at`.
4. If a snapshot read fails, the error is logged and the snapshotter retries on
   the same interval.

Valuation uses the latest stored snapshot only. Share value is computed as:

`shares * total_assets_raw / total_supply_raw`

with integer flooring, and zero when snapshot supply is zero.

## Scheduler Behavior

The crawler is timer-driven:

- `CRAWL_MODE=fast` always waits `FAST_POLL_MS`
- `CRAWL_MODE=slow` always waits `SLOW_POLL_MS`
- `CRAWL_MODE=auto` waits `FAST_POLL_MS` while there is more safe history to
  catch up, otherwise `SLOW_POLL_MS`

The snapshotter has its own independent timer using `SNAPSHOT_INTERVAL_MS`.

## API

The API is optional (`API_ENABLED`) and listens on `API_PORT` when enabled.

Endpoints:

- `GET /health`
  - Returns process-readiness style metadata: `{ status, cursorBlock, safeHeadKnown }`
- `GET /vault`
  - Returns indexed `totalSupplyRaw`, latest snapshot `totalAssetsRaw`,
    share-price fields, and cumulative performance-fee totals
- `GET /accounts/:address`
  - Returns active deposit, lifetime deposit/withdraw totals, lifetime earned,
    earned performance fee, and valuation metadata

API queries are read-only and intentionally avoid the mutating helpers that
create cursor or vault-state rows.

## Reorg Posture

The current reorg strategy is confirmation-buffer-only:

- Default `CONFIRMATIONS` is `15`
- Raw event tables store `block_hash`
- The crawler processes only blocks up to `head - confirmations`

Full block-hash rollback is not implemented yet. If a reorg deeper than the
confirmation buffer occurs, the operational recovery path is to delete the
SQLite file and re-crawl from `START_BLOCK`.

## Operational Assumptions

- Base mainnet is the only supported chain.
- Wallet address is the only identity.
- Raw and derived values that represent on-chain integers are stored as strings
  at the persistence boundary and converted to `bigint` in memory.
- API responses may have `null` valuation fields until the first snapshot is
  captured.
- The service expects a reliable HTTP RPC with archive access for historical
  backfill.
