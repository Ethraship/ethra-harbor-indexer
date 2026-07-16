# Vault Position & Fee-Attribution Indexer — Design Spec

Last updated: 2026-07-16

## 1. Purpose

Evolve the current `Deposit`-only storage crawler in `ethra-harbor-indexer`
into a **stateful, address-keyed position and performance-fee-attribution
indexer** for the single Base Morpho Vault V2 at
`0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`.

The system must answer, per wallet address, purely from on-chain data:

1. **Active deposit** — how much the address currently holds in the vault
   (raw shares + USDC value).
2. **Lifetime deposited** — total USDC ever deposited on behalf of the address.
3. **Lifetime withdrawn** — total USDC ever withdrawn on behalf of the address.
4. **Lifetime earned** — approximate yield the address has earned (analytics,
   see §7).
5. **App profit from this address** — the performance ("admin") fee that this
   address's position generated, in fee-share units and USDC value.

It must also expose vault-level totals, including the app's cumulative
performance-fee profit.

## 2. Non-Goals

- No Privy, no user profiles, no external identity input. **Wallet address is
  the only identifier.** Aggregation of multiple wallets into an app user is
  explicitly out of scope for this version.
- No reward-token minting. This indexer produces the deterministic ledger; a
  separate service can mint later.
- No management-fee attribution logic beyond tracking totals (observed
  `managementFee = 0`).
- No full block-hash reorg rollback in v1 (see §8).
- No WebSocket/live subscriptions. HTTP JSON-RPC polling only.

## 3. Known Constants

| Item | Value |
| --- | --- |
| Chain | Base mainnet |
| Chain ID | `8453` |
| Vault | `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` |
| Asset | Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Asset decimals | `6` |
| Share decimals | `18` |
| Deployment block | `48578255` |
| First Deposit block | `48678603` |
| Perf-fee recipient (observed) | `0xe6Ee165bc0B05bEa7C5991D3b94B11aEa76c4FB9` |
| Performance fee (observed) | `50%` (`500000000000000000` WAD) |
| Index scale factor | `1e36` |

## 4. Events Indexed

All from the vault address, fetched in **one** `getLogs` call per chunk using a
4-topic OR filter, then merged and processed in strict
`(block_number, transaction_index, log_index)` order.

```solidity
event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares);
// topic 0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7

event Withdraw(address indexed sender, address indexed receiver, address indexed onBehalf, uint256 assets, uint256 shares);
// topic 0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db

event Transfer(address indexed from, address indexed to, uint256 shares);
// topic 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef

event AccrueInterest(uint256 previousTotalAssets, uint256 newTotalAssets, uint256 performanceFeeShares, uint256 managementFeeShares);
// topic 0x4dec04e750ca11537cabcd8a9eab06494de08da3735bc8871cd41250e190bc04
```

**Why ordering is load-bearing:** the vault emits `AccrueInterest` at the first
interaction in a transaction, *before* the fee-mint `Transfer` and before a
deposit's share-mint `Transfer`. Fees must be attributed to holders as they
existed immediately before those mints. Processing out of order corrupts
attribution.

Event roles:

- `Transfer` is the **canonical** source of share balances and `totalSupply`.
  `from == 0x0` is a mint; `to == 0x0` is a burn; non-zero → non-zero is a user
  share transfer (rewards follow the shares).
- `Deposit` / `Withdraw` are used **only** for lifetime USDC totals and
  labeling, never as a balance source.
- `AccrueInterest` drives the fee-per-share accumulator.

## 5. Core Algorithm — Global Performance-Fee-Per-Share Accumulator

A staking-style index avoids writing a per-user row on every accrual.

### State

Global (`vault_reward_state`):
- `global_performance_fee_index_raw` (scaled by `1e36`)
- `total_supply_raw`
- `cumulative_performance_fee_shares_raw`
- `cumulative_management_fee_shares_raw`

Per address (`account_positions`):
- `balance_raw`
- `reward_debt_raw`
- `earned_performance_fee_shares_raw`
- `lifetime_deposited_raw`
- `lifetime_withdrawn_raw`

### Settlement helper

```text
settle(account):
  pending = balance_raw[account] * (global_index - reward_debt_raw[account]) / SCALE
  earned_performance_fee_shares_raw[account] += pending
  reward_debt_raw[account] = global_index
```

### On `AccrueInterest`

