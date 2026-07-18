# Vault Fee Attribution Indexer Concept

Last updated: 2026-07-16

This document captures the findings from the Privy Earn / Morpho Vault V2
investigation and explains how a future agent should design an indexer that can
attribute admin performance fees back to the users whose vault positions earned
those fees.

## Goal

Build a replayable, chain-sourced ledger that answers:

> For each admin performance-fee mint, which app user generated how much of it?

The result will be used to issue in-app reward tokens to users. The reward logic
must be reliable if the backend is down, so the source of truth should be
reconstructable from on-chain logs.

## Known Contracts and Values

| Item | Value |
| --- | --- |
| Chain | Base mainnet |
| Chain ID | `8453` |
| Vault address | `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` |
| Asset | Base USDC |
| USDC address | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC decimals | `6` |
| Vault share decimals | `18` |
| Admin / performance fee recipient observed | `0xe6Ee165bc0B05bEa7C5991D3b94B11aEa76c4FB9` |
| User example | `0x987C8a5821351D4D10a6144f7366cAfe1eBDDd9B` |
| Observed performance fee | `500000000000000000` (`50%`, WAD-scaled) |
| Observed management fee | `0` |

The vault is a Morpho Vault V2 / ERC-4626-style vault. Users deposit USDC and
receive vault shares. Admin fees are minted as vault shares, not transferred as
USDC.

## Critical Accounting Finding

Do not attribute an admin fee mint to the transaction sender.

The vault accrues interest at the first vault interaction in a transaction. A
deposit, withdraw, or redeem can trigger `AccrueInterest` before the user action
itself is recorded. Therefore, the user who submits the transaction is often only
the trigger, not necessarily the source of the fee.

Example:

1. User deposits `$2`.
2. Time passes and the `$2` position earns yield.
3. The same user deposits `$7` more.
4. The vault first emits `AccrueInterest`.
5. Any admin performance fee minted at that moment was earned by the existing
   `$2` position, not by the new `$7` deposit.
6. After the `$7` deposit mints new shares, future accruals should use the
   larger combined position.

The correct attribution basis is: who held vault shares immediately before the
`AccrueInterest` event?

## Reward Policy Recommendation

Reward only realized admin fees.

That means rewards should be based on `AccrueInterest` events that mint admin
fee shares. Do not reward from dashboard balance changes or pending
`accrueInterestView()` values unless the product explicitly wants speculative
pending rewards.

Reasons:

- Realized fee events are final on-chain facts after confirmation.
- They can be replayed from logs.
- They avoid rewarding yield that has not yet minted any admin fee shares.
- They keep the reward ledger auditable.

## Events to Index

The indexer should process logs from the vault in exact `(block_number,
transaction_index, log_index)` order.

### `AccrueInterest`

```solidity
event AccrueInterest(
  uint256 previousTotalAssets,
  uint256 newTotalAssets,
  uint256 performanceFeeShares,
  uint256 managementFeeShares
);
```

Topic:

```text
0x4dec04e750ca11537cabcd8a9eab06494de08da3735bc8871cd41250e190bc04
```

Use this event to create a fee attribution event. `previousTotalAssets` and
`newTotalAssets` are raw USDC units with `6` decimals. `performanceFeeShares`
and `managementFeeShares` are vault-share units with `18` decimals.

### `Transfer`

```solidity
event Transfer(address indexed from, address indexed to, uint256 shares);
```

Topic:

```text
0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```

Use this event as the canonical source for vault-share balances.

Interpretation:

- `from = 0x000...000`: share mint.
- `to = 0x000...000`: share burn.
- zero to user: deposit/mint shares.
- zero to admin: fee shares minted to admin.
- user to zero: withdraw/redeem burns shares.
- non-zero to non-zero: share transfer. Future rewards follow the shares.

### `Deposit`

```solidity
event Deposit(
  address indexed sender,
  address indexed onBehalf,
  uint256 assets,
  uint256 shares
);
```

