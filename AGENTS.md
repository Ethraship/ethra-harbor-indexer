# Ethra Harbor Indexer Codex Instructions

These instructions apply to every Codex interaction in this repository.

## Product Reference

- Treat `docs/overview.md` as the source of truth for product intent and scope.
- If `docs/overview.md` is missing or stale, create or update it before relying on a substitute product brief.
- Use the existing indexer research docs as supporting context, not as a replacement for the overview.

## Project Shape

This is a Node.js backend indexer, not a mobile or frontend app.

- Use the repo's TypeScript, CommonJS, `ethers`, `better-sqlite3`, and `node:test` patterns.
- Keep runtime behavior backend-oriented: HTTP RPC crawling, SQLite persistence, structured logging, and explicit environment configuration.
- Do not add React Native, Expo, navigation, redux-persist, CIFER SDK, wallet UX, or frontend/mobile assumptions unless the user explicitly changes the project scope.
- Do not create module docs under `docs/modules/`; this project uses project-level docs instead.

## Planning

Whenever producing or executing a new development plan, make the final step: save the complete plan to `docs/plans/` as a Markdown file.

- Exception: targeted bug fixes do not require a saved plan. For bug fixes, update `docs/evolution.md` when the change is substantive; no `docs/plans/` entry is needed.
- Use a descriptive kebab-case name, optionally with a date prefix, such as `docs/plans/2026-07-16-fee-attribution-indexer.md`.
- The saved plan should match what was agreed or executed, including steps, decisions, and file touch list when relevant.
- Plans must be production-ready by default: declare real runtime dependencies, avoid silent runtime fallbacks for missing shipped integrations, and keep test-only shims or mocks explicitly separated from production behavior.

## Change History

After substantive changes, append a short entry to `docs/evolution.md` with date, area touched, what changed, and why. This applies to features, behavior changes, data model changes, indexing semantics, environment/config changes, security-relevant config, and notable refactors.

## Architecture

Keep `docs/architecture.md` up to date with the running backend: stack, layers, trust boundaries, database ownership, RPC/provider behavior, indexing flow, scheduler behavior, and operational assumptions. Revise it when flows or structure change.

## Dev Stage: Database Resets

This app is in early development and has no real user data yet.

- Backward-compatible data migrations are not required at this stage.
- When the SQLite schema or indexed state shape changes, prefer a clear nuke/reset path over compatibility branches for old local databases.
- Destructive schema reset code is acceptable for local/dev databases, but make the behavior explicit in the code, README, plan, or evolution entry as appropriate.
- If any shared, remote, production, or user-owned database appears, stop and tell the user explicitly that the data needs to be cleared before the change can ship. Do not silently migrate, reconcile, or delete shared data.
- When in doubt, flag persisted-shape breakage in the plan or review and let the user confirm the nuke before code lands.

This is a shipping-stage rule, not a design philosophy. Revisit it once the app has real users.

## Backend Development

- Keep indexer behavior replayable from chain data wherever practical.
- Preserve deterministic log ordering by `(block_number, transaction_index, log_index)` when indexing or extending event processing.
- Keep environment parsing strict and explicit; fail fast on invalid chain IDs, contract addresses, RPC URLs, and numeric settings.
- Avoid hidden network or provider fallbacks. If multiple RPC URLs are supported, make ordering and failure behavior explicit.
- Store large integer blockchain values as strings or exact integer-compatible types; do not use floating point for token amounts, shares, blocks, or log indexes.
- Add focused parser, repository, crawler, and config tests when changing those surfaces.

## Verification

Before claiming backend changes are complete, run the narrowest meaningful verification for the change:

- `npm test` for behavior changes.
- `npm run build` or `npm run lint` for TypeScript/API-shape changes.
- Targeted `node --import tsx --test ...` commands are fine for small focused fixes, but mention any broader tests that were not run.
