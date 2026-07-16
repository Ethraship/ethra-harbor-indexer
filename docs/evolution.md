# Evolution

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
- Changed: updated `README.md`, `docs/overview.md`, and new `docs/architecture.md` to document the shipped four-event crawler, atomic `applyChunk` flow, ledger accumulator, periodic share-price snapshotter, read-only API, strict config defaults (`START_BLOCK=48578255`, `CONFIRMATIONS=15`, `SNAPSHOT_INTERVAL_MS`, `API_*`), and the dev-stage SQLite reset path.
- Why: the backend now ships as a full position + fee-attribution indexer rather than a deposit-only crawler, and the project docs need to match the live schema, API surface, confirmation policy, and operational recovery model.

- Area: final review fixes for vault chunk safety and cursor seeding
- Changed: made `applyChunk` reject duplicate or already-persisted raw-log identities before ledger mutation, added deterministic snapshot tie-breakers, persisted deposit `sender` directly from decoded events, and changed the default `START_BLOCK` seed to `48578254` so the first scanned block remains the deployment block `48578255`.
- Why: the final review found replay and duplicate-log paths that could double-apply derived state, nondeterministic same-block snapshot reads, dropped deposit sender data, and a default cursor seed that skipped the deployment block on a fresh database.
