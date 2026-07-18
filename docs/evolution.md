# Evolution

## 2026-07-18

- Area: local API dashboard valuation display
- Changed: formatted `valuationTime` as Unix milliseconds in the dashboard and added a regression test for millisecond timestamps.
- Why: the API returns snapshot capture times in milliseconds, and the dashboard was multiplying them as seconds, producing impossible future years such as 58514.

## 2026-07-17

- Area: cursor-gated account and vault valuation
- Changed: account and vault API reads now value shares with the newest snapshot at or below the persisted vault crawler cursor, retain newer head snapshots as pending, and expose observed, processed, and valuation block freshness in the vault API and dashboard.
- Why: a head snapshot could previously observe post-fee-mint vault totals before the crawler processed the matching logs, causing a temporary estimated-net-earnings drop until the next crawl.

- Area: account earnings API semantics
- Changed: added gross lifetime earned, estimated net lifetime earned, estimated performance fee, and block freshness metadata to account metrics while preserving the existing mark-to-market `lifetimeEarned` field.
- Why: Morpho performance-fee shares mint lazily on vault interaction, so snapshot-only mark-to-market earned can temporarily overstate user-kept earnings until the next fee mint crystallizes the split.

- Area: local API dashboard earnings display
- Changed: updated the account lookup panel to show estimated net earned, gross generated yield, estimated performance fee, crystallized fee value, performance-fee rate, and block freshness from the account API.
- Why: operators need the dashboard to distinguish current net estimates from gross mark-to-market earnings and show how far the estimate is from the last realized fee mint.

- Area: vault DB read helpers
- Changed: added `readLastPerformanceFeeMintBlock(db, config)` to read the latest nonzero `AccrueInterest` block from `accrue_interest_events` for the active `(chain_id, contract_address)`, plus a partial SQLite index for the account-metrics lookup path and focused regression tests for vault isolation and the empty case.
- Why: the estimated net earnings read-model needs a fast active-vault query path for crystallized performance-fee lookups without changing indexed state.

- Area: local API dashboard
- Changed: added a static `/dashboard` page served by the existing HTTP API server, with health, vault, and address lookup panels backed by the read-only JSON routes.
- Why: operators need a quick browser view of indexed state without curl commands or a separate frontend stack.

- Area: API health reporting
- Changed: `/health` now returns the crawler's latest observed `safeHead`, keeps `safeHeadKnown` as a real runtime flag, and adds `syncedToSafeHead` when the persisted cursor has reached that safe head.
- Why: operators need health output to match crawler logs and show when the indexer is caught up to the confirmed chain head.

- Area: operational error logging
- Changed: serialized caught errors under an `error` metadata object for crawler chunk failures, share-price snapshot failures, and shutdown failures, while keeping `crawl_errors.message` as the human-readable failure text.
- Why: top-level log `message` is reserved for the event name, so exception text logged under metadata key `message` was being overwritten and operators could not see why a chunk failed.

## 2026-07-16

- Area: bootstrap wiring
- Changed: wired `src/index.ts` to build one shared Base provider client after migrations, start the vault crawler and share-price snapshotter, optionally bring up the HTTP API on `apiPort`, and drain crawler, snapshotter, API server, and DB during signal shutdown.
- Why: Task 8 connects the completed crawler, snapshotter, and API pieces into the actual backend startup path.

- Area: read-only HTTP API cursor reads
- Changed: split the API onto snapshot-only repository helpers for `/health`, `/vault`, and `/accounts/:address` so GET requests no longer create `indexer_state` or `vault_reward_state` rows on a fresh database.
- Why: ordinary reads must stay non-mutating, even before the crawler has seeded any vault state.

- Area: read-only HTTP API
- Changed: added a built-in `node:http` read API for `/health`, `/vault`, and `/accounts/:address`, plus query helpers that perform read-time fee settlement without persistence and return null valuation fields when no snapshot exists yet.
- Why: Task 7 exposes the indexed vault/account metrics over JSON without introducing bootstrap wiring or per-request RPC calls.

- Area: share-price snapshotting
- Changed: added a periodic share-price snapshotter, a vault-total read helper on the Base RPC client, and share valuation math that floors `shares * totalAssets / totalSupply` and returns zero when supply is empty.
- Why: the indexer now needs replayable vault share-price snapshots for USDC valuation and vault-level metrics.

- Area: vault event decoding
- Changed: expanded the Morpho Vault ABI to include `Withdraw`, `Transfer`, `AccrueInterest`, `totalAssets()`, and `totalSupply()`, and added a shared vault log decoder that normalizes deposit, withdraw, transfer, and accrue events.
- Why: the indexer is moving beyond deposit-only ingestion toward full vault position and fee attribution processing.

- Area: vault event decoding guardrails
- Changed: tightened `decodeVaultLog` to only accept logs from chain 8453 and the configured vault contract, and added test coverage for invalid addresses and checksum-normalized participant fields.
- Why: the decoder should only accept logs from the single configured Morpho Vault target and should prove address normalization on decoded event arguments.

- Area: vault DB reads and migration reset handling
- Changed: keyed `readVaultState` to the active vault config and added a regression check that `runMigrations` throws the explicit reset error when only `001_initial_schema` is present.
- Why: vault reward state must stay isolated per configured vault, and older local databases should fail fast instead of silently drifting onto the new schema.

- Area: ledger accumulator semantics
- Changed: made deposit and withdraw ledger handlers lifetime-only metadata updates, and moved all share supply changes to transfer mint/burn paths.
- Why: share balances and total supply should stay canonical to `Transfer` events while deposit and withdraw remain attribution metadata for lifetime assets.

- Area: full vault position and fee-attribution indexer documentation
- Changed: updated `README.md`, `docs/overview.md`, and new `docs/architecture.md` to document the shipped four-event crawler, atomic `applyChunk` flow, ledger accumulator, periodic share-price snapshotter, read-only API, strict config defaults (`START_BLOCK=48578254`, `CONFIRMATIONS=15`, `SNAPSHOT_INTERVAL_MS`, `API_*`), and the dev-stage SQLite reset path.
- Why: the backend now ships as a full position + fee-attribution indexer rather than a deposit-only crawler, and the project docs need to match the live schema, API surface, confirmation policy, and operational recovery model.

- Area: final review fixes for vault chunk safety and cursor seeding
- Changed: made `applyChunk` reject duplicate or already-persisted raw-log identities before ledger mutation, added deterministic snapshot tie-breakers, persisted deposit `sender` directly from decoded events, and changed the default `START_BLOCK` seed to `48578254` so the first scanned block remains the deployment block `48578255`.
- Why: the final review found replay and duplicate-log paths that could double-apply derived state, nondeterministic same-block snapshot reads, dropped deposit sender data, and a default cursor seed that skipped the deployment block on a fresh database.
