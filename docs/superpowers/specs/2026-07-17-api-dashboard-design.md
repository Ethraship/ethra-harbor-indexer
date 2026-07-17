# API Dashboard Design

Date: 2026-07-17

## Goal

Add a lightweight HTML/CSS/JavaScript dashboard to the existing backend so an
operator can inspect the three read-only API routes from a browser:

- `GET /health`
- `GET /vault`
- `GET /accounts/:address`

The dashboard must let the operator enter a wallet address, click a button, and
see account metrics without adding a frontend framework or changing the backend
from a Node.js indexer into a web app.

## Architecture

The existing `node:http` API server will serve static dashboard assets from a
small `public/` directory. `GET /dashboard` and `GET /dashboard/` return the
HTML entry point. Static files under `/dashboard/...` return CSS and JavaScript
with explicit content types. The browser JavaScript calls the existing same-
origin JSON endpoints and renders health, vault, and account state.

No API writes are introduced. The existing JSON endpoints remain unchanged.

## Components

- `public/dashboard.html`
  - Dashboard shell and semantic markup.
  - Health and vault sections render on load.
  - Account section contains address input, lookup button, status area, and
    result panels.
- `public/dashboard.css`
  - Restrained product-dashboard styling.
  - Responsive layout for desktop and mobile.
  - Clear loading, error, empty, and success states.
- `public/dashboard.js`
  - Fetches `/health` and `/vault` on load and refresh.
  - Fetches `/accounts/:address` on form submit.
  - Formats raw USDC values assuming six decimals.
  - Formats share-like raw values assuming eighteen decimals.
  - Preserves raw values in the UI for auditability.
- `src/api/server.ts`
  - Serves dashboard assets before JSON route matching.
  - Keeps static file lookup constrained to the known dashboard asset map.
- `test/api.test.ts`
  - Adds coverage that `/dashboard` and dashboard static files are served.
  - Confirms unknown dashboard files still return `404`.

## Data Flow

1. The operator opens `/dashboard`.
2. The browser loads `/dashboard/styles.css` and `/dashboard/app.js`.
3. JavaScript fetches `/health` and `/vault` in parallel.
4. The operator enters an Ethereum address and submits the form.
5. JavaScript fetches `/accounts/<encoded-address>`.
6. The UI renders either metrics or the returned error message.

## UI Direction

The dashboard is a task-focused operations surface. It should be readable,
compact, and predictable:

- No hero/marketing page.
- No wallet connection or identity assumptions.
- No extra dependencies or icon libraries.
- Health status should be visible at a glance.
- Vault metrics and account metrics should show readable values plus raw values.
- Account lookup errors should appear inline near the form.

## Error Handling

- Static asset reads are limited to known files. Missing dashboard paths return
  JSON `404`, consistent with current server behavior.
- Dashboard JavaScript catches network and non-OK HTTP responses and renders
  concise inline errors.
- Missing snapshot values render as `Not captured yet`.
- Invalid wallet addresses rely on the existing API's `400 { "error":
  "invalid address" }` response.

## Testing

- Add API route tests before implementation.
- Verify the new tests fail before static serving exists.
- Implement the minimal server changes to pass.
- Run targeted API tests, then `npm test` and `npm run build`.

## Documentation

- Update `README.md` with the `/dashboard` route.
- Update `docs/overview.md` so the product scope includes the bundled local
  dashboard while excluding a separate frontend app.
- Update `docs/architecture.md` because the HTTP API layer now also serves a
  local static dashboard.
- Append a `docs/evolution.md` entry for the dashboard.
