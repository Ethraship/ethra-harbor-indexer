# Task 3 Report: SQLite Migrations And Repositories

## Implementation Summary

- Added `src/db/index.ts` to open SQLite databases, create parent directories, enable WAL mode, apply the required schema migration, and re-export DB repository interfaces.
- Added `src/db/deposits.ts` with the required public interfaces and repository functions for cursor creation, transactional deposit persistence, and crawl error recording.
- Added `test/db.test.ts` with focused database tests covering migration setup, initial cursor creation, duplicate deposit idempotency, transactional rollback, and crawl error persistence.

## TDD Evidence

### RED

Command:

```bash
npm test -- test/db.test.ts
```

Output:

```text
> ethra-harbor-indexer@0.1.0 test
> node --import tsx --test test/**/*.test.ts test/db.test.ts

...
Error: Cannot find module '../src/db'
...
not ok 2 - test/db.test.ts
...
# pass 11
# fail 1
```

Notes:

- The first RED run failed because the new DB module entrypoint did not exist yet, which confirmed the test was exercising the intended missing interface.

### GREEN

Command:

```bash
npm test -- test/db.test.ts
```

Output:

```text
> ethra-harbor-indexer@0.1.0 test
> node --import tsx --test test/**/*.test.ts test/db.test.ts

...
# tests 16
# pass 16
# fail 0
```

Notes:

- I initially tried to force rollback with a `NOT NULL` violation, but `INSERT OR IGNORE` correctly suppressed that row. I tightened the test by adding a temporary SQLite trigger that raises `ABORT`, which gives a real transactional failure and proves the cursor update rolls back with the batch.

## Final Verification

### Targeted DB tests

Command:

```bash
npm test -- test/db.test.ts
```

Result:

```text
# tests 16
# pass 16
# fail 0
```

### Build

Command:

```bash
npm run build
```

Result:

```text
> ethra-harbor-indexer@0.1.0 build
> tsc
```

## Files Changed

- `src/db/index.ts`
- `src/db/deposits.ts`
- `test/db.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Self-Review

- Confirmed the schema matches the task brief, including indexes and the unique deposit key.
- Confirmed `cursorId(config)` lowercases the contract address exactly as required.
- Confirmed `getOrCreateCursor` seeds `last_scanned_block` from `config.startBlock`.
- Confirmed `saveDepositsAndCursor` uses one SQLite transaction and `INSERT OR IGNORE` for duplicate deposit events.
- Confirmed `recordCrawlError` persists the requested crawl error shape.

## Concerns

- Test command output in this environment includes `stty: stdin isn't a terminal` before the normal script output. It did not affect exit codes, test execution, or build results.
