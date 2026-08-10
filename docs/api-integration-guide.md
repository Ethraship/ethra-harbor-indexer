# API Integration Guide

Last updated: 2026-08-11

This guide is written for AI agents and service clients that consume the Ethra
Harbor Indexer API. Public routes are read-only JSON over HTTP and expose
indexed metrics for one Base Morpho Vault V2:

`0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`

The default local base URL is:

```text
http://127.0.0.1:8080
```

The API is available when `API_ENABLED` is not `false`. The listen port is
configured with `API_PORT`.

## Integration Rules For AI Clients

- Use `GET` for public health, vault, account, and dashboard routes. Non-GET
  requests to those routes return `404`.
- Optional `/admin/*` routes are separate operator endpoints; they are available
  only when `ADMIN_API_TOKEN` is non-empty and require `Authorization: Bearer
  <token>`.
- Send no request body to public GET routes. Query parameters are ignored by
  the current public handlers.
- Treat every raw token, share, and fee amount as an integer string. Parse these
  fields with `BigInt`, arbitrary-precision decimal math, or keep them as
  strings. Do not parse them as JavaScript `number`.
- Treat block numbers and timestamps as JSON numbers or `null`.
- Expect `null` for valuation-dependent fields until the indexer has an
  eligible share-price snapshot.
- Unknown but valid wallet addresses return `200` with zero metrics.
- Invalid wallet addresses return `400` with `{ "error": "invalid address" }`.
- Public request handlers read from SQLite only and do not make live RPC calls.
  Admin mutations write local reward tables only; they never submit chain
  transactions.

## Units And Formatting

| Field kind | API representation | Human display |
| --- | --- | --- |
| USDC / underlying asset raw values | base-10 string | divide by `1e6` |
| Vault share raw values | base-10 string | divide by `1e18` |
| Basis points | base-10 string | divide by `100` for percent |
| Blocks | number or `null` | display as integer |
| `valuationTime` | number or `null` | Unix millisecond capture time from the local snapshotter |

Fields named `raw`, `valueRaw`, `totalAssetsRaw`, or similar are exact integer
strings. They intentionally avoid JSON floating-point precision loss.

## Endpoint Summary

| Method | Path | Status | Content type | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | `200` | `application/json` | Service and crawler freshness |
| `GET` | `/vault` | `200` | `application/json` | Vault-level supply, valuation, share price, and fee totals |
| `GET` | `/accounts/:address` | `200` or `400` | `application/json` | Metrics for one wallet address |
| `PUT` | `/admin/boost/base` | `200`, `400`, `401`, `404`, `409`, or `500` | `application/json` | Authenticated local base-boost mutation (token required) |
| `PUT` | `/admin/boost/wallets/:address` | `200`, `400`, `401`, `404`, `409`, or `500` | `application/json` | Authenticated local wallet-boost mutation (token required) |
| `GET` | `/admin/boost/changes` | `200`, `401`, or `404` | `application/json` | Authenticated newest-first boost history (token required) |
| `GET` | `/admin/vship/settlements/:address` | `200`, `400`, `401`, or `404` | `application/json` | Authenticated newest-first settlement history (token required) |
| `GET` | `/dashboard` | `200` | `text/html; charset=utf-8` | Local browser dashboard |
| `GET` | `/dashboard/` | `200` | `text/html; charset=utf-8` | Local browser dashboard |
| `GET` | `/dashboard/styles.css` | `200` | `text/css; charset=utf-8` | Dashboard stylesheet |
| `GET` | `/dashboard/app.js` | `200` | `text/javascript; charset=utf-8` | Dashboard script |

Unknown paths return `404` JSON:

```json
{
  "error": "not found"
}
```

## Type Definitions

Use these TypeScript definitions as the canonical machine-readable output
shapes for JSON routes:

