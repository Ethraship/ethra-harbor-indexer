const BPS = 10_000n;

function powerOfTen(decimals: number): bigint {
  let value = 1n;
  for (let i = 0; i < decimals; i += 1) value *= 10n;
  return value;
}

export function calculateVShipRaw(
  feeRaw: bigint,
  boostBps: bigint,
  priceUsdRaw: bigint,
  priceUsdDecimals: number,
  tokenDecimals: number,
  feeDecimals = 6,
): bigint {
  if (feeRaw <= 0n || boostBps < 0n || priceUsdRaw <= 0n) return 0n;
  const numerator =
    feeRaw * boostBps * powerOfTen(priceUsdDecimals) * powerOfTen(tokenDecimals);
  const denominator = powerOfTen(feeDecimals) * BPS * priceUsdRaw;
  return (numerator + denominator / 2n) / denominator;
}
