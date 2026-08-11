# Director Overview Dashboard Plan

Date: 2026-08-11

## Goal

Add a director-facing `/overview` analytics page with summary metrics and
simple charts, using existing SQLite data only (no new indexer events/tables).

## Decisions

- New route `/overview` (keep `/dashboard` for tech lookup)
- Metrics: total assets, total deposited, total earned, total wallets
- Charts (last 60 days): assets over time + deposit/withdraw volume
- Top 10 wallets by current position value
- Formatted USDC only in UI (no raw chain values)
- Thin read API aggregates existing rows; volume day buckets estimate event time
  from the latest snapshot `(block, captured_at)` using Base ~2s block time

## Files

- `src/api/overview.ts` — aggregate read helper
- `src/api/queries.ts` — reuse valuation helpers where practical
- `src/api/server.ts` — serve `/overview` assets + `GET /overview/stats`
- `public/overview.html`, `overview.css`, `overview.js`
- `test/api.test.ts` — route + stats coverage
- `docs/overview.md`, `docs/architecture.md`, `docs/evolution.md`

## Steps

1. Implement `getOverviewStats` over existing tables/valuation math
2. Wire static assets and `/overview/stats`
3. Build minimal card/chart UI
4. Add focused API tests and run `npm test`
5. Update product docs