```ts
type IntegerString = string;
type NullableBlock = number | null;
type NullableTimestampMs = number | null;

interface ErrorResponse {
  error: "not found" | "invalid address" | string;
}

interface HealthResponse {
  status: "ok";
  cursorBlock: NullableBlock;
  safeHead: NullableBlock;
  safeHeadKnown: boolean;
  syncedToSafeHead: boolean;
}

interface VaultMetricsResponse {
  totalSupplyRaw: IntegerString;
  totalAssetsRaw: IntegerString | null;
  sharePriceScaledRaw: IntegerString | null;
  sharePriceScale: IntegerString;
  cumulativePerformanceFeeSharesRaw: IntegerString;
  cumulativePerformanceFeeValueRaw: IntegerString | null;
  valuationBlock: NullableBlock;
  valuationTime: NullableTimestampMs;
  blockContext: {
    currentBlock: NullableBlock;
    lastProcessedLogBlock: NullableBlock;
  };
}

interface AccountMetricsResponse {
  address: string;
  activeDeposit: {
    shares: IntegerString;
    valueRaw: IntegerString | null;
  };
  lifetimeDeposited: {
    raw: IntegerString;
  };
  lifetimeWithdrawn: {
    raw: IntegerString;
  };
  lifetimeEarned: {
    raw: IntegerString | null;
  };
  grossLifetimeEarned: {
    raw: IntegerString | null;
  };
  estimatedNetLifetimeEarned: {
    raw: IntegerString | null;
    performanceFeeRateBps: IntegerString;
  };
  estimatedPerformanceFee: {
    raw: IntegerString | null;
  };
  boost: {
    baseBoostBps: IntegerString;
    additionalBoostBps: IntegerString;
    totalBoostBps: IntegerString;
  };
  vship: {
    crystallizedRaw: IntegerString;
    pendingRaw: IntegerString;
    totalRaw: IntegerString;
    feeWatermarkRaw: IntegerString;
    priceUsdRaw: IntegerString;
    priceUsdDecimals: number;
  };
  earnedPerformanceFee: {
    shares: IntegerString;
    valueRaw: IntegerString | null;
  };
  blockContext: {
    currentBlock: NullableBlock;
    lastProcessedLogBlock: NullableBlock;
    lastPerformanceFeeMintBlock: NullableBlock;
    blocksSincePerformanceFeeMint: number | null;
  };
  valuationBlock: NullableBlock;
  valuationTime: NullableTimestampMs;
}
```

## `GET /health`

Returns process-readiness and crawler freshness metadata.

Request:

```sh
curl -sS "http://127.0.0.1:8080/health"
```

Response shape:

```json
{
  "status": "ok",
  "cursorBlock": 48748007,
  "safeHead": 48748007,
  "safeHeadKnown": true,
  "syncedToSafeHead": true
}
```

Field meanings:

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `"ok"` | The HTTP server is running and can read SQLite. |
| `cursorBlock` | `number \| null` | Last block whose vault logs were persisted. `null` before a cursor row exists. |
| `safeHead` | `number \| null` | Latest crawler-observed `chainHead - CONFIRMATIONS`. `null` until the crawler observes head state. |
| `safeHeadKnown` | `boolean` | `true` when `safeHead` is not `null`. |
| `syncedToSafeHead` | `boolean` | `true` when both cursor and safe head are known and `cursorBlock >= safeHead`. |

Freshly migrated database example:

```json
{
  "status": "ok",
  "cursorBlock": null,
  "safeHead": null,
  "safeHeadKnown": false,
  "syncedToSafeHead": false
}
```

AI integration note: use `/health` before interpreting financial fields. A
response with `status: "ok"` means the read API is alive; it does not
necessarily mean the indexer is caught up. Prefer `syncedToSafeHead === true`
when presenting fresh user-facing answers.

## `GET /vault`

Returns vault-level indexed state plus the latest cursor-eligible valuation
snapshot.

Request:

```sh
curl -sS "http://127.0.0.1:8080/vault"
```

Response shape with an eligible snapshot:

```json
{
  "totalSupplyRaw": "2000000000000000000",
  "totalAssetsRaw": "3000000",
  "sharePriceScaledRaw": "1500000",
  "sharePriceScale": "1000000000000000000",
  "cumulativePerformanceFeeSharesRaw": "500000000000000000",
  "cumulativePerformanceFeeValueRaw": "750000",
  "valuationBlock": 48700010,
  "valuationTime": 1712345600000,
  "blockContext": {
    "currentBlock": 48700010,
    "lastProcessedLogBlock": 48700010
  }
}
```

