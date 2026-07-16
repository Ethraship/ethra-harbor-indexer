# Evolution

## 2026-07-16

- Area: vault event decoding
- Changed: expanded the Morpho Vault ABI to include `Withdraw`, `Transfer`, `AccrueInterest`, `totalAssets()`, and `totalSupply()`, and added a shared vault log decoder that normalizes deposit, withdraw, transfer, and accrue events.
- Why: the indexer is moving beyond deposit-only ingestion toward full vault position and fee attribution processing.
