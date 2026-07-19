# Architecture

Last updated: 2026-07-20

## Stack

- Runtime: Node.js with TypeScript and CommonJS output
- Chain client: `ethers`
- Database: SQLite via `better-sqlite3`
- HTTP API: built-in `node:http`
- Local dashboard: static HTML/CSS/JavaScript served by `node:http`
- Tests: `node:test` with `tsx`

This is a backend service with a bundled read-only local dashboard. It does not
include a separate frontend app, mobile, wallet UX, or user-profile systems.

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
   - Serves known static dashboard assets from `public/` at `/dashboard`.
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
  - The dashboard is static browser code. It calls the same read-only API routes
    and has no direct SQLite or RPC access.

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
4. If no safe range exists, the crawler publishes the latest safe head for API
   health and schedules the next loop based on `CRAWL_MODE`.
5. Otherwise it fetches one `getLogs` request for the four indexed event
   signatures from the configured vault address.
6. Each log is decoded and normalized, then events are sorted by
   `(block_number, transaction_index, log_index)`.
7. `applyChunk` persists raw rows, applies the in-memory ledger accumulator,
   upserts touched account rows and vault reward state, and advances the cursor
   to `toBlock` inside one SQLite transaction. After a successful chunk, the
   crawler publishes the tick result for API health.
8. If any step fails, the chunk is not partially committed. The short error
   text is recorded in `crawl_errors`, the structured log includes serialized
   error details, and the range is retried on a later loop.

Fresh databases seed `START_BLOCK` to `48578254`, so the first scanned block is
the deployment block `48578255`.

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
- `applyChunk` rejects duplicate `(chain_id, tx_hash, log_index)` identities
  both within the fetched chunk and against already-persisted raw event rows
  before any ledger mutation.

This keeps fee attribution replayable from chain logs without per-accrual
fanout writes.

## Snapshot Flow

1. `SharePriceSnapshotter` starts alongside the crawler.
2. On each interval (`SNAPSHOT_INTERVAL_MS`), it calls `readVaultTotals`.
3. The returned `blockNumber`, `totalAssetsRaw`, and `totalSupplyRaw` are
   inserted into `share_price_snapshots` with `captured_at`.
4. If a snapshot read fails, serialized error details are logged and the
   snapshotter retries on the same interval.

The latest stored snapshot is the newest observed head snapshot. API valuation
uses the newest snapshot whose `block_number` is less than or equal to the
persisted vault crawler cursor. Snapshots above the cursor remain stored but
pending until the crawler atomically processes their blocks and advances the
cursor.

After selecting the cursor-eligible base snapshot, API valuation replays already
processed vault-total-changing logs with `block_number > snapshot.block_number`
and `block_number <= lastProcessedLogBlock` into an in-memory adjusted snapshot.
The replay is ordered by `(block_number, transaction_index, log_index)` and uses:

- `AccrueInterest.newTotalAssets` to refresh total assets at lazy accrual
  points
- `Deposit.assets` and `Withdraw.assets` to apply vault asset inflows/outflows
- `Transfer` mints and burns to apply share supply changes, including lazy
  performance-fee share mints

This cursor gate plus processed-log adjustment applies to both account and vault
valuation. It guarantees that a valuation snapshot never runs ahead of indexed
logs, and that indexed fee-mint logs do not run ahead of valuation totals,
without coupling the snapshot and crawler timers. `currentBlock` reports the
newest observed snapshot block. `valuationBlock` reports the effective block of
the adjusted valuation, while `valuationTime` remains the local capture time of
the base snapshot.

Share value is computed as:

`shares * total_assets_raw / total_supply_raw`

with integer flooring, and zero when snapshot supply is zero.

Account and vault valuation helpers then combine the adjusted snapshot with
local indexed state to derive share values, crystallized earned performance
fee, gross generated yield, estimated net earned, estimated active deposit, and
estimated performance fee at read time. For account responses,
`activeDeposit.valueRaw` is principal still in the vault plus estimated
user-kept net earnings when the position is profitable; if the position is below
principal, it stays at the lower snapshot share value so losses remain visible.
`estimatedPerformanceFee.raw` is capped at `estimatedNetLifetimeEarned.raw` so
rounding at raw-unit precision never shows a fee larger than the user's
estimated net earned amount.
The APIs do not perform live chain reads during request handling.

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

- `GET /dashboard`
  - Serves the local HTML dashboard.
  - The dashboard loads `/dashboard/styles.css` and `/dashboard/app.js`, then
    calls `/health`, `/vault`, and `/accounts/:address` from the browser.
- `GET /health`
  - Returns process-readiness style metadata:
    `{ status, cursorBlock, safeHead, safeHeadKnown, syncedToSafeHead }`
  - `safeHead` is the latest crawler-observed `head - CONFIRMATIONS`; it is
    `null` until the crawler completes its first head read.
  - `syncedToSafeHead` is `true` when the persisted cursor is at or beyond that
    latest safe head.
- `GET /vault`
  - Returns indexed `totalSupplyRaw`, cursor-gated valuation
    `totalAssetsRaw`, share-price fields, cumulative performance-fee totals,
    newest observed block, processed crawler cursor, and valuation block
    freshness metadata
- `GET /accounts/:address`
  - Returns active deposit, lifetime deposit/withdraw totals, lifetime earned,
    earned performance fee, gross and estimated net earnings, estimated
    performance fee, and freshness metadata

API queries are read-only and intentionally avoid the mutating helpers that
create cursor or vault-state rows. Dashboard static file serving is constrained
to a fixed asset map and is not a general-purpose file server.

Account reads do not hit the chain. They derive estimated net earnings at read
time from local SQLite state plus the cursor-eligible valuation snapshot and the
latest fee mint block recorded in SQLite. `blockContext.currentBlock` remains
the newest observed snapshot block even when `valuationBlock` trails it.

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
