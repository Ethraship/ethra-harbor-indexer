# ethra-harbor-indexer

Ethra Harbor Indexer is a standalone Base mainnet backend for the verified
Morpho Vault V2-style contract at
`0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`.

It crawls deterministic on-chain vault activity over HTTP JSON-RPC, stores
replayable SQLite state, periodically snapshots vault valuation, and exposes a
read-only HTTP API keyed only by wallet address. The same server also ships a
small local dashboard for inspecting those read-only routes in a browser.

## What It Indexes

Each crawl chunk fetches and processes these four vault events in strict
`(block_number, transaction_index, log_index)` order:

- `Deposit`
- `Withdraw`
- `Transfer`
- `AccrueInterest`

The indexer uses them with distinct roles:

- `Transfer` is the canonical source of share balances and total supply.
- `Deposit` and `Withdraw` update lifetime USDC attribution only.
- `AccrueInterest` advances the global performance-fee-per-share accumulator.

## What The API Answers

For each wallet address, the backend exposes:

1. Active deposit: current vault share balance and estimated net USDC value
2. Lifetime deposited: cumulative USDC deposited on behalf of the wallet
3. Lifetime withdrawn: cumulative USDC withdrawn on behalf of the wallet
4. User-kept lifetime earned: existing `lifetimeEarned`
5. Crystallized earned performance fee: existing `earnedPerformanceFee`
6. Gross generated yield: `grossLifetimeEarned`
7. Estimated user-kept net earned: `estimatedNetLifetimeEarned`
8. Estimated total performance fee: `estimatedPerformanceFee`
9. Freshness metadata: `blockContext`

Vault-level reads expose current indexed total supply, adjusted valuation
totals, share price, and cumulative attributable performance-fee totals.

## Accumulator And Snapshot Model

Performance-fee attribution uses a staking-style global accumulator:

- `vault_reward_state.global_performance_fee_index_raw` tracks fee shares per
  unit of vault shares, scaled by `1e36`.
- Each account stores `balance_raw`, `reward_debt_raw`, and
  `earned_performance_fee_shares_raw`.
- `AccrueInterest` increases the global index using the pre-mint total supply.
- `Transfer` settles sender/receiver against the current index before shares
  move.

USDC valuation does not happen during crawling. A separate snapshotter reads
`totalAssets()` and `totalSupply()` on an interval and inserts
`share_price_snapshots`. API responses use the latest cursor-eligible snapshot,
then replay already-processed vault-total logs after that snapshot into an
in-memory adjusted valuation so lazy fee mints are not paired with stale supply
or asset totals. Responses label the effective valuation with `valuationBlock`
and the base snapshot capture time with `valuationTime`.

Estimated account values are derived at read time from local SQLite state plus
the adjusted valuation. The API first values indexed shares from that valuation, then
reports `activeDeposit.valueRaw` as principal still in the vault plus estimated
user-kept net earnings. If the position is below principal, the API reports the
lower snapshot share value so losses remain visible. The estimate assumes the
current single-vault performance fee rate of `5000` bps and is surfaced
alongside `blockContext` freshness metadata.

## Quickstart

```bash
cp .env.example .env
npm install
npm run dev
```

Then open `http://127.0.0.1:8080/dashboard` for the local dashboard.

For production-style runs:

```bash
npm run build
npm start
```

## PM2

The included `ecosystem.config.cjs` runs the existing production script with
PM2:

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

Runtime settings should stay in `.env`. The app imports `dotenv/config`, and the
PM2 config pins `cwd` to this repository root so `.env` and relative paths such
as `DATABASE_PATH=./data/ethra-harbor-indexer.sqlite` resolve from here.

Important: `dotenv` does not override environment variables that PM2 already
passes to the process. If you want `.env` to be authoritative, avoid exporting
the same keys, such as `BASE_RPC_URL` or `API_PORT`, in the shell or PM2
environment used to start the service.

Useful PM2 commands:

```bash
pm2 logs ethra-harbor-indexer
pm2 reload ethra-harbor-indexer
pm2 stop ethra-harbor-indexer
pm2 delete ethra-harbor-indexer
```

Run `npm run build` again before reloading after code changes because PM2 runs
`npm start`, which executes the compiled `dist/index.js` file.

## Environment

