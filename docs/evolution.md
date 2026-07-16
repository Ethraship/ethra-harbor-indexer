# Evolution

## 2026-07-16

- Area: vault event decoding
- Changed: expanded the Morpho Vault ABI to include `Withdraw`, `Transfer`, `AccrueInterest`, `totalAssets()`, and `totalSupply()`, and added a shared vault log decoder that normalizes deposit, withdraw, transfer, and accrue events.
- Why: the indexer is moving beyond deposit-only ingestion toward full vault position and fee attribution processing.

- Area: vault event decoding guardrails
- Changed: tightened `decodeVaultLog` to only accept logs from chain 8453 and the configured vault contract, and added test coverage for invalid addresses and checksum-normalized participant fields.
- Why: the decoder should only accept logs from the single configured Morpho Vault target and should prove address normalization on decoded event arguments.
