# Admin CSV Bulk Wallet Boost Design

Date: 2026-08-11

## Goal

Let a local operator upload a CSV of `wallet,boost` rows on `/admin` and apply
each row via the existing authenticated single-wallet boost PUT — no new bulk
API.

## Decisions

- **Approach:** client-side loop over `PUT /admin/boost/wallets/:address`
  (Option A). No backend, DB, or settle changes.
- **Branch:** implement on the current branch; do not create a new branch.
- **CSV format:** strict only — exact header `wallet,boost`, exactly two
  columns, no header aliases.
- **Preflight:** validate the entire CSV before any PUT. On any validation
  error, reject the whole file and apply nothing.
- **Duplicates:** case-insensitive duplicate wallets fail the whole file.
- **Live failures:** after PUTs start, continue on API/network errors and show
  a per-row success/fail summary.
- **Auth:** reuse the top-of-page API key via existing `fetchJsonWithApiKey`.

## Scope

### In scope

- New admin panel: file input + Apply
- Client CSV parse + full-file validation
- Sequential PUTs with progress text
- Per-row result summary
- Short `docs/evolution.md` note at ship time

### Out of scope

- New bulk / batch mutation endpoint
- Preview/edit grid, drag-drop polish
- Auto-refresh of the “Wallet additional boosts” list after apply
- Backend or automated UI tests (manual admin check is enough)

## CSV contract

```csv
wallet,boost
0xabc...,100000
0xdef...,0
```

- Header must be exactly `wallet,boost` (no extra columns, no aliases).
- Each data row: exactly two fields after trim.
- `wallet`: non-empty `0x…` string (lightweight client check; server still
  runs `getAddress`).
- `boost`: non-negative integer digit string (same shape as the single-wallet
  form / API).
- Blank lines: treat as invalid (fail whole file) or strip only fully empty
  trailing lines — prefer **fail if any blank data line appears** so operators
  see dirty files early.
- Duplicate `wallet` values compared case-insensitively → fail whole file.
- Empty file or header-only with no data rows → fail (nothing to apply).

## Apply flow

1. Require API key; if missing, show “Enter an API key first.” and do not
   apply.
2. Read selected `.csv` file as text.
3. Parse and validate all rows. On failure: show validation error; **zero**
   PUTs.
4. Disable Apply; show progress `Applying i/n`.
5. For each valid row, in order:
   `PUT /admin/boost/wallets/:address` with
   `{ "additionalBoostBps": "<boost>" }` and Bearer token.
6. On live failure for a row: record error; **continue**.
7. Re-enable Apply; show summary (success count, fail count, per-row status).

Each successful PUT keeps existing settle, readiness, stale-fee, and audit
behavior (one settle + one boost-change event per changed wallet).

## UI (`/admin`)

New panel near the single “Change wallet additional boost” form:

- Heading + short copy: CSV must be `wallet,boost`; uses page API key
- `<input type="file" accept=".csv,text/csv">` + **Apply** button
- Panel error line for validation / missing key
- Result area: idle “No request yet.” → after run, summary + simple table
  (row # | wallet | boost | status/error)

Match existing admin panel styling (`panel`, `button`, `error-text`,
`empty-state`).

## Error handling

| Case | Behavior |
|------|----------|
| No API key | Client error; no apply |
| Missing/invalid CSV shape, bad row, duplicates | Stop before any PUT; show message |
| PUT 401 / 409 / 400 / network | Mark that row failed; continue others |
| All succeed | Summary with success count only |

## Testing

- No new backend tests (API path unchanged).
- Manual: valid CSV applies; invalid header / duplicate / bad boost blocked
  with no partial applies; forced mid-run API failure continues and reports
  the failed row.

## File touch list

- `public/admin.html` — panel markup
- `public/admin.js` — parse, validate, loop, summary UI
- `docs/evolution.md` — at implement time

## Success criteria

- Operator can upload a strict `wallet,boost` CSV and apply boosts without a
  new API.
- Invalid CSVs never send PUTs.
- Live mid-run failures do not abort the rest of the file; results show which
  rows failed.