Response shape before an eligible snapshot exists:

```json
{
  "totalSupplyRaw": "0",
  "totalAssetsRaw": null,
  "sharePriceScaledRaw": null,
  "sharePriceScale": "1000000000000000000",
  "cumulativePerformanceFeeSharesRaw": "0",
  "cumulativePerformanceFeeValueRaw": null,
  "valuationBlock": null,
  "valuationTime": null,
  "blockContext": {
    "currentBlock": null,
    "lastProcessedLogBlock": null
  }
}
```

Field meanings:

| Field | Type | Meaning |
| --- | --- | --- |
| `totalSupplyRaw` | string | Current indexed vault share supply from processed `Transfer` logs. Raw shares use 18 decimals. |
| `totalAssetsRaw` | string or `null` | Vault assets from the selected valuation snapshot after replaying already-processed vault-total logs through `valuationBlock`. Raw USDC uses 6 decimals. |
| `sharePriceScaledRaw` | string or `null` | `floor(totalAssetsRaw * sharePriceScale / totalSupplyRaw)`, or `"0"` when snapshot supply is zero. Display it as raw USDC per one whole vault share. |
| `sharePriceScale` | string | Current share-price scale, always `"1000000000000000000"`. |
| `cumulativePerformanceFeeSharesRaw` | string | Cumulative indexed performance-fee shares minted by `AccrueInterest`. |
| `cumulativePerformanceFeeValueRaw` | string or `null` | Adjusted valuation value of cumulative performance-fee shares in raw USDC. |
| `valuationBlock` | number or `null` | Effective block used for valuation. It starts from the newest cursor-eligible snapshot and may advance through already-processed logs after that snapshot. It is never ahead of `lastProcessedLogBlock`. |
| `valuationTime` | number or `null` | Local capture time for the base valuation snapshot, in Unix milliseconds. |
| `blockContext.currentBlock` | number or `null` | Newest observed snapshot block, including snapshots not yet eligible for valuation. |
| `blockContext.lastProcessedLogBlock` | number or `null` | Persisted vault crawler cursor. |

Freshness rule: valuation starts with the newest share-price snapshot whose
block is less than or equal to `blockContext.lastProcessedLogBlock`, then
replays already-processed vault-total logs after that snapshot. If
`blockContext.currentBlock` is ahead of `valuationBlock`, the snapshotter has
observed a newer block that is not yet part of the stable adjusted valuation.

## `GET /accounts/:address`

Returns per-wallet position, lifetime activity, earned performance fee, gross
yield, estimated net yield, and freshness metadata.

Request:

```sh
ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111"
curl -sS "http://127.0.0.1:8080/accounts/${ACCOUNT_ADDRESS}"
```

The `:address` path segment must be an Ethereum address accepted by
`ethers.getAddress`. Lowercase addresses are accepted. Mixed-case addresses must
have a valid checksum. The response `address` is the normalized address used for
the lookup.

Response shape with an eligible snapshot:

```json
{
  "address": "0x1111111111111111111111111111111111111111",
  "activeDeposit": {
    "shares": "1000000000000000000",
    "valueRaw": "1375000"
  },
  "lifetimeDeposited": {
    "raw": "1000000"
  },
  "lifetimeWithdrawn": {
    "raw": "200000"
  },
  "lifetimeEarned": {
    "raw": "575000"
  },
  "grossLifetimeEarned": {
    "raw": "1150000"
  },
  "estimatedNetLifetimeEarned": {
    "raw": "575000",
    "performanceFeeRateBps": "5000"
  },
  "estimatedPerformanceFee": {
    "raw": "575000"
  },
  "boost": {
    "baseBoostBps": "40000",
    "additionalBoostBps": "0",
    "totalBoostBps": "40000"
  },
  "vship": {
    "crystallizedRaw": "0",
    "pendingRaw": "46000000",
    "totalRaw": "46000000",
    "feeWatermarkRaw": "0",
    "priceUsdRaw": "50000",
    "priceUsdDecimals": 6
  },
  "earnedPerformanceFee": {
    "shares": "300000000000000000",
    "valueRaw": "450000"
  },
  "blockContext": {
    "currentBlock": 48700010,
    "lastProcessedLogBlock": 48700010,
    "lastPerformanceFeeMintBlock": null,
    "blocksSincePerformanceFeeMint": null
  },
  "valuationBlock": 48700010,
  "valuationTime": 1712345600000
}
```

