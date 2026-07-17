# Cursor-Gated Valuation Snapshots Design

Date: 2026-07-17

## Goal

Prevent temporary earnings drops when a head snapshot observes a vault action
before the crawler has processed that action's logs.

The fix must apply consistently to `GET /accounts/:address` and `GET /vault`,
remain independent of polling intervals and confirmation settings, and avoid a
new scheduler or schema migration.

## Problem

The snapshotter and crawler run on independent timers. The snapshotter reads
vault totals at the current chain head, while the crawler only processes logs
through its confirmation-buffered safe head.

After a vault action mints performance-fee shares, a new snapshot can therefore
contain the post-mint supply before the local account and fee-attribution state
contains the matching logs. Combining those two states temporarily lowers the
reported estimated net earnings. The number corrects itself after a later crawl,
but the intermediate drop is misleading.

Changing `SNAPSHOT_INTERVAL_MS`, `SLOW_POLL_MS`, `CONFIRMATIONS`, block time, or
crawler chunk size changes the duration of this window. A fixed block-distance
or timing threshold would therefore encode scheduler assumptions into API
correctness.

## Chosen Approach

Continue capturing and storing every snapshot normally. For API valuation, use
the newest snapshot whose block has actually been processed by the crawler:

```text
valuationSnapshot.blockNumber <= lastProcessedLogBlock
```

The latest stored snapshot remains the latest observed head snapshot. A newer
snapshot is pending while its block is above the persisted crawler cursor. It
becomes eligible automatically when cursor advancement satisfies the invariant;
there is no promotion worker or mutable promoted flag.

This is the database form of retaining snapshots at `t` and `t-1`: API reads
continue using the latest eligible snapshot while any number of newer snapshots
wait for crawler confirmation and processing.

## Alternatives Considered

### Snapshot after every crawl

Read vault totals at the crawler cursor after each completed crawl. This tightly
couples valuation and crawling, adds historical-block RPC requirements to the
crawl path, and makes a nonessential valuation read capable of delaying crawl
progress.

### Anomaly-triggered crawling

Force a crawl when share supply or share price moves beyond an APR-derived
threshold. This remains unable to process unconfirmed blocks, requires retries,
and makes correctness depend on a heuristic that can misclassify valid vault
activity.

Cursor-gated reads are preferred because the persisted cursor is already the
authoritative statement that all vault logs through a block were applied.

## Repository Boundary

Add a snapshot repository query that accepts an inclusive maximum block and
returns:

```sql
SELECT ...
FROM share_price_snapshots
WHERE block_number <= ?
ORDER BY block_number DESC, captured_at DESC, id DESC
LIMIT 1
```

Keep the existing latest-snapshot query for observed-head freshness metadata.
The new query is read-only and requires no schema change.

The ordering preserves the current deterministic tie-break behavior when more
than one snapshot exists for the same block.

## Account API Behavior

`GET /accounts/:address` reads three block references:

- latest observed snapshot block
- persisted crawler cursor (`lastProcessedLogBlock`)
- newest valuation snapshot at or below that cursor

All snapshot-dependent account calculations use the valuation snapshot:

- active deposit value
- mark-to-market `lifetimeEarned`
- crystallized performance-fee value
- gross lifetime earned
- estimated net lifetime earned
- estimated performance fee

Response freshness semantics become:

- `blockContext.currentBlock`: newest observed snapshot block, used as an
  approximate recently observed chain height
- `blockContext.lastProcessedLogBlock`: persisted crawler cursor
- `valuationBlock`: block of the eligible snapshot used for financial values
- `valuationTime`: capture time of that eligible snapshot
- existing performance-fee mint block fields remain unchanged

When the latest observed snapshot is pending, `currentBlock` can be greater than
`valuationBlock`. That difference is intentional and tells clients how far the
stable valuation trails the latest observation.

If snapshots exist but none is at or below the cursor, snapshot-dependent values
and `valuationBlock`/`valuationTime` are `null`. `currentBlock` still reports the
newest observed snapshot block.

## Vault API Behavior

`GET /vault` uses the same eligible valuation snapshot as account reads for:

- total assets
- share price
- cumulative performance-fee share value
- valuation block and time

Indexed share totals and cumulative fee-share totals continue to come from the
local crawler state. The endpoint gains the same freshness distinction needed
to interpret the valuation:

```json
{
  "blockContext": {
    "currentBlock": 48750920,
    "lastProcessedLogBlock": 48750890
  },
  "valuationBlock": 48750860,
  "valuationTime": 1784291067583
}
```

`currentBlock` is the newest observed snapshot block; `valuationBlock` is the
snapshot actually used. Both API endpoints must select the same valuation block
when read against the same database state.

If no eligible snapshot exists, vault valuation fields remain `null`, while
indexed raw-share fields and block-context fields remain available.

## Data Flow

```text
Snapshot S captured at head
  -> store S normally
  -> S is pending while cursor < S.blockNumber
  -> APIs retain the newest snapshot at or below cursor

Crawler atomically processes logs and advances cursor through S.blockNumber
  -> S satisfies the eligibility invariant
  -> the next account and vault reads select S automatically
  -> S cannot become visible before all logs through S have been applied
```

The selection responds to actual cursor progress, not safe-head proximity. A
block being safe only means it is eligible to crawl; cursor advancement proves
that its logs were applied.

## Consistency Scope

This design establishes a one-sided consistency guarantee: a valuation snapshot
is never newer than indexed log state.

The crawler cursor can be newer than the selected snapshot because account
positions are current-state rows rather than historical versions. Exact
point-in-time reconstruction of every account and vault ledger field at the
valuation block would require versioned ledger state or replay-on-read and is
outside this minimal fix.

Consequently, indexed fee or position state can become visible before a newer
eligible snapshot exists, but the reverse ordering that caused the observed
downward drop is prevented.

The chosen guarantee directly removes the observed post-snapshot/pre-log
downward earnings window. It also preserves crawler throughput and the existing
read-only, SQLite-only API boundary.

## Error And Edge Cases

- A null cursor makes every snapshot ineligible.
- A snapshot at exactly the cursor block is eligible.
- Multiple pending snapshots are retained; the newest eligible one is selected.
- Empty or zero-supply eligible snapshots keep the existing zero-value behavior.
- Snapshot capture failures leave the previous eligible snapshot in use.
- Cursor stalls leave valuation stable rather than allowing head snapshots to
  run ahead of indexed logs.
- API reads continue to perform no RPC calls and no database writes.

## Dashboard Behavior

The dashboard uses the gated values returned by both APIs. It shows the newest
observed block, last processed log block, and valuation block as distinct values
so an operator can see when a newer snapshot is pending. No client-side
promotion or earnings correction is added.

## Testing

Add focused repository and API coverage for:

- selecting the newest snapshot at or below the cursor
- excluding a snapshot one block above the cursor
- accepting a snapshot exactly at the cursor
- deterministic selection among snapshots at the same block
- returning null valuation fields when only pending snapshots exist
- retaining the observed `currentBlock` while valuation is unavailable or older
- applying the same eligible valuation block to account and vault responses
- promoting automatically after the cursor advances without modifying snapshot
  rows
- preserving existing no-snapshot and zero-supply behavior

Update the dashboard render test for the new vault freshness metadata.

Run the focused tests first, followed by `npm test` and `npm run build`.

## Documentation

Update `docs/architecture.md` so the snapshot flow describes observed versus
eligible snapshots and the cursor-gating invariant. Append `docs/evolution.md`
because this changes API valuation semantics and freshness reporting.

No database reset is required.