```text
cumulative_performance_fee_shares_raw += performanceFeeShares
cumulative_management_fee_shares_raw  += managementFeeShares
if performanceFeeShares > 0 and total_supply_raw > 0:
  global_index += performanceFeeShares * SCALE / total_supply_raw
```

### On `Transfer(from, to, shares)`

```text
if from != 0x0:
  settle(from)
  balance_raw[from] -= shares
else:
  total_supply_raw += shares   // mint

if to != 0x0:
  settle(to)
  balance_raw[to] += shares
  reward_debt_raw[to] = global_index   // freshly minted/received shares start now
else:
  total_supply_raw -= shares   // burn
```

Mint settles only `to`; burn settles only `from`; a normal transfer settles
both before moving shares.

### On `Deposit` / `Withdraw`

```text
Deposit:  lifetime_deposited_raw[onBehalf] += assets
Withdraw: lifetime_withdrawn_raw[onBehalf] += assets
```

These do not touch balances; the paired `Transfer` mint/burn already does.

### Denominator policy

`total_supply_raw` is the **real** total share supply before each fee mint and
includes app users, the admin's own fee shares, and any unknown holders. We do
not shrink the denominator to "known users only," which would over-credit
holders. Every holding address (including admin/unknown) accrues
`earned_performance_fee_shares_raw`; the API simply reports per address and does
not filter.

## 6. The Five Metrics

Let `snapshot` be the latest `share_price_snapshots` row. USDC value of `N`
shares = `N * snapshot.total_assets_raw / snapshot.total_supply_raw` (integer,
floored).

1. **Active deposit** = `balance_raw` (shares) and its USDC value.
2. **Lifetime deposited** = `lifetime_deposited_raw` (USDC, 6 decimals).
3. **Lifetime withdrawn** = `lifetime_withdrawn_raw` (USDC, 6 decimals).
4. **Lifetime earned** = `max(0, activeDepositValue + lifetime_withdrawn_raw − lifetime_deposited_raw)`.
5. **App profit from this address** = settled
   `earned_performance_fee_shares_raw` (settled to the latest global index at
   read time) as shares, plus its USDC value.

Every response labels the valuation with `snapshot.block_number` and
`snapshot.captured_at`.

## 7. Why "Lifetime Earned" Is Analytics, Not Protocol Truth

For a wallet that only deposits and withdraws, `currentValue + withdrawn −
deposited` is a genuinely correct USDC cash-flow P&L, and it is already net of
the admin performance fee (the vault takes its cut before share price rises). It
diverges from exact truth only under:

- **Share transfers.** ERC-20 share transfers move value without any recorded
  `Deposit`/`Withdraw` assets. Received shares inflate "earned"; sent shares
  deflate it (can go negative before flooring).
- **Valuation timing.** Current value is mark-to-market off the latest snapshot
  and includes *unrealized* gains that can still move; it is not realized until
  withdrawal.
- **Rounding / limits.** `total_assets / total_supply` floors, and it ignores
  exit fees, liquidity limits, and `maxWithdraw` (which this vault returns as
  `0`).

We label metric 4 as analytics and always report the valuation block/time.

## 8. Reliability, Idempotency, Reorgs

- **Crawl model (unchanged trust):** `safeHead = head − confirmations`,
  `fromBlock = cursor + 1`, `toBlock = min(safeHead, fromBlock + chunk − 1)`.
  Downtime is recovered by resuming from the persisted cursor.
- **Atomic chunk apply:** for each chunk, in a single SQLite transaction: insert
  raw events (`INSERT OR IGNORE` on `(chain_id, tx_hash, log_index)`) → apply
  accumulator/ledger updates for the merged, sorted logs → advance cursor. The
  accumulator is **not** idempotent, so exactly-once application is guaranteed
  by this atomicity: a failed chunk commits nothing and the same range retries.
- **Reorg safety (v1) = confirmation buffer only.** Default `CONFIRMATIONS` is
  raised (recommend `15`, configurable) so only sufficiently final blocks are
  processed. `block_hash` is stored on every raw event. Full block-hash rollback
  (detect stored-hash mismatch → delete derived rows after the divergent block →
  replay) is a documented future enhancement, deferred because deep reorgs past
  the buffer are very rare on Base.
- **Replay:** derived state is fully rebuildable by resetting the cursor and
  wiping derived tables, then re-crawling.

## 9. Valuation — Periodic Share-Price Snapshot

