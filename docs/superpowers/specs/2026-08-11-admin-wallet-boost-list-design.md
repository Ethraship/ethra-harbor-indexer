# Admin Wallet Boost List Design

Date: 2026-08-11

## Goal

Give local operators an on-demand admin view of every wallet that currently
has a non-zero additional boost, plus a one-click Remove action that clears
that wallet’s additional boost using the existing authenticated PUT path.

## Decisions

- List is a **public** `GET` (no API key), same trust model as
  `GET /admin/boost/changes`.
- Remove **requires** the top-of-page API key and reuses
  `PUT /admin/boost/wallets/:address` with `{ "additionalBoostBps": "0" }`.
  No new mutation endpoint.
- UI approach: small list API + admin panel table with per-row Remove
  (not raw JSON dump, not inferred from boost-change history).

## Scope

### In scope

- `GET /admin/boost/wallets` returning address + additional boost bps
- DB helper to list non-zero `wallet_boost` rows
- Admin page panel: Load on demand, table, Remove quick action
- Focused API tests for the list filter
- Docs updates (`architecture`, `evolution`) at implementation time

### Out of scope

- New DELETE route
- Deleting `wallet_boost` rows when clearing to zero (upsert `"0"` stays)
- Bulk remove
- Auth on the list GET
- Dashboard / overview changes

## API

### `GET /admin/boost/wallets`

- Public (no `Authorization` header).
- Registered only when admin routes are enabled (`ADMIN_API_TOKEN` set),
  consistent with other `/admin/*` routes.
- Response: JSON array of:

```json
[
  {
    "address": "0x...",
    "additionalBoostBps": "100000"
  }
]
```

- Include only rows where additional boost is **greater than zero**.
- `additionalBoostBps` is a decimal string (no floats).
- Sort by `address` ascending for stable UI.
- Empty array when none.

### Remove (existing)

- `PUT /admin/boost/wallets/:address` with
  `{ "additionalBoostBps": "0" }` and `Authorization: Bearer <token>`.
- Keeps existing settle, readiness, stale-fee, and audit behavior.

## Data layer

Add `listWalletBoosts(db)` in `src/db/rewards.ts`:

- Read from `wallet_boost`.
- Filter with `CAST(additional_boost_bps AS INTEGER) > 0` (values are
  non-negative digit strings; bps fit SQLite integer range).
- Order by `address ASC`.
- Return `{ address, additionalBoostBps: bigint }` for the admin handler to
  serialize as strings.

Zero rows remain in the table after clear; the list simply omits them.

## Admin UI (`/admin`)

New panel matching “Boost changes” layout:

- Heading + **Load** button; nothing fetched until Load.
- After load: table columns — address | additional boost bps | Remove.
- Empty state when the array is empty; panel error line on load failure.
- **Remove**:
  - Requires API key from the top input via existing `fetchJsonWithApiKey`.
  - If key missing, show “Enter an API key first.” and do not call the API.
  - On success: reload the list via `GET /admin/boost/wallets`.
  - On failure: show the error; keep the current table.

## Error handling

| Case | Behavior |
|------|----------|
| List request fails | Panel error text; keep prior table content if any |
| Remove without API key | Client-side error; no network call |
| Remove 401 / 409 / 400 | Show server `error` message; table unchanged |
| Remove success | Reload list so cleared wallets disappear |

## Testing

- API: seed wallets with positive additional boost and one with `"0"`;
  `GET /admin/boost/wallets` returns only positives, sorted by address,
  bps as strings.
- Rely on existing PUT-to-zero coverage for the remove settle/audit path.
- Optional thin UI smoke not required; keep verification on API + manual
  admin page check.

## File touch list

- `src/db/rewards.ts` — `listWalletBoosts`
- `src/api/admin.ts` — `GET /admin/boost/wallets`
- `public/admin.html` — panel markup
- `public/admin.js` — load + remove handlers
- `test/api.test.ts` — list coverage
- `docs/architecture.md`, `docs/evolution.md` — at implement time

## Success criteria

- Operator can Load and see every wallet with non-zero additional boost.
- Operator can Remove one wallet with the page API key without typing the
  address into the wallet-boost form.
- After a successful Remove, the reloaded list omits that wallet and it no
  longer receives additional boost.
