# Evolution

## 2026-07-16

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
