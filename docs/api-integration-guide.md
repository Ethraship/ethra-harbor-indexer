# API Integration Guide

Last updated: 2026-07-18

This guide is written for AI agents and service clients that consume the Ethra
Harbor Indexer API. The API is read-only, JSON over HTTP, and exposes indexed
metrics for one Base Morpho Vault V2:

`0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`

The default local base URL is:

```text
http://127.0.0.1:8080
```

The API is available when `API_ENABLED` is not `false`. The listen port is
configured with `API_PORT`.

## Integration Rules For AI Clients

- Use `GET` only. Non-GET requests return `404`.
- Send no request body. Query parameters are ignored by the current handlers.
- Treat every raw token, share, and fee amount as an integer string. Parse these
  fields with `BigInt`, arbitrary-precision decimal math, or keep them as
  strings. Do not parse them as JavaScript `number`.
- Treat block numbers and timestamps as JSON numbers or `null`.
- Expect `null` for valuation-dependent fields until the indexer has an
  eligible share-price snapshot.
- Unknown but valid wallet addresses return `200` with zero metrics.
- Invalid wallet addresses return `400` with `{ "error": "invalid address" }`.
- The API reads from SQLite only. Request handlers do not make live RPC calls.

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
| `totalAssetsRaw` | string or `null` | Vault `totalAssets()` from the selected valuation snapshot. Raw USDC uses 6 decimals. |
| `sharePriceScaledRaw` | string or `null` | `floor(totalAssetsRaw * sharePriceScale / totalSupplyRaw)`, or `"0"` when snapshot supply is zero. Display it as raw USDC per one whole vault share. |
| `sharePriceScale` | string | Current share-price scale, always `"1000000000000000000"`. |
| `cumulativePerformanceFeeSharesRaw` | string | Cumulative indexed performance-fee shares minted by `AccrueInterest`. |
| `cumulativePerformanceFeeValueRaw` | string or `null` | Snapshot value of cumulative performance-fee shares in raw USDC. |
| `valuationBlock` | number or `null` | Snapshot block used for valuation. It is never ahead of `lastProcessedLogBlock`. |
| `valuationTime` | number or `null` | Local capture time for the valuation snapshot, in Unix milliseconds. |
| `blockContext.currentBlock` | number or `null` | Newest observed snapshot block, including snapshots not yet eligible for valuation. |
| `blockContext.lastProcessedLogBlock` | number or `null` | Persisted vault crawler cursor. |

Freshness rule: valuation uses the newest share-price snapshot whose block is
less than or equal to `blockContext.lastProcessedLogBlock`. If
`blockContext.currentBlock` is ahead of `valuationBlock`, the snapshotter has
observed a newer block that the crawler has not fully indexed yet.

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
    "valueRaw": "1500000"
  },
  "lifetimeDeposited": {
    "raw": "1000000"
  },
  "lifetimeWithdrawn": {
    "raw": "200000"
  },
  "lifetimeEarned": {
    "raw": "700000"
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
| `activeDeposit.valueRaw` | string or `null` | Snapshot value of active shares in raw USDC. |
| `lifetimeDeposited.raw` | string | Cumulative raw USDC deposited on behalf of this address. |
| `lifetimeWithdrawn.raw` | string | Cumulative raw USDC withdrawn on behalf of this address. |
| `lifetimeEarned.raw` | string or `null` | Mark-to-market earned amount: `max(0, activeDeposit.valueRaw + lifetimeWithdrawn.raw - lifetimeDeposited.raw)`. |
| `grossLifetimeEarned.raw` | string or `null` | `lifetimeEarned.raw + earnedPerformanceFee.valueRaw`. |
| `estimatedNetLifetimeEarned.raw` | string or `null` | Estimated user-kept net earned amount after applying `performanceFeeRateBps` to gross lifetime earned. |
| `estimatedNetLifetimeEarned.performanceFeeRateBps` | string | Current single-vault performance fee rate used by the API, currently `"5000"`. |
| `estimatedPerformanceFee.raw` | string or `null` | `grossLifetimeEarned.raw - estimatedNetLifetimeEarned.raw`. |
| `earnedPerformanceFee.shares` | string | Crystallized performance-fee shares attributed to this account, including read-time settlement against the current indexed global fee index. |
| `earnedPerformanceFee.valueRaw` | string or `null` | Snapshot value of `earnedPerformanceFee.shares` in raw USDC. |
| `blockContext.currentBlock` | number or `null` | Newest observed snapshot block. |
| `blockContext.lastProcessedLogBlock` | number or `null` | Persisted vault crawler cursor used to gate valuation. |
| `blockContext.lastPerformanceFeeMintBlock` | number or `null` | Latest processed `AccrueInterest` block with nonzero performance-fee shares. |
| `blockContext.blocksSincePerformanceFeeMint` | number or `null` | `currentBlock - lastPerformanceFeeMintBlock` when both values exist. |
| `valuationBlock` | number or `null` | Snapshot block used for valuation. |
| `valuationTime` | number or `null` | Local capture time for the valuation snapshot, in Unix milliseconds. |

AI integration note: prefer `estimatedNetLifetimeEarned.raw` for user-kept
earnings language. `grossLifetimeEarned.raw` is useful for explaining the gross
yield before the modeled performance-fee split. `lifetimeEarned.raw` is kept for
backward compatibility and mark-to-market analytics.

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