Topic:

```text
0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7
```

Use this for labeling and analytics. Do not use it as the only source of share
balances; `Transfer` is the balance source of truth.

### `Withdraw`

```solidity
event Withdraw(
  address indexed sender,
  address indexed receiver,
  address indexed onBehalf,
  uint256 assets,
  uint256 shares
);
```

Use this for labeling and analytics. Again, `Transfer` is the balance source of
truth.

## Core Indexing Algorithm

The indexer should maintain an in-memory or database-backed map:

```text
address => vault_share_balance_raw
```

Process every vault log in canonical order.

### On `Transfer`

Update balances:

```text
if from != zero:
  balances[from] -= shares

if to != zero:
  balances[to] += shares
```

This keeps the share ledger correct across deposits, withdrawals, fee mints, and
normal ERC-20 transfers.

### On `AccrueInterest`

Before applying the following fee mint transfer, snapshot the current balances.
Those balances represent the holders who earned the yield being accrued.

If `performanceFeeShares == 0`, no user reward allocation is needed.

If `performanceFeeShares > 0`:

1. Let `totalSupplyBefore` be the sum of all real vault-share balances before the
   fee mint.
2. For each app user wallet with a positive balance:

```text
userFeeShares =
  performanceFeeShares * userBalanceBefore / totalSupplyBefore
```

3. Store the allocation.
4. Continue processing later logs, including the actual fee `Transfer` from
   zero to the admin address.

Use integer math. To avoid losing precision, store either:

- `fee_shares_allocated_raw` as the floored integer result plus a remainder
  field, or
- the exact rational value:

```text
numerator = performanceFeeShares * userBalanceBefore
denominator = totalSupplyBefore
```

The reward-token minting step can later decide how to round.

## Denominator Policy

Use total real share supply before the fee mint as the denominator.

This should include:

- app user wallets,
- admin fee shares already held by the admin,
- unknown wallets,
- any other address that holds vault shares.

Only allocate reward tokens to known app users, but do not pretend unknown/admin
shares do not exist. Otherwise known users would be over-credited.

If the product intentionally wants to redistribute all admin fees only among app
users, document that as a product choice. That is not the same as answering
"which user generated how much admin fee?"

## User Mapping

The indexer needs a stable mapping from wallet address to app user:

```text
user_wallets
- user_id
- privy_wallet_id
- wallet_address
- first_seen_at
- archived_at / removed_at, nullable
```

Attribution should be by wallet address first, then aggregated to `user_id`.

If a user has multiple wallets, aggregate allocations across all mapped wallets.
If vault shares are transferred to an unknown address, future fee attribution for
those shares should remain unassigned until the address is mapped to a user.

## Suggested Tables

### `indexed_blocks`

```text
chain_id
block_number
block_hash
processed_at
```

Used for replay, idempotency, and reorg detection.

### `vault_share_balances`

```text
vault_address
wallet_address
share_balance_raw
updated_block_number
updated_log_index
```

This can be rebuilt entirely from `Transfer` events.

### `vault_accruals`

```text
vault_address
tx_hash
log_index
block_number
previous_total_assets_raw
new_total_assets_raw
performance_fee_shares_raw
management_fee_shares_raw
total_supply_before_raw
created_at
```

Unique key:

```text
(vault_address, tx_hash, log_index)
```

### `reward_fee_allocations`

```text
vault_address
accrual_tx_hash
accrual_log_index
user_id
wallet_address
user_balance_before_raw
total_supply_before_raw
performance_fee_shares_raw
fee_shares_allocated_raw
fee_shares_remainder_numerator
fee_shares_remainder_denominator
reward_tokens_minted_raw
reward_status
```

The `reward_status` can be `pending`, `minted`, `skipped`, or `failed`.

### `unknown_fee_allocations`

Optional, but useful for audits:

```text
vault_address
accrual_tx_hash
accrual_log_index
wallet_address
share_balance_before_raw
fee_shares_allocated_raw
reason
```

