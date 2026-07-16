# Ethra Harbor Indexer Overview

Last updated: 2026-07-16

## Product Intent

Ethra Harbor Indexer is a Node.js backend indexer for a single Base Morpho
Vault V2:

`0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`

Its job is to crawl deterministic on-chain vault events over HTTP JSON-RPC,
persist replayable SQLite state, periodically snapshot vault valuation, and
expose read-only wallet and vault metrics. Wallet address is the only identity.

## Current Scope

The shipped backend is a stateful position and performance-fee-attribution
indexer. It processes four vault events:

- `Deposit`
- `Withdraw`
- `Transfer`
- `AccrueInterest`

For each wallet address, the backend answers:

- active vault share balance and USDC value
- lifetime USDC deposited
- lifetime USDC withdrawn
- approximate lifetime earned, labeled as analytics
- performance-fee shares attributable to that wallet's position and USDC value

Vault-level reads expose total supply, latest share-price snapshot, share price,
and cumulative performance-fee shares and value.

## System Shape

This project is a backend service only. It uses TypeScript, CommonJS, `ethers`,
`better-sqlite3`, `node:test`, HTTP RPC crawling, SQLite persistence, structured
logs, and explicit environment configuration.

It does not include frontend, mobile, wallet UX, identity aggregation across
multiple wallets, reward minting, WebSocket subscriptions, or user-profile
logic.

## Non-Goals

- No multi-wallet identity mapping or external account system
- No write API, admin panel, or operator console
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
