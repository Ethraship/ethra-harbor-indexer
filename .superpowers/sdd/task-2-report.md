# Task 2 Report: Account API Estimated Net Earnings

## What I implemented

- Extended `/accounts/:address` responses in `src/api/queries.ts` with:
  - `grossLifetimeEarned`
  - `estimatedNetLifetimeEarned`
  - `estimatedPerformanceFee`
  - `blockContext`
- Used the approved Task 1 helper signature `readLastPerformanceFeeMintBlock(db, config)`.
- Added `PERFORMANCE_FEE_RATE_BPS = 5000n` and bigint-safe estimated fee math.
- Added account API coverage for:
  - known account snapshot responses
  - no-snapshot responses
  - unknown/fresh account responses affected by the widened API shape
  - last performance fee mint freshness reporting

## TDD Evidence

- RED command:
  - `node --import tsx --test test/api.test.ts`
- Initial sandbox result:
  - failed with `listen EPERM: operation not permitted 127.0.0.1`
- RED command rerun with localhost/network escalation:
  - `node --import tsx --test test/api.test.ts`
- Expected failing evidence after escalation:
  - `api serves account, vault, and health metrics from indexed state` failed because `grossLifetimeEarned`, `estimatedNetLifetimeEarned`, `estimatedPerformanceFee`, and `blockContext` were missing
  - `api reports last performance fee mint freshness in account block context` failed because `body.grossLifetimeEarned` was `undefined`
  - `api returns raw metrics with null valuation fields when no snapshot exists` failed because the same new response fields were missing
- GREEN command:
  - `node --import tsx --test test/api.test.ts`
- GREEN result:
  - pass, 7 tests passed

## Tests run

- Focused API file:
  - `node --import tsx --test test/api.test.ts`
  - Result: pass, 7 tests passed
- Full suite:
  - `npm test`
  - Result: pass, 75 tests passed

## Files changed

- `src/api/queries.ts`
- `test/api.test.ts`
- `.superpowers/sdd/task-2-report.md`

## Self-review

- The implementation stayed scoped to `/accounts/:address`; vault, health, dashboard, and docs behavior were not expanded beyond the account response shape changes required by shared tests.
- Estimated values are computed with bigint arithmetic only, with floor behavior preserved by integer division.
- `blockContext.currentBlock` follows the latest valuation snapshot block when a snapshot exists, otherwise `null`.
- `blockContext.lastProcessedLogBlock` comes from `readVaultCursor(db, config)`.
- `blockContext.lastPerformanceFeeMintBlock` comes from the approved scoped helper `readLastPerformanceFeeMintBlock(db, config)`.
- `blocksSincePerformanceFeeMint` is only populated when both current and last mint blocks are known.

## Concerns

- No functional concerns from the implemented task scope.
- The repository has unrelated untracked files in the worktree (`.DS_Store`, `.env`, `AGENTS.md`, and two docs files), so the commit was kept scoped to the task files only.