| Variable | Purpose | Default | Notes |
| --- | --- | --- | --- |
| `BASE_CHAIN_ID` | Base chain guard. | `8453` | Must remain `8453`. |
| `BASE_RPC_URL` | Primary Base HTTP(S) RPC. | `https://base-rpc.publicnode.com` | Used first for heads, logs, and snapshot reads. |
| `BASE_CONTRACT_ADDRESS` | Vault contract to index. | `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` | Fixed production target. |
| `DATABASE_PATH` | SQLite file path. | `./data/ethra-harbor-indexer.sqlite` | Persist this path between runs. |
| `START_BLOCK` | Initial cursor block for a fresh DB. | `48578254` | Seeds one block before deployment so the first scanned block is `48578255`. |
| `CONFIRMATIONS` | Confirmation buffer before crawl. | `15` | Reorg posture is confirmation-buffer-only in v1. |
| `SNAPSHOT_INTERVAL_MS` | Share-price snapshot cadence. | `60000` | Snapshotter retries on the same interval after errors. |
| `API_ENABLED` | Enable the read-only HTTP API. | `true` | Any value other than `false` enables it. |
| `API_PORT` | HTTP API listen port. | `8080` | Must be `1`-`65535`. |
| `CHUNK_SIZE` | Maximum block span per crawl window. | `1000` | Smaller values help smoke tests and weaker RPCs. |
| `BASE_BLOCK_TIME_MS` | Base block time estimate. | `2000` | Configured value used by the backend. |
| `FAST_POLL_MS` | Poll delay while catching up. | `2000` | Applies in `auto`/`fast` modes. |
| `SLOW_POLL_MS` | Poll delay at the tip. | `50000` | Applies in `auto`/`slow` modes. |
| `CRAWL_MODE` | Scheduler mode. | `auto` | Allowed values: `auto`, `fast`, `slow`. |
| `RECONCILE_RPC_URLS` | Ordered fallback HTTP(S) RPC URLs. | empty | Appended after `BASE_RPC_URL`. |
| `LOG_LEVEL` | Structured log verbosity. | `info` | Allowed values: `debug`, `info`, `warn`, `error`. |

The provider always tries `BASE_RPC_URL` first. If `RECONCILE_RPC_URLS` is set,
the trimmed entries are appended in order and used as explicit fallbacks for
`getBlockNumber`, `getLogs`, and snapshot reads.

## API

The API is read-only and serves JSON plus a local static dashboard over built-in
`node:http`.

For exact response shapes, field meanings, units, nullability, and AI/service
client integration guidance, see
[`docs/api-integration-guide.md`](docs/api-integration-guide.md).

- `GET /dashboard`
  - Serves a browser dashboard for health, vault metrics, and account lookup
- `GET /health`
  - Returns `{ status, cursorBlock, safeHead, safeHeadKnown, syncedToSafeHead }`
- `GET /vault`
  - Returns vault totals, adjusted valuation, scaled share price, and
    cumulative performance-fee totals
- `GET /accounts/:address`
  - Returns the per-address metrics, including estimated net earnings and
    freshness metadata, for a checksum-valid wallet address

Unknown routes return `404`. Invalid account addresses return `400`.

## Cursor, Replay, And Dev-Stage Reset

The crawler cursor lives in `indexer_state` under the vault-specific id:

`base:vault:0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`

The crawler starts from `last_scanned_block + 1`. `START_BLOCK` only matters
when the database has no existing cursor row. With the default seed
`48578254`, the first crawl window starts at the vault deployment block
`48578255`.

This project is still in the dev-stage reset window. When schema/state changes
break compatibility, delete the SQLite file and restart the service to re-crawl
from `START_BLOCK`.

```bash
rm ./data/ethra-harbor-indexer.sqlite
npm run dev
```

You can inspect the current cursor first:

```bash
sqlite3 ./data/ethra-harbor-indexer.sqlite "select last_scanned_block from indexer_state;"
```

## Operational Notes

- Chunk application is atomic: raw event inserts, ledger updates, vault-state
  updates, and cursor advancement commit in one SQLite transaction.
- `applyChunk` rejects duplicate raw-log identities inside a fetched chunk and
  rejects replays of already-persisted raw logs before any ledger mutation.
- Raw event tables keep `block_hash` for future rollback support, but v1 reorg
  posture is the confirmation buffer only.
- Wallet address is the only identity. There is no user-profile or multi-wallet
  aggregation layer in this service.

## Scripts

- `npm run dev` runs the TypeScript entry point with `tsx`
- `npm run build` compiles `src/index.ts` with `tsc`
- `npm start` runs the compiled entry point from `dist/index.js`
- `npm test` runs Node's built-in test runner with `tsx`
