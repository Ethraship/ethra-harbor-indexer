# Task 3 Report: Documentation For Estimated Earnings Semantics

## Status

Completed

## Summary

Updated the user-facing and architecture documentation to explain the new
estimated earnings semantics from Task 2, including gross lifetime earned,
estimated net earned, estimated performance fee, and block freshness metadata.
Also marked the saved plan as updated during the docs task.

## Files Changed

- `README.md`
- `docs/overview.md`
- `docs/architecture.md`
- `docs/evolution.md`
- `docs/plans/2026-07-17-estimated-net-earnings-api-plan.md`

## Verification

- `npm run build` -> PASS

Build output:

```text
> ethra-harbor-indexer@0.1.0 build
> tsc
```

## Fix Note

- Adjusted the saved-plan wording in `docs/plans/2026-07-17-estimated-net-earnings-api-plan.md` so Step 5 now records that the plan was saved before implementation and updated during the docs task, with the misplaced note removed from the Task 2 area.

## Fix Verification

- `npm run build` -> PASS

Build output:

```text
> ethra-harbor-indexer@0.1.0 build
> tsc
```

## Commit

- `759e112` `docs: explain estimated net earnings`

## Self-Review

- README now distinguishes mark-to-market lifetime earned, crystallized earned
  performance fee, gross generated yield, estimated net earned, estimated total
  performance fee, and freshness metadata.
- `docs/overview.md` keeps the backend-only scope intact while adding the new
  estimate and freshness bullets.
- `docs/architecture.md` now states that account reads derive estimated net
  earnings at read time from local SQLite state plus the latest snapshot and do
  not hit the chain during request handling.
- `docs/evolution.md` records the semantic shift with the requested date and
  rationale.
- The saved plan file now notes that it was saved before implementation and
  updated during the docs task.

## Concerns

- None. The change is documentation-only, and the required build completed
  successfully.
