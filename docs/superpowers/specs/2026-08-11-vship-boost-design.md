# vSHIP Boost Accounting Design

Date: 2026-08-11

## Goal

Move vSHIP boost accounting into the Harbor indexer so base boost and
per-wallet additional boost can change over time without rewriting past
rewards. Existing USDC yield / performance-fee tables stay the source of
truth for platform dollar yield. New tables own boost config, crystallized
vSHIP, fee watermarks, and audit history.

This pass is **indexer-only**. It does not change Morpho APY fetching, does
not wire the dashboard to indexer boost/vSHIP fields, and does not run
on-chain transactions. The operator may AccrueInterest and/or reindex
outside this system before cutover.

## Product rules

- Performance fee (app share of yield) remains computed by existing indexer
  math (`estimatedPerformanceFee`, crystallized fee shares). Those fields
  stay USDC-denominated for admin visibility.
- vSHIP conversion uses fixed price **$0.05** and boost multipliers.
- Boost is **additive**: `totalBoost = baseBoost + additionalBoost`
  (example: 4x + 10x = 14x).
- Boost changes must **not back-propagate**. Fee accrued under an old boost
  stays locked at that boost; only later fee growth uses the new boost.
- Wallets may appear on the additional-boost list before they deposit. They
  must still expose available boost (base + additional) with zero vSHIP
  until fees exist.
- Default at launch: base **4x**, additional **0**, price **$0.05**.

## Scope

### In scope

- New SQLite tables for reward config, wallet boosts, vSHIP state, and audit
- Soft crystallization (fee watermark) on boost mutations
- Eager settlement (all wallets on base change; one wallet on wallet change)
- Admin write APIs with shared-secret auth
- Admin history read APIs
- Extended `GET /accounts/:address` boost + vSHIP fields (unused by dashboard
  in this pass)
- Stale fee-mint refuse gate before boost mutations
- Tests for settlement math, non-backpropagation, auth, and gate

### Out of scope

- Morpho APY cache / frontend Morpho removal
- Dashboard wiring (client keeps local 4x / $0.05 until a later pass)
- Daily AccrueInterest job design or implementation
- Indexer-submitted chain transactions
- Admin API to change vSHIP price
- Actual vSHIP airdrop or token transfer
- Genesis backfill migration for an existing live DB (cutover is nuke +
  reindex; see Cutover)

## Architecture

```text
estimatedPerformanceFee (existing, USDC raw) ──► fee watermark / settle
                                                    │
reward_config.base_boost_bps                    vSHIP crystallized
wallet_boost.additional_boost_bps ──► total bps ──► pending on read
```

Settlement loop:

```text
fee_now = estimatedPerformanceFee.raw
watermark = wallet_vship_state.fee_watermark_raw  // 0 if missing
fee_delta = max(fee_now - watermark, 0)

total_boost_bps = base_boost_bps + additional_boost_bps

vship_minted = integer_vship(fee_delta, total_boost_bps, price)
crystallized += vship_minted
if fee_now >= watermark:
  watermark = fee_now
```

On boost change: settle with **old** total boost, then apply the new boost
value. If `old_bps === new_bps`, short-circuit (no settle, no event).

If `fee_now < watermark` (rare estimate dip): `fee_delta` is 0, mint
nothing, and leave the watermark unchanged so past locks are never clawed
back.

Pending on read (for API completeness):

```text
pending = integer_vship(max(fee_now - watermark, 0), current_total_boost_bps, price)
total = crystallized + pending
```

## Schema

Additive tables only. Do not alter existing deposit, withdraw, transfer,
accrue, position, snapshot, or vault reward tables.

### `reward_config` (singleton)

| Column | Type / notes |
| --- | --- |
| `id` | Constant singleton key (e.g. `1`) |
| `base_boost_bps` | Default `40000` (4x) |
| `vship_price_usd_raw` | Default `50000` ($0.05 at 6 decimals) |
| `vship_price_usd_decimals` | `6` |
| `vship_token_decimals` | `6` |
| `fee_mint_stale_blocks` | Default `20000` |
| `updated_at` | ms timestamp |

Price lives in config for a single source of truth. This pass does not
expose an admin price-change API; changing price without settlement would
affect pending math.

### `wallet_boost`

| Column | Notes |
| --- | --- |
| `address` | Normalized PK |
| `additional_boost_bps` | Extra multiplier; `0` means no extra |
| `updated_at` | |

Missing row ⇒ additional boost `0`. Pre-deposit wallets may exist here
without an `account_positions` row.

### `wallet_vship_state`

| Column | Notes |
| --- | --- |
| `address` | PK |
| `fee_watermark_raw` | Last settled estimated performance fee (USDC raw integer string) |
| `crystallized_vship_raw` | Locked vSHIP raw integer string |
| `updated_at` | |

### `boost_change_events`

| Column | Notes |
| --- | --- |
| `id` | |
| `changed_at` | |
| `change_type` | `base` \| `wallet_additional` |
| `address` | null for base changes |
| `old_bps`, `new_bps` | |
| `actor` | e.g. `admin` |
| `settled_wallet_count` | Wallets crystallized in that mutation |

### `vship_settlement_events`

