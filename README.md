# ethra-harbor-indexer

Ethra Harbor Indexer is a standalone Base mainnet deposit indexer for the verified Morpho Vault V2-style contract at `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`.

It is independent from CIFER and only borrows the blackbox HTTP reconciliation pattern. There are no websockets, sockets, live listeners, or multi-chain code paths.

## What It Does

- Crawls `Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares)` logs from the Base contract.
- Decodes and stores `sender`, `on_behalf`, `assets`, and `shares` in SQLite.
- Advances a per-contract cursor in `indexer_state.last_scanned_block`.
- Reconciles through HTTP RPC endpoints only, with optional fallback URLs.

## Quickstart

```bash
cp .env.example .env
npm install
npm run dev
```

For production-style runs:

```bash
npm run build
npm start
```

## Environment

| Variable | Purpose | Default | Production note |
| --- | --- | --- | --- |
| `BASE_CHAIN_ID` | Base chain guard. | `8453` | Must stay `8453`. |
| `BASE_RPC_URL` | Primary Base HTTP(S) RPC used for heads and log backfill. | `https://base-rpc.publicnode.com` | Use a reliable Base RPC, preferably one with historical archive access for the initial backfill. |
| `BASE_CONTRACT_ADDRESS` | Morpho Vault contract to index. | `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` | Production stays fixed at this verified contract; override only for local testing. |
| `DATABASE_PATH` | SQLite file path. | `./data/ethra-harbor-indexer.sqlite` | Put this on persistent storage. |
| `START_BLOCK` | First cursor value when the cursor row is created. | `0` | Use `48578255` for full contract history or `48678603` for deposit-only catch-up. |
| `CONFIRMATIONS` | Blocks to wait before scanning. | `2` | Keep a small nonzero buffer on Base. |
| `CHUNK_SIZE` | Logs per crawl window. | `1000` | Lower it for smoke tests or constrained RPCs. |
| `BASE_BLOCK_TIME_MS` | Configured Base block-time estimate. | `2000` | Currently loaded from config; keep it at the expected Base cadence value. |
| `FAST_POLL_MS` | Delay when the crawler still has more work. | `2000` | Keep short for catch-up runs. |
| `SLOW_POLL_MS` | Delay when the crawler is caught up. | `50000` | Use a longer idle delay for steady-state runs. |
| `CRAWL_MODE` | Scheduler mode: `auto`, `fast`, or `slow`. | `auto` | `auto` is the normal production choice. |
| `RECONCILE_RPC_URLS` | Comma-separated fallback HTTP(S) RPC URLs. | empty | Leave blank if you only want the primary RPC, or add archive fallbacks after it. |
| `LOG_LEVEL` | Console log level. | `info` | Use `info` in production, `debug` only during local troubleshooting. |

The crawler always uses the primary `BASE_RPC_URL` first. If `RECONCILE_RPC_URLS` is set, its trimmed HTTP(S) entries are appended in order.

## Cursor And Reset

The cursor is stored in SQLite in `indexer_state` under the ID `base:deposit:0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`.

`START_BLOCK` only matters when that cursor row is created. If the database already has a cursor, changing the env var will not move it.

To inspect or safely override the cursor:

1. Stop the process.
2. Back up the SQLite file.
3. Inspect the current row.
4. Update the cursor to the new block, or delete the row if you want the app to recreate it on the next start.

```bash
sqlite3 ./data/ethra-harbor-indexer.sqlite "select last_scanned_block from indexer_state;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "update indexer_state set last_scanned_block = 48578254 where id = 'base:deposit:0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d';"
```

To restart from a clean slate, remove the database file after backing it up.

## Inspecting Data

Use `sqlite3` to inspect the stored deposits and crawl state:

```bash
sqlite3 ./data/ethra-harbor-indexer.sqlite "select last_scanned_block from indexer_state;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select count(*) from deposit_events;"
sqlite3 ./data/ethra-harbor-indexer.sqlite "select block_number, tx_hash, sender, on_behalf, assets, shares from deposit_events order by block_number desc limit 5;"
```

## Extending The Indexer

This crawler currently filters only the Morpho Vault `Deposit` event. If a future event is added, give it its own parser and repository tests before adding it to the crawler filter.

## Scripts

- `npm run dev` runs the TypeScript entry point with `tsx`
- `npm run build` compiles `src/index.ts` with `tsc`
- `npm start` runs the compiled entry point from `dist/index.js`
- `npm test` runs Node's built-in test runner with `tsx`