Response shape before an eligible snapshot exists:

```json
{
  "address": "0x1111111111111111111111111111111111111111",
  "activeDeposit": {
    "shares": "250000000000000000",
    "valueRaw": null
  },
  "lifetimeDeposited": {
    "raw": "400000"
  },
  "lifetimeWithdrawn": {
    "raw": "100000"
  },
  "lifetimeEarned": {
    "raw": null
  },
  "grossLifetimeEarned": {
    "raw": null
  },
  "estimatedNetLifetimeEarned": {
    "raw": null,
    "performanceFeeRateBps": "5000"
  },
  "estimatedPerformanceFee": {
    "raw": null
  },
  "boost": {
    "baseBoostBps": "40000",
    "additionalBoostBps": "0",
    "totalBoostBps": "40000"
  },
  "vship": {
    "crystallizedRaw": "0",
    "pendingRaw": "0",
    "totalRaw": "0",
    "feeWatermarkRaw": "0",
    "priceUsdRaw": "50000",
    "priceUsdDecimals": 6
  },
  "earnedPerformanceFee": {
    "shares": "60000000000000000",
    "valueRaw": null
  },
  "blockContext": {
    "currentBlock": null,
    "lastProcessedLogBlock": 48578254,
    "lastPerformanceFeeMintBlock": null,
    "blocksSincePerformanceFeeMint": null
  },
  "valuationBlock": null,
  "valuationTime": null
}
```

Unknown valid account example with an eligible snapshot:

```json
{
  "address": "0x2222222222222222222222222222222222222222",
  "activeDeposit": {
    "shares": "0",
    "valueRaw": "0"
  },
  "lifetimeDeposited": {
    "raw": "0"
  },
  "lifetimeWithdrawn": {
    "raw": "0"
  },
  "lifetimeEarned": {
    "raw": "0"
  },
  "grossLifetimeEarned": {
    "raw": "0"
  },
  "estimatedNetLifetimeEarned": {
    "raw": "0",
    "performanceFeeRateBps": "5000"
  },
  "estimatedPerformanceFee": {
    "raw": "0"
  },
  "boost": {
    "baseBoostBps": "40000",
    "additionalBoostBps": "0",
    "totalBoostBps": "40000"
  },
  "vship": {
    "crystallizedRaw": "0",
    "pendingRaw": "0",
    "totalRaw": "0",
    "feeWatermarkRaw": "0",
    "priceUsdRaw": "50000",
    "priceUsdDecimals": 6
  },
  "earnedPerformanceFee": {
    "shares": "0",
    "valueRaw": "0"
  },
  "blockContext": {
    "currentBlock": 48700010,
    "lastProcessedLogBlock": 48700010,
    "lastPerformanceFeeMintBlock": null,
    "blocksSincePerformanceFeeMint": null
  },
  "valuationBlock": 48700010,
  "valuationTime": 1712345600000
}
```

Field meanings:

| Field | Type | Meaning |
| --- | --- | --- |
| `address` | string | Normalized Ethereum address used for lookup. |
| `activeDeposit.shares` | string | Current indexed vault share balance in raw 18-decimal shares. |
| `activeDeposit.valueRaw` | string or `null` | Estimated net USDC value of the active position: principal still in the vault plus estimated user-kept net earnings, or the lower snapshot share value when the position is below principal. |
| `lifetimeDeposited.raw` | string | Cumulative raw USDC deposited on behalf of this address. |
| `lifetimeWithdrawn.raw` | string | Cumulative raw USDC withdrawn on behalf of this address. |
| `lifetimeEarned.raw` | string or `null` | Estimated user-kept net earned amount. It matches `estimatedNetLifetimeEarned.raw` and is `0` when the position is below principal. |
| `grossLifetimeEarned.raw` | string or `null` | Gross generated yield before the modeled performance-fee split. |
| `estimatedNetLifetimeEarned.raw` | string or `null` | Estimated user-kept net earned amount after applying `performanceFeeRateBps` to gross lifetime earned. |
| `estimatedNetLifetimeEarned.performanceFeeRateBps` | string | Current single-vault performance fee rate used by the API, currently `"5000"`. |
| `estimatedPerformanceFee.raw` | string or `null` | `grossLifetimeEarned.raw - estimatedNetLifetimeEarned.raw`. |
| `boost.baseBoostBps` | string | Indexer-wide base boost; defaults to `"40000"` (4x). |
| `boost.additionalBoostBps` | string | Per-wallet additive boost; missing wallet state is `"0"`. |
| `boost.totalBoostBps` | string | `baseBoostBps + additionalBoostBps`. |
| `vship.crystallizedRaw` | string | vSHIP already crystallized by an authenticated boost change settlement. |
| `vship.pendingRaw` | string | vSHIP estimated from the positive fee delta above `feeWatermarkRaw` at the current total boost. It is `"0"` when valuation is unavailable or the fee dips. |
| `vship.totalRaw` | string | `crystallizedRaw + pendingRaw`. |
| `vship.feeWatermarkRaw` | string | Sticky estimated-performance-fee watermark used for soft crystallization; it never decreases on a fee dip. |
| `vship.priceUsdRaw` | string | Fixed seeded vSHIP price, `"50000"` raw USD units at 6 decimals (`$0.05`). There is no admin price route. |
| `vship.priceUsdDecimals` | number | Decimal places for `priceUsdRaw`, currently `6`. |
| `earnedPerformanceFee.shares` | string | Crystallized performance-fee shares attributed to this account, including read-time settlement against the current indexed global fee index. |
| `earnedPerformanceFee.valueRaw` | string or `null` | Adjusted valuation value of `earnedPerformanceFee.shares` in raw USDC. |
| `blockContext.currentBlock` | number or `null` | Newest observed snapshot block. |
| `blockContext.lastProcessedLogBlock` | number or `null` | Persisted vault crawler cursor used to gate valuation. |
| `blockContext.lastPerformanceFeeMintBlock` | number or `null` | Latest processed `AccrueInterest` block with nonzero performance-fee shares. |
| `blockContext.blocksSincePerformanceFeeMint` | number or `null` | Freshest local block reference minus `lastPerformanceFeeMintBlock`, using the greater of `currentBlock` and `lastProcessedLogBlock` when both exist. |
| `valuationBlock` | number or `null` | Effective block used for valuation. It starts from a cursor-eligible snapshot and may advance through already-processed logs after that snapshot. |
| `valuationTime` | number or `null` | Local capture time for the base valuation snapshot, in Unix milliseconds. |

AI integration note: use `activeDeposit.valueRaw` for the user's current active
deposit and `estimatedNetLifetimeEarned.raw` or `lifetimeEarned.raw` for
user-kept earnings language. `grossLifetimeEarned.raw` is only supporting
analytics for explaining yield before the modeled performance-fee split. Treat
vSHIP as indexer accounting, not an on-chain mint or a dashboard balance.

## Optional Admin Routes

Admin routes are registered only when `ADMIN_API_TOKEN` is present and
non-empty. Without a configured token, every `/admin/*` request returns `404`.
When enabled, every admin request requires the exact header
`Authorization: Bearer <token>`; a missing or incorrect token returns `401`.

### `PUT /admin/boost/base`

Body:

```json
{
  "baseBoostBps": "50000"
}
```

`baseBoostBps` must be a non-negative decimal integer string. On a changed
value, the server settles every eligible wallet at the old total boost, writes
the new base value, and records a boost-change event in one SQLite transaction.
An identical value is a no-op. Success returns `200` with
`{ "status": "ok" }`.

### `PUT /admin/boost/wallets/:address`

Body:

```json
{
  "additionalBoostBps": "100000"
}
```

The address must pass `ethers.getAddress`; the value must be a non-negative
decimal integer string. A changed value settles that wallet at the old total
boost before writing the additive boost and audit event. Success returns
`200` with `{ "status": "ok" }`.

Both mutation routes require all of the following readiness conditions:

- a crawler-observed safe head exists;
- the persisted cursor is at or beyond that safe head; and
- a usable cursor-eligible valuation snapshot exists.

If any condition is missing, the response is `409` with
`{ "error": "indexer not ready" }`. A second `409` gate rejects mutations when
the freshest local block reference is at least `fee_mint_stale_blocks` blocks
after the latest nonzero performance-fee mint. The default threshold is
`20000`, and the stale response is `{ "error": "fee mint is stale" }`. Invalid
bodies or addresses return `400`; unexpected SQLite/transaction errors return
`500` with `{ "error": "internal server error" }` and roll back all reward
writes.

### `GET /admin/boost/changes`

Returns newest-first boost-change rows. `oldBps` and `newBps` are decimal
strings; `address` is `null` for a base change. Example:

```json
[
  {
    "id": 2,
    "changedAt": 1712345600000,
    "changeType": "wallet_additional",
    "address": "0x1111111111111111111111111111111111111111",
    "oldBps": "0",
    "newBps": "100000",
    "actor": "admin",
    "settledWalletCount": 1
  }
]
```

### `GET /admin/vship/settlements/:address`

Returns newest-first positive fee-delta settlement rows for the normalized
address. `feeBeforeRaw`, `feeAfterRaw`, `feeDeltaRaw`, `boostBpsApplied`,
`vshipMintedRaw`, and `crystallizedVshipAfterRaw` are all decimal strings. A
zero fee delta updates sticky state if needed but does not create a settlement
history row.

These admin routes are local indexer controls and history reads only. They do
not move the Morpho position, wire the dashboard, submit on-chain transactions,
or change the fixed vSHIP price.

## Error Responses

Invalid account address:

```sh
curl -sS -i "http://127.0.0.1:8080/accounts/not-an-address"
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": "invalid address"
}
```

Unknown route:

```sh
curl -sS -i "http://127.0.0.1:8080/does-not-exist"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": "not found"
}
```

Non-GET method:

```sh
curl -sS -i -X POST "http://127.0.0.1:8080/health"
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": "not found"
}
```

Admin disabled:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": "not found"
}
```

Admin authentication failure:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "error": "unauthorized"
}
```

## Suggested Client Logic

For an AI agent answering wallet questions:

1. Call `GET /health`.
2. If `syncedToSafeHead` is `false`, mention that indexed data may still be
   catching up.
3. Call `GET /accounts/:address`.
4. If valuation fields are `null`, answer only with raw share, deposit, and
   withdrawal facts; explain that no eligible valuation snapshot exists yet.
5. If valuation fields are present, use `estimatedNetLifetimeEarned.raw` for
   estimated net earnings and include `valuationBlock` as freshness context.

For vault-wide status:

1. Call `GET /health`.
2. Call `GET /vault`.
3. Use `totalAssetsRaw`, `totalSupplyRaw`, `sharePriceScaledRaw`, and
   `valuationBlock` together. Do not combine a newer `currentBlock` with older
   valuation fields.

## JavaScript Parsing Example

```js
const USDC_DECIMALS = 6n;

function parseIntegerString(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error("expected integer string");
  }
  return BigInt(value);
}

function formatRawUsdc(raw) {
  if (raw === null) {
    return "not valued yet";
  }

  const value = parseIntegerString(raw);
  const scale = 10n ** USDC_DECIMALS;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(Number(USDC_DECIMALS), "0");
  return `${whole}.${fraction} USDC`;
}

async function getAccountMetrics(baseUrl, address) {
  const response = await fetch(`${baseUrl}/accounts/${address}`);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error ?? `API error ${response.status}`);
  }

  return {
    address: body.address,
    activeSharesRaw: parseIntegerString(body.activeDeposit.shares),
    estimatedNetEarned: formatRawUsdc(body.estimatedNetLifetimeEarned.raw),
    valuationBlock: body.valuationBlock,
  };
}
```

## Static Dashboard Endpoints

The dashboard routes are included for completeness but are not part of the JSON
integration contract:

- `GET /dashboard`
- `GET /dashboard/`
- `GET /dashboard/styles.css`
- `GET /dashboard/app.js`

The static server uses a fixed asset map and is not a general file server.
