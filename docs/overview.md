# Ethra Harbor Indexer Overview

Last updated: 2026-08-13

## Product Intent

Ethra Harbor Indexer is a Node.js backend indexer for a single Base Morpho
Vault V2:

`0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`

Its job is to crawl deterministic on-chain vault events over HTTP JSON-RPC,
persist replayable SQLite state, periodically snapshot vault valuation, and
expose wallet and vault metrics. Wallet address is the only identity. Public
HTTP reads are read-only; when `ADMIN_API_TOKEN` is configured, authenticated
operator routes can update local boost accounting. Boost-change and settlement
history GETs stay public. The HTTP server also serves a small local dashboard
and a local admin page for those operator controls.

## Current Scope

The shipped backend is a stateful position and performance-fee-attribution
indexer. It processes four vault events:

- `Deposit`
- `Withdraw`
- `Transfer`
- `AccrueInterest`

For each wallet address, the backend answers:

- active vault share balance and estimated net USDC value
- lifetime USDC deposited
- lifetime USDC withdrawn
- approximate lifetime earned, labeled as analytics
- performance-fee shares attributable to that wallet's position and USDC value
- estimated net earnings and estimated performance fee at the current
  single-vault rate
- freshness metadata for the latest snapshot, crawler cursor, and fee mint
- additive base, wallet, and total boost basis points
- crystallized and pending vSHIP amounts, fee watermark, and fixed vSHIP price

Vault-level reads expose total supply, latest share-price snapshot, share price,
and cumulative performance-fee shares and value.

The bundled dashboard shows API health, vault metrics, and one wallet lookup by
calling the same read-only JSON routes from the browser. The bundled overview
page at `/overview` shows director-facing vault totals, selectable 7/30/90-day
charts, and the top 100 wallets (full addresses) from `GET /overview/stats`. The
bundled admin page can change base or wallet boosts with an API key and can load
history without one.

## System Shape

This project is a backend service with a bundled static local dashboard. It uses
TypeScript, CommonJS, `ethers`, `better-sqlite3`, `node:test`, HTTP RPC crawling,
SQLite persistence, structured logs, static HTML/CSS/JavaScript, and explicit
environment configuration.

It does not include a separate frontend app, mobile, wallet UX, identity
aggregation across multiple wallets, WebSocket subscriptions, or user-profile
logic. vSHIP accounting is indexer-owned local accounting; it does not mint an
on-chain token or submit chain transactions.

## Non-Goals

- No multi-wallet identity mapping or external account system
- No unauthenticated write API; optional authenticated boost PUTs exist only
  when `ADMIN_API_TOKEN` is configured
- No Morpho vault move or migration
- No on-chain boost or reward transactions
- No admin vSHIP price API; the seeded price remains `$0.05`
- No real-time push transport; polling and snapshots only
- No management-fee attribution beyond tracking vault-level cumulative totals
- No full automatic deep-reorg rollback in v1

## Operational Assumptions

The indexer processes Base mainnet logs in deterministic
`(block_number, transaction_index, log_index)` order. Chunk application is
atomic: raw event inserts, derived state updates, and cursor advancement happen
inside one SQLite transaction. Reorg safety in this development stage is a
confirmation buffer, with block hashes stored for future rollback support.
Fresh databases seed `START_BLOCK` to `48578254` so the first scanned block is
the vault deployment block `48578255`.

The SQLite schema may be reset during early development because there is no
real user data yet. If shared, remote, production, or user-owned data appears,
the reset assumption no longer applies.

## vSHIP Boost Cutover

The reward schema adds `reward_config`, `wallet_boost`, `wallet_vship_state`,
`boost_change_events`, and `vship_settlement_events`; existing USDC event and
vault-reward tables remain unchanged. The default base boost is `40000` bps
(4x), the per-wallet boost is additive, and missing wallet rows contribute
zero. vSHIP uses a fixed `$0.05` price (`50000` raw, 6 decimals).

Boost changes soft-crystallize estimated performance-fee deltas at the old
boost, use a sticky fee watermark so dips never mint negatively, and commit
settlement, boost state, and audit writes in one SQLite transaction. Base changes
settle all eligible wallets; wallet changes settle one wallet. A zero fee delta
does not create a settlement history row, and an identical boost is a no-op.

This cutover is nuke-and-reindex only: delete the local SQLite database and
reindex from `START_BLOCK`. There is no genesis reward backfill. Admin mutation
routes require a known safe head, cursor synchronization to that head, a usable
valuation snapshot, and fee-mint freshness. Having no recorded nonzero
performance-fee mint is allowed; when one exists, mutations are rejected only
if it is at least the configured threshold behind the freshest local block.
Failed gates return `409`.