An independent snapshotter periodically reads the vault `totalAssets()` and
`totalSupply()` at the current head and inserts a `share_price_snapshots` row
(`block_number`, `total_assets_raw`, `total_supply_raw`, `captured_at`). Cadence
is env-configured (`SNAPSHOT_INTERVAL_MS`) and independent of the crawl loop.
Reads always use the latest snapshot; no per-request RPC. `totalAssets()` may
slightly lag unaccrued interest on Vault V2 — acceptable for display, and every
API response labels the valuation block/time.

## 10. Data Model (new migration; dev-stage reset)

Per `AGENTS.md` dev-stage policy, the persisted shape changes and there is no
real data, so the migration recreates schema rather than back-filling. Existing
local databases are nuked.

### Raw event tables (audit/replay, all `UNIQUE(chain_id, tx_hash, log_index)`)

- `deposit_events` (existing; unchanged)
- `withdraw_events` (`sender`, `receiver`, `on_behalf`, `assets`, `shares`, +
  block/tx/log/hash/raw_json/created_at)
- `transfer_events` (`from_address`, `to_address`, `shares`, + block/tx/log/…)
- `accrue_interest_events` (`previous_total_assets`, `new_total_assets`,
  `performance_fee_shares`, `management_fee_shares`,
  `total_supply_before_raw`, `global_index_after_raw`, + block/tx/log/…)

### Derived tables

- `account_positions`
  (`address` PK, `balance_raw`, `reward_debt_raw`,
  `earned_performance_fee_shares_raw`, `lifetime_deposited_raw`,
  `lifetime_withdrawn_raw`, `updated_block_number`, `updated_log_index`)
- `vault_reward_state` (single row: `id`, `global_performance_fee_index_raw`,
  `total_supply_raw`, `cumulative_performance_fee_shares_raw`,
  `cumulative_management_fee_shares_raw`, `updated_block_number`)
- `share_price_snapshots` (`id`, `block_number`, `total_assets_raw`,
  `total_supply_raw`, `captured_at`)

### Cursor

`indexer_state` reused with a new id, e.g.
`base:vault:0x9d2f…364d`, so it is distinct from the old deposit-only cursor.
All large integers stored as decimal **strings** (never floats).

## 11. Read-Only HTTP API

A minimal server on Node's built-in `node:http` (no Express; stays
dependency-light and backend-only). All responses JSON, all big integers as
strings.

- `GET /health` → `{ status, cursorBlock, safeHeadKnown }`
- `GET /vault` → global totals: `total_supply_raw`, latest snapshot
  (`total_assets_raw`, `sharePriceScaledRaw`, `sharePriceScale`, block,
  captured_at; `sharePriceScaledRaw = total_assets_raw * 10^18 /
  total_supply_raw`, floored, or `"0"` when supply is zero),
  `cumulative_performance_fee_shares_raw` + its USDC value.
- `GET /accounts/:address` → normalized address + the five metrics of §6, each
  with raw and (where relevant) USDC value, plus `valuationBlock` /
  `valuationTime`. Unknown address → zeros, HTTP 200.
- Invalid address → HTTP 400.

## 12. Configuration (additions)

```env
# existing crawl vars retained
CONFIRMATIONS=15            # raised default for stateful ledger safety
START_BLOCK=48578254        # seed one block before deployment so first scan is 48578255
SNAPSHOT_INTERVAL_MS=60000  # share-price snapshot cadence
API_ENABLED=true
API_PORT=8080
```

## 13. Test Strategy

- **Event decoder:** fixture logs via `ethers.Interface.encodeEventLog` for all
  four events; assert normalized fields.
- **Ledger accumulator:** the five scenarios from `indexer_concept.md` —
  single-user second deposit, multi-user split, admin already holds fee shares,
  unknown holder, withdrawal before accrual — plus a share-transfer-follows case.
- **Repositories:** migration creation, idempotent raw inserts, atomic derived +
  cursor advance, replay reset.
- **Snapshot:** value math and latest-snapshot selection.
- **API:** known/unknown/invalid address, `/vault`, `/health`.
- **Crawler:** mocked provider, two chunks, 4-topic fetch, merge ordering,
  no double-apply on retry.

## 14. Deliverables

- This spec: `docs/plans/2026-07-16-vault-position-fee-indexer-spec.md`
- Implementation plan:
  `docs/plans/2026-07-16-vault-position-fee-indexer-plan.md`
