# Final Fix Report: Estimated Net Earnings API Review Findings

Date: 2026-07-17

## Summary

Resolved the final whole-branch review findings for the estimated net earnings API by adding the missing partial SQLite index for the active-vault performance-fee lookup, strengthening contract-address scoping coverage, and updating the saved execution plan plus evolution notes to match the shipped implementation.

## TDD Evidence

### RED

1. Added schema coverage in `test/db.test.ts` asserting `idx_accrue_perf_fee_latest` exists with the expected partial-index definition.
2. Strengthened `test/vaultDb.test.ts` so `readLastPerformanceFeeMintBlock(db, config)` must ignore a newer nonzero accrue event for another contract on the same chain.

Focused red verification:

```text
node --import tsx --test test/db.test.ts
```

Result:
- failed as expected because `idx_accrue_perf_fee_latest` was missing from the migrated schema

The strengthened same-chain other-contract regression in `test/vaultDb.test.ts` already matched the current scoped helper behavior, so the schema gap was the red-phase failure that drove the implementation.

### GREEN

Implemented:
- new migration `003_accrue_interest_perf_fee_index` in `src/db/index.ts`
- schema assertions updated for the new index
- focused same-chain other-contract regression in `test/vaultDb.test.ts`
- saved plan and evolution updates for the final helper signature and indexed query path

Focused green verification:

```text
node --import tsx --test test/db.test.ts
node --import tsx --test test/vaultDb.test.ts
```

Result:
- both passed

## Tests Run

1. `node --import tsx --test test/db.test.ts`
   - red: fail before migration
   - green: pass after migration
2. `node --import tsx --test test/vaultDb.test.ts`
   - pass with the strengthened scoping regression
3. `npm test`
   - first sandboxed run failed with `listen EPERM: operation not permitted 127.0.0.1`
   - reran with localhost escalation and all 75 tests passed
4. `npm run build`
   - passed

## Files Changed

- `src/db/index.ts`
- `test/db.test.ts`
- `test/vaultDb.test.ts`
- `docs/plans/2026-07-17-estimated-net-earnings-api-plan.md`
- `docs/evolution.md`

## Self-Review

- The new index matches the helper’s actual access pattern: `(chain_id, contract_address)` plus descending block/tx/log ordering and a `performance_fee_shares != '0'` partial predicate.
- Regression coverage now proves active-vault contract scoping on the same chain, which closes the specific review concern more directly than the earlier cross-chain check alone.
- The saved plan now reflects the final landed helper contract, scoped SQL, Task 2 call site, and completed execution state instead of the earlier unscoped examples.
- The change stayed within the requested backend/doc/test files and did not alter API semantics.

## Concerns

- No functional concerns from this fix set.
- The worktree still contains unrelated untracked files (`.DS_Store`, `.env`, `AGENTS.md`, `docs/indexer_concept.md`, `docs/morpho-vault-v2-indexer.md`); they were left untouched.