| Column | Notes |
| --- | --- |
| `id`, `settled_at`, `address` | |
| `fee_before_raw`, `fee_after_raw`, `fee_delta_raw` | |
| `boost_bps_applied` | Total boost used for the segment |
| `vship_minted_raw` | |
| `crystallized_vship_after_raw` | |
| `reason` | `base_boost_change` \| `wallet_boost_change` |

## APIs

### Auth

Write and admin history routes require:

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

Missing or invalid token → `401`. Token comes from environment config.
Public account reads keep the current unauthenticated model.

### Writes

| Method / path | Body | Behavior |
| --- | --- | --- |
| `PUT /admin/boost/base` | `{ "baseBoostBps": "40000" }` | Stale-fee gate → if unchanged, no-op → else settle all eligible wallets under old base+additional → update `reward_config` → append `boost_change_events` |
| `PUT /admin/boost/wallets/:address` | `{ "additionalBoostBps": "100000" }` | Stale-fee gate → if unchanged, no-op → else settle that wallet under old total → upsert `wallet_boost` → append events. `0` clears additional boost |

Eligible wallets for base-boost eager settle: every address in
`wallet_vship_state` and/or with positive `estimatedPerformanceFee` and/or
in `wallet_boost` (so boosted-but-empty wallets remain consistent). Prefer
a deterministic union of those sets. Run inside **one SQLite transaction**.

### Stale fee-mint gate

Before any boost mutation:

1. Compute `blocksSincePerformanceFeeMint` using existing freshness helpers.
2. If value is non-null and `>= fee_mint_stale_blocks` (default 20000) →
   `409` with a clear error. No partial settles. No boost write.
3. Indexer does not call AccrueInterest; operator handles chain hygiene.

### Reads

Extend `GET /accounts/:address`:

```json
"boost": {
  "baseBoostBps": "40000",
  "additionalBoostBps": "100000",
  "totalBoostBps": "140000"
},
"vship": {
  "crystallizedRaw": "...",
  "pendingRaw": "...",
  "totalRaw": "...",
  "feeWatermarkRaw": "...",
  "priceUsdRaw": "50000",
  "priceUsdDecimals": 6
}
```

Unknown wallets still return `200` with base boost and zero vSHIP.

Admin history (authenticated):

| Method / path | Behavior |
| --- | --- |
| `GET /admin/boost/changes` | List `boost_change_events` newest-first; optional limit/cursor later |
| `GET /admin/vship/settlements/:address` | List that wallet’s `vship_settlement_events` newest-first |

### Error map

| Case | Status |
| --- | --- |
| Bad/missing admin token | `401` |
| Invalid address or bps | `400` |
| Stale fee mint gate | `409` |
| Transaction failure | `500` (full rollback) |

## Integer vSHIP math

Match the dashboard’s current bigint style (`calculateVShipRaw`):

```text
vship_raw = round_half_up(
  fee_raw * boost_bps * 10^price_decimals * 10^token_decimals
  / (10^fee_decimals * 10000 * price_usd_raw)
)
```

Fee decimals are USDC `6`. Do not use floating point at the persistence
boundary.

## Cutover (production)

Chosen cutover: **nuke SQLite + full reindex** (no genesis backfill code).

Operator steps:

1. Optionally AccrueInterest so on-chain fee state is fresh (operator-owned).
2. Stop indexer. Delete the SQLite file.
3. Deploy code with new migrations. Fresh DB seeds `reward_config` at 4x /
   $0.05 / stale gate 20000. Empty `wallet_boost` and `wallet_vship_state`.
4. Start indexer and wait until synced.
5. Until the first boost mutation, account reads report
   `pending = estimatedFee × 4x / $0.05` and `crystallized = 0`, so totals
   match “always 4x from the beginning.”
6. Re-apply any wallet additional boosts via admin API after sync (none
   expected at first launch of this feature).

Rationale: avoids backfill complexity; production is willing to re-crawl
from `START_BLOCK` for this release.

## Edge cases

| Case | Behavior |
| --- | --- |
| Boosted wallet, never deposited | Boost fields populated; vSHIP zero until fee > 0 |
| Base change ~10k wallets | Single SQLite transaction |
| `additionalBoostBps = 0` | Settle under old additional, then clear extra |
| Identical PUT | No settle, no event |
| `fee_now < watermark` | No negative mint; sticky watermark |
| Dashboard this pass | Unchanged; still local 4x / $0.05 |

## Testing

- vSHIP mint from fee delta × boost / $0.05 matches expected raw units
- After boost change, prior crystallized stays fixed while new fee growth
  uses new boost
- Additive 4x + 10x = 14x on settle/pending
- Stale-mint gate returns 409 and leaves tables unchanged
- Admin routes 401 without token
- Pre-deposit boosted wallet returns boost on account read
- History endpoints return ordered change/settlement rows
- Existing USDC fee response fields unchanged by boost mutations
- Fresh DB seed has base 4x and $0.05 price

## Documentation follow-ups (implementation)

When implementing, update indexer `docs/architecture.md`,
`docs/api-integration-guide.md`, `docs/overview.md` (write API exception),
and `docs/evolution.md`. Dashboard docs stay unchanged this pass.