Reasons can include `admin_wallet`, `unknown_wallet`, or `unmapped_wallet`.

## Value Units

The admin receives vault shares, not USDC.

For exact attribution, store share amounts as the primary unit. If the app needs
a USDC display value, compute it separately and label the valuation time:

- at accrual block,
- at reward mint time,
- or at current display time.

Do not mix these concepts. A fee share amount is exact. Its USDC value can drift
as the vault share price changes.

## Privy Integration Role

Privy wallet actions and webhooks are not the reward ledger.

Use Privy for:

- mapping Privy wallet IDs to wallet addresses and users,
- learning when an app-initiated deposit/withdraw action exists,
- showing action status in the UI,
- optionally waking the indexer when something happened.

Do not use Privy action sender or action status to attribute fee rewards. The
chain events decide attribution.

## Backfill and Replay

An indexer should be able to rebuild all derived state from scratch.

Minimum replay steps:

1. Start at the vault deployment block or a configured first indexed block.
2. Fetch vault logs in block ranges.
3. Sort by block number, transaction index, and log index.
4. Process logs deterministically.
5. Persist block hash checkpoints.
6. On restart, resume from the latest finalized checkpoint.

Use a confirmation buffer before finalizing rewards. For Base, choose a product
safe value such as `12` to `30` blocks unless the deployment has stricter needs.

## Reorg Handling

Store block hashes. On each run:

1. Check whether the stored hash for the last processed block still matches the
   chain.
2. If it does not match, roll back to the most recent matching block.
3. Delete derived rows after that block.
4. Replay forward.

Every derived record should be idempotent using `(tx_hash, log_index)` keys.

## Test Cases a Future Agent Should Build

### Single user, second deposit

Scenario:

1. User deposits `$2`.
2. Yield accrues.
3. User deposits `$7`.
4. `AccrueInterest` emits before the `$7` deposit share mint.

Expected:

- The fee at the start of the `$7` deposit is attributed to the user's previous
  share balance only.
- The new `$7` shares are not included until future accruals.

### Multiple users

Scenario:

1. User A has 25% of pre-accrual shares.
2. User B has 75% of pre-accrual shares.
3. Admin receives `1000` performance fee shares.

Expected:

- User A allocation: `250`.
- User B allocation: `750`.

### Admin already holds fee shares

Scenario:

1. Admin already holds vault shares from prior fees.
2. New performance fee is minted.

Expected:

- Admin's existing share balance is included in the denominator.
- The portion attributable to admin's own shares is not credited to app users
  unless the product explicitly wants redistribution.

### Unknown holder

Scenario:

1. A vault share transfer sends shares to an unmapped wallet.
2. A fee accrual happens later.

Expected:

- Unknown holder's balance is included in the denominator.
- Its allocation is stored as unknown/unassigned.
- Known app users are not over-credited.

### Withdrawal before accrual

Scenario:

1. User exits the vault.
2. Later, an accrual event happens.

Expected:

- The exited user gets no allocation for that later accrual.

## Anti-Patterns

Do not:

- attribute the admin fee to `tx.from`,
- attribute the admin fee to the latest depositor,
- use dashboard balance deltas as the reward ledger,
- rely only on Privy wallet action statuses,
- ignore event order inside a transaction,
- ignore unknown/admin shares in the denominator,
- convert all fee shares to USDC without recording when that valuation occurred.

## Recommended Implementation Shape

A small TypeScript worker is enough for the first version:

- `viem` or similar EVM client for log fetching and decoding,
- Postgres for durable state,
- a scheduled worker or long-running process,
- a replay command for backfills,
- a finalization delay for reorg safety.

The worker should expose internal commands:

```text
backfill --from-block <block>
sync
replay --from-block <block>
recompute-rewards --from-block <block>
```

Reward minting should be a separate step from indexing. The indexer should first
produce deterministic `reward_fee_allocations`; a reward service can then mint or
credit in-app tokens after the indexed block is finalized.

