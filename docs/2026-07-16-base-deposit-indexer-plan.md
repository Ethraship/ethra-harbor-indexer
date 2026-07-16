# Base Deposit Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Node.js indexer in `ethra-harbor-indexer` that crawls Base mainnet HTTP RPC logs for the deposit event on `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` and persists progress plus decoded deposits in SQLite.

**Architecture:** Keep the reliable parts of `cifer-blackbox/app/src/utils/eventIngestion.ts`: confirmed-block reconciliation, fixed block chunks, persisted cursor, deterministic log sorting, and a fast loop while catching up. Remove multi-chain support, WebSocket subscriptions, live socket health, Express routing, enclave/orchestrator dependencies, and CIFER-specific behavior.

**Tech Stack:** Node.js 20+, TypeScript, `ethers` v6, `better-sqlite3`, built-in `node:test`, SQLite WAL mode.

## Global Constraints

- Chain support is Base mainnet only, chain ID `8453`.
- RPC access is HTTP JSON-RPC only; no WSS providers, socket subscriptions, or live listeners.
- Contract address is fixed by default to `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`, with an env override only for local testing.
- Database is SQLite using `better-sqlite3`, following the same migration style as `cifer-blackbox/app/src/utils/db.ts`.
- First indexed event is the deposit event only.
- Event handling is storage-only for now: decode, normalize, persist, and update cursor. No downstream business processing.
- Slow and fast crawl modes are required.
- Cursor advances only after every log in a chunk is processed inside a successful database transaction.
- Re-runs must be idempotent using `(chain_id, tx_hash, log_index)` uniqueness.
- Contract ABI and deployment start block must be verified from the deployed Base contract before implementation. If the explorer is unavailable, use the locally referenced pool event as the initial ABI and keep `START_BLOCK` configurable.

---

## Context From Blackbox

The blackbox crawler model lives mainly in `cifer-blackbox/app/src/utils/eventIngestion.ts`.

Useful behavior to carry over:

- `safeHead = head - confirmations` before indexing.
- `fromBlock = cursor + 1`.
- `toBlock = min(safeHead, fromBlock + reconcileChunkSize - 1)`.
- `getLogs` over HTTP RPC, with optional fallback RPC URLs.
- Sort logs by `blockNumber`, `transactionIndex`, then `logIndex`.
- Process all logs, then persist cursor.
- Return `moreToProcess` so the next loop can run quickly during backfill.

Behavior to remove:

- `MultiChainClient`.
- WebSocket providers, live subscriptions, and WSS health restarts.
- Cluster registry and blackbox discovery events.
- Secret orchestrator calls.
- Secure file cursor storage; this indexer should keep cursor state in SQLite.

## Deposit Event Assumption

The local payment client references this pool-style event:

```ts
event Deposit(
  uint256 indexed commitment,
  uint32 leafIndex,
  address indexed token,
  uint256 amount,
  bytes encryptedClaim,
  uint256 timestamp
)
```

Implementation should verify this against the deployed contract at the Base address before writing the ABI file. If the deployed contract instead uses `Deposited(bytes32 indexed commitment,address indexed token,uint256 amount,bytes encryptedClaim,uint256 timestamp)`, implement that exact event name/signature instead and keep the same database fields where possible.

## Approach Options

### Recommended: Small TypeScript Indexer With SQLite Cursor

Create a focused TypeScript service with modules for config, DB migrations, provider access, ABI parsing, and the crawl loop.

Pros:

- Closest to blackbox reliability without copying its unrelated dependencies.
- Easy to test with mocked providers and in-memory SQLite.
- Keeps future event additions simple.

Cons:

- Requires a small project scaffold before useful runtime behavior exists.

### Alternative: Plain JavaScript Single-File Crawler

Build one `index.js` with config, schema, crawling, and parsing in one file.

Pros:

- Fastest first implementation.
- Minimal tooling.

Cons:

- Harder to test and easier to let crawler state, decoding, and DB writes tangle together.
- Poor fit for adding more events later.

### Alternative: Ponder/Subgraph-Style Framework

Use an indexing framework and model the Deposit event declaratively.

Pros:

- Lots of indexing concerns are solved already.

Cons:

- Adds framework complexity that is unnecessary for one chain, one contract, HTTP polling, and SQLite.
- Less similar to the blackbox crawler the user explicitly trusts.

Decision: use the recommended small TypeScript indexer.

## Runtime Design

The process starts from `src/index.ts`, loads config, initializes SQLite, creates an `ethers.JsonRpcProvider`, initializes the crawler cursor, and enters an async timer loop.

Default mode is `auto`:

- If `safeHead > toBlock`, the crawler is catching up and schedules the next loop after `FAST_POLL_MS`.
- If no work remains, it schedules after `SLOW_POLL_MS`.

Explicit modes:

- `CRAWL_MODE=fast`: always use `FAST_POLL_MS` between loops.
- `CRAWL_MODE=slow`: always use `SLOW_POLL_MS` between loops.
- `CRAWL_MODE=auto`: use fast while catching up and slow at the tip.

Default config values:

```env
BASE_CHAIN_ID=8453
BASE_RPC_URL=https://base-rpc.publicnode.com
BASE_CONTRACT_ADDRESS=0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d
DATABASE_PATH=./data/ethra-harbor-indexer.sqlite
START_BLOCK=0
CONFIRMATIONS=2
CHUNK_SIZE=1000
BASE_BLOCK_TIME_MS=2000
FAST_POLL_MS=2000
SLOW_POLL_MS=50000
CRAWL_MODE=auto
RECONCILE_RPC_URLS=
LOG_LEVEL=info
```

`START_BLOCK=0` is a safe default but inefficient. Before production use, set it to the deployment block or first deposit block for the Base contract.

## Database Design

Use `better-sqlite3`, enable WAL, and run migrations at boot.

Tables:

```sql
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_state (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  last_scanned_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deposit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  commitment TEXT NOT NULL,
  leaf_index INTEGER,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  encrypted_claim TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  raw_log_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_deposit_events_block ON deposit_events(block_number);
CREATE INDEX IF NOT EXISTS idx_deposit_events_commitment ON deposit_events(commitment);
CREATE INDEX IF NOT EXISTS idx_deposit_events_token ON deposit_events(token);

CREATE TABLE IF NOT EXISTS crawl_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Cursor row:

- `id = 'base:deposit:0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d'`
- `last_scanned_block = START_BLOCK` on first boot.

## File Structure

- Create: `package.json` with `dev`, `build`, `start`, `test`, `lint`, and `format` scripts.
- Create: `tsconfig.json` for Node 20 CommonJS or NodeNext output.
- Create: `.env.example` with all supported env vars.
- Create: `src/index.ts` for bootstrap and graceful shutdown.
- Create: `src/config.ts` for env parsing and validation.
- Create: `src/logger.ts` for compact structured logs.
- Create: `src/abi/privacyPool.ts` for the verified minimal ABI.
- Create: `src/db/index.ts` for database lifecycle and migrations.
- Create: `src/db/deposits.ts` for prepared statements that upsert deposit events and cursor state.
- Create: `src/provider/baseProvider.ts` for the main HTTP provider and fallback `getLogs` behavior.
- Create: `src/indexer/depositParser.ts` for decoding deposit logs.
- Create: `src/indexer/blockRange.ts` for safe-head and chunk range calculation.
- Create: `src/indexer/crawler.ts` for the reconciliation loop.
- Create: `test/*.test.ts` for config, DB, parser, block range, and crawler behavior.
- Modify: `README.md` with quickstart, config, and operational notes.
- Keep: `docs/2026-07-16-base-deposit-indexer-plan.md` as the implementation reference.

## Implementation Tasks

### Task 1: Project Scaffold

Files:

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Modify: `README.md`

Steps:

- [ ] Add Node/TypeScript scripts: `dev` uses `tsx src/index.ts`, `build` uses `tsc`, `start` uses `node dist/index.js`, `test` uses `node --import tsx --test test/**/*.test.ts`.
- [ ] Add dependencies: `better-sqlite3`, `ethers`, `dotenv`.
- [ ] Add dev dependencies: `@types/better-sqlite3`, `@types/node`, `tsx`, `typescript`.
- [ ] Document quickstart with `cp .env.example .env`, `npm install`, `npm run dev`.
- [ ] Verify `npm run build` succeeds after placeholder bootstrap.

### Task 2: Config And Logging

Files:

- Create: `src/config.ts`
- Create: `src/logger.ts`
- Test: `test/config.test.ts`

Steps:

- [ ] Parse environment variables into typed config.
- [ ] Normalize `BASE_CONTRACT_ADDRESS` with `ethers.getAddress`.
- [ ] Reject invalid `CRAWL_MODE` values outside `auto`, `fast`, and `slow`.
- [ ] Reject numeric settings below safe minimums: `CONFIRMATIONS >= 0`, `CHUNK_SIZE >= 1`, `FAST_POLL_MS >= 250`, `SLOW_POLL_MS >= 1000`.
- [ ] Split `RECONCILE_RPC_URLS` on commas, trim blanks, and append after `BASE_RPC_URL`.
- [ ] Add tests for defaults, invalid mode, invalid address, and fallback RPC parsing.

### Task 3: SQLite Migrations And Repositories

Files:

- Create: `src/db/index.ts`
- Create: `src/db/deposits.ts`
- Test: `test/db.test.ts`

Steps:

- [ ] Open the SQLite database path, creating parent directories.
- [ ] Enable `journal_mode = WAL`.
- [ ] Apply the migration SQL from this plan.
- [ ] Implement `getOrCreateCursor(db, config): number`.
- [ ] Implement `saveDepositsAndCursor(db, deposits, toBlock): void` as one transaction.
- [ ] Insert deposit events with `INSERT OR IGNORE` on `(chain_id, tx_hash, log_index)`.
- [ ] Add tests for migration creation, initial cursor, idempotent insert, and transactional cursor advancement.

### Task 4: ABI And Deposit Parser

Files:

- Create: `src/abi/privacyPool.ts`
- Create: `src/indexer/depositParser.ts`
- Test: `test/depositParser.test.ts`

Steps:

- [ ] Verify the deployed Base contract ABI, then define the minimal ABI for the exact deposit event.
- [ ] Implement `parseDepositLog(log, iface, config)` returning normalized strings for bigint values.
- [ ] Store `commitment` as a hex string when the ABI returns a uint256.
- [ ] Store `amount` and `event_timestamp` as decimal strings.
- [ ] Store `encrypted_claim` as a hex string.
- [ ] Add a fixture log generated with `ethers.Interface.encodeEventLog` and assert parsed fields exactly.

### Task 5: Provider And Block Ranges

Files:

- Create: `src/provider/baseProvider.ts`
- Create: `src/indexer/blockRange.ts`
- Test: `test/blockRange.test.ts`

Steps:

- [ ] Create one `ethers.JsonRpcProvider` per configured HTTP RPC URL with Base chain ID `8453`.
- [ ] Implement fallback `getLogs(filter)` that tries RPC URLs in order and records the last error.
- [ ] Implement `calculateRange(cursor, head, confirmations, chunkSize)` returning `null` when no safe work exists.
- [ ] Add tests for no-work, one-block, chunk-capped, and confirmation-delayed ranges.

### Task 6: Reconciliation Crawler

Files:

- Create: `src/indexer/crawler.ts`
- Modify: `src/index.ts`
- Test: `test/crawler.test.ts`

Steps:

- [ ] Bootstrap config, DB, ABI interface, provider, and crawler.
- [ ] Fetch current head with `provider.getBlockNumber()`.
- [ ] Calculate safe chunk range from cursor.
- [ ] Fetch deposit logs for the contract address and deposit topic only.
- [ ] Sort logs by `blockNumber`, `transactionIndex`, and `index`.
- [ ] Decode logs and persist events plus cursor in one transaction.
- [ ] Schedule next loop using `CRAWL_MODE`.
- [ ] Capture chunk failures in `crawl_errors` and retry the same cursor on the next loop.
- [ ] Add graceful shutdown for `SIGINT` and `SIGTERM` that clears the pending timer and closes SQLite.
- [ ] Add a mocked-provider crawler test that processes two chunks, switches from fast to slow in `auto` mode, and does not double-insert repeated logs.

### Task 7: Operational Documentation

Files:

- Modify: `README.md`

Steps:

- [ ] Explain that this is independent from CIFER and only borrows the blackbox crawl pattern.
- [ ] Document Base-only assumptions.
- [ ] Document each env var and recommended production values.
- [ ] Document how to reset or override the cursor safely.
- [ ] Document how to inspect SQLite rows with `sqlite3`.
- [ ] Document that future events should get their own parser/repository tests before being added to the crawler filter.

## Verification Commands

Run after implementation:

```bash
npm install
npm test
npm run build
npm run dev
```

Manual smoke test:

```bash
sqlite3 ./data/ethra-harbor-indexer.sqlite "select last_scanned_block from indexer_state;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select count(*) from deposit_events;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select block_number, tx_hash, commitment, leaf_index, token, amount from deposit_events order by block_number desc limit 5;"
```

Use a small test window first by setting `START_BLOCK` near the contract deployment block and `CHUNK_SIZE=100`.

## Open Implementation Checks

- Confirm the deployed contract ABI/event signature from Basescan or another reliable Base explorer before creating `src/abi/privacyPool.ts`.
- Confirm the contract deployment block or earliest deposit block and set `START_BLOCK` in `.env.example` if it is stable.
- Decide whether production should use a paid/archive Base RPC for historical `getLogs` backfill. The code should support fallback URLs either way.

