# API Curl Commands

For the complete response contract, field meanings, nullability, units, and
machine-consumer guidance, see
[`docs/api-integration-guide.md`](api-integration-guide.md).

The Ethra Harbor Indexer API is read-only and returns JSON over HTTP. By
default, the server listens on port `8080` when `API_ENABLED` is not `false`.

```sh
BASE_URL="http://127.0.0.1:8080"
ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111"
```

## Health

Returns service readiness metadata, the current persisted crawler cursor, and
the latest safe head observed by the crawler. `safeHead` is `null` until the
crawler completes its first head read.

```sh
curl -sS "${BASE_URL}/health"
```

Example response:

```json
{
  "status": "ok",
  "cursorBlock": 48578254,
  "safeHead": null,
  "safeHeadKnown": false,
  "syncedToSafeHead": false
}
```

Example response after the crawler has caught up to the latest safe head:

```json
{
  "status": "ok",
  "cursorBlock": 48748007,
  "safeHead": 48748007,
  "safeHeadKnown": true,
  "syncedToSafeHead": true
}
```

## Vault Metrics

Returns vault-level indexed state, latest snapshot valuation, scaled share
price, and cumulative performance-fee totals.

```sh
curl -sS "${BASE_URL}/vault"
```

Example response:

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

When no share-price snapshot exists yet, valuation fields are `null`:

```sh
curl -sS "${BASE_URL}/vault"
```

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

## Account Metrics

Returns active deposit, lifetime deposit and withdrawal totals, lifetime earned,
earned performance fee, and valuation metadata for one checksum-valid wallet
address. Unknown valid accounts return zero metrics with status `200`.

```sh
curl -sS "${BASE_URL}/accounts/${ACCOUNT_ADDRESS}"
```

Example response:

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

When no share-price snapshot exists yet, valuation-dependent fields are `null`:

```sh
curl -sS "${BASE_URL}/accounts/${ACCOUNT_ADDRESS}"
```

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

## Error Responses

Invalid account addresses return `400`.

```sh
curl -sS -i "${BASE_URL}/accounts/not-an-address"
```

```json
{
  "error": "invalid address"
}
```

Unknown routes return `404`.

```sh
curl -sS -i "${BASE_URL}/does-not-exist"
```

```json
{
  "error": "not found"
}
```

Non-GET methods also return `404`.

```sh
curl -sS -i -X POST "${BASE_URL}/health"
```

```json
{
  "error": "not found"
}
```
