# vSHIP Price Change — Later Follow-up

Date: 2026-08-11  
Status: Deferred notes only — do not implement in the current boost pass  
Related: [`2026-08-11-vship-boost-design.md`](./2026-08-11-vship-boost-design.md)

## Intent

The boost accounting design fixes vSHIP at **$0.05** and does not expose an
admin price API. This note describes how to add **price changes with no
back-propagation** later, if needed.

Assumption for that future work: operators will likely **pick a final price
and backfill / re-cutover** (or settle once under the old price) rather than
maintain a long multi-price history from day one. Therefore the current boost
schema intentionally does **not** store `price_usd_raw_applied` on settlement
rows.

## Why price change is isomorphic to base boost

Settlement already is:

```text
vSHIP_minted = fee_delta_raw × total_boost_bps / price
```

Non-backpropagation for boost works by soft-crystallizing the fee watermark
under the **old** boost, then applying the new boost to later fee growth.

Price works the same way:

1. Mutation-readiness gate (synced cursor + usable valuation).
2. Stale fee-mint gate (unchanged).
3. Eager-settle **all eligible wallets** using:
   - current `base_boost_bps + additional_boost_bps`
   - **old** `vship_price_usd_raw`
4. Update `reward_config` to the new price.
5. Append an audit event for old → new price.
6. Later fee growth (`estimatedPerformanceFee - watermark`) converts at the
   **new** price on pending reads and on the next settle.

No new watermark model is required.

## Minimal schema / API additions (when implementing)

### Config

`reward_config` already holds:

- `vship_price_usd_raw`
- `vship_price_usd_decimals`
- `vship_token_decimals`

Only the admin mutation path is missing.

### Audit

Either:

- extend `boost_change_events.change_type` with `price` and store old/new in
  `old_bps` / `new_bps` **poor fit** (those columns are boost bps), or
- preferred: add `price_change_events` (or a generic `reward_config_change_events`)
  with `old_price_usd_raw`, `new_price_usd_raw`, `settled_wallet_count`,
  `changed_at`, `actor`.

### Admin route

Example:

```http
PUT /admin/vship/price
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json

{ "vshipPriceUsdRaw": "20000" }
```

Meaning: $0.02 at 6 decimals. Reject non-positive prices with `400`. Same
auth / route-registration rules as other admin endpoints (`ADMIN_API_TOKEN`
required or `/admin/*` stays unregistered).

Identical PUT (new === old) → no settle, no event.

### Settlement rows

Optional later enhancement: add `price_usd_raw_applied` to
`vship_settlement_events` for self-describing segments.

**Not required for a first price-change ship** if you keep:

- `fee_delta_raw`
- `boost_bps_applied`
- `vship_minted_raw` (computed at the price active during that settle)

Together those let you verify or recompute. If you only ever use one price
until a one-shot cutover, fee deltas + boosts alone are enough to rebuild
totals under a new global price.

## One-shot “final price” backfill (likely path)

If the product decision is “everything should have been priced at $X from
now on / retrospectively”:

### Option A — Soft settle then change (keeps past vSHIP locks)

1. Ensure indexer is synced; AccrueInterest if desired (operator-owned).
2. `PUT` new price → system settles all wallets at **old** price, then
   switches config to **new** price.
3. Historical crystallized vSHIP stays at the old conversion; only future
   fee growth uses $X.

Use this when past display totals must remain frozen.

### Option B — Nuke / rebuild under the final price (simplest recount)

Same spirit as the boost cutover:

1. Stop indexer; delete SQLite (or accept a dedicated rebuild tool).
2. Seed `reward_config` with the **final** price (and desired base boost).
3. Reindex from `START_BLOCK`.
4. Pending vSHIP = `estimatedPerformanceFee × boost / final_price` until the
   first settle.

Use this when you want a clean single-price history and can reset vSHIP
state. USDC fee tables rebuild from chain; boost/additional grants must be
re-applied via admin API after sync.

### Option C — Offline recount from settlement fee deltas

Without changing production config yet:

```text
for each wallet:
  sum over vship_settlement_events:
    recount += f(fee_delta_raw, boost_bps_applied, NEW_price)
  plus pending = f(fee_now - watermark, current_total_boost, NEW_price)
```

Useful for what-if spreadsheets or airdrop planning. Does not by itself
update `crystallized_vship_raw`; that still needs Option A, B, or a
one-off rewrite job.

## Implementation checklist (copy when ready)

- [ ] Spec amendment: product rule for price (freeze past vs full recount)
- [ ] `setVshipPrice` in settle service (clone `setBaseBoost`, swap field)
- [ ] Admin `PUT /admin/vship/price` + tests (401/404/409/ready/stale/noop)
- [ ] Audit table or event type for price old→new
- [ ] Account pending already reads current `reward_config` price — confirm
- [ ] Docs: api-integration-guide, architecture, evolution
- [ ] Decide Option A vs B for production cutover; document operator steps

## Explicit non-goals of this note

- Do not implement price APIs in the current boost pass.
- Do not add `price_usd_raw_applied` to today’s schema unless a later
  implementation chooses to.
- Do not change Morpho or dashboard wiring as part of price support.
