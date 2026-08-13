import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import { getAccountMetrics, getVaultMetrics } from "./queries";

export const OVERVIEW_WINDOW_DAYS = [7, 30, 90] as const;
export type OverviewWindowDays = (typeof OVERVIEW_WINDOW_DAYS)[number];
export const DEFAULT_OVERVIEW_WINDOW_DAYS: OverviewWindowDays = 7;
export const OVERVIEW_TOP_WALLETS_LIMIT = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BASE_MS_PER_BLOCK = 2000;

export interface OverviewStatsResponse {
  windowDays: OverviewWindowDays;
  totals: {
    totalAssetsRaw: string | null;
    totalDepositedRaw: string;
    totalEarnedRaw: string | null;
    totalWallets: number;
  };
  assetsOverTime: Array<{
    day: string;
    totalAssetsRaw: string;
  }>;
  volumeOverTime: Array<{
    day: string;
    depositedRaw: string;
    withdrawnRaw: string;
  }>;
  topWallets: Array<{
    address: string;
    netValueRaw: string;
  }>;
  valuationBlock: number | null;
  valuationTime: number | null;
}

type AssetFlowEvent = {
  kind: "deposit" | "withdraw" | "accrue";
  blockNumber: number;
  txIndex: number;
  logIndex: number;
  assetsRaw: string | null;
  newTotalAssetsRaw: string | null;
  createdAt: number;
};

export function parseOverviewWindowDays(value: string | null): OverviewWindowDays {
  if (value === null || value.trim() === "") {
    return DEFAULT_OVERVIEW_WINDOW_DAYS;
  }

  const parsed = Number(value);
  if (
    Number.isInteger(parsed) &&
    (OVERVIEW_WINDOW_DAYS as readonly number[]).includes(parsed)
  ) {
    return parsed as OverviewWindowDays;
  }

  throw new Error("invalid windowDays");
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function buildDayRange(nowMs: number, days: number): string[] {
  const keys: string[] = [];
  const start = nowMs - (days - 1) * MS_PER_DAY;

  for (let i = 0; i < days; i += 1) {
    keys.push(dayKey(start + i * MS_PER_DAY));
  }

  return keys;
}

function estimateBlockTimeMs(
  blockNumber: number,
  reference: { blockNumber: number; capturedAt: number } | null,
  createdAt: number,
): number {
  if (reference === null) {
    return createdAt;
  }

  return reference.capturedAt - (reference.blockNumber - blockNumber) * BASE_MS_PER_BLOCK;
}

function compareBigIntDesc(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left > right ? -1 : 1;
}

function subtractNonnegative(left: bigint, right: bigint): bigint {
  return left > right ? left - right : 0n;
}

function readTimeReference(
  db: Database.Database,
): { blockNumber: number; capturedAt: number } | null {
  const snapshot = db
    .prepare(
      `
      SELECT block_number, captured_at
      FROM share_price_snapshots
      ORDER BY block_number DESC, id DESC
      LIMIT 1
    `,
    )
    .get() as { block_number: number; captured_at: number } | undefined;

  if (snapshot !== undefined) {
    return {
      blockNumber: snapshot.block_number,
      capturedAt: snapshot.captured_at,
    };
  }

  return null;
}

function readAssetFlowEvents(db: Database.Database, config: AppConfig): AssetFlowEvent[] {
  const rows = db
    .prepare(
      `
      SELECT
        kind,
        block_number,
        tx_index,
        log_index,
        assets_raw,
        new_total_assets_raw,
        created_at
      FROM (
        SELECT
          'deposit' AS kind,
          block_number,
          tx_index,
          log_index,
          assets AS assets_raw,
          NULL AS new_total_assets_raw,
          created_at
        FROM deposit_events
        WHERE chain_id = ? AND lower(contract_address) = lower(?)

        UNION ALL

        SELECT
          'withdraw' AS kind,
          block_number,
          tx_index,
          log_index,
          assets AS assets_raw,
          NULL AS new_total_assets_raw,
          created_at
        FROM withdraw_events
        WHERE chain_id = ? AND lower(contract_address) = lower(?)

        UNION ALL

        SELECT
          'accrue' AS kind,
          block_number,
          tx_index,
          log_index,
          NULL AS assets_raw,
          new_total_assets AS new_total_assets_raw,
          created_at
        FROM accrue_interest_events
        WHERE chain_id = ? AND lower(contract_address) = lower(?)
      )
      ORDER BY block_number ASC, tx_index ASC, log_index ASC
    `,
    )
    .all(
      config.chainId,
      config.contractAddress,
      config.chainId,
      config.contractAddress,
      config.chainId,
      config.contractAddress,
    ) as Array<{
    kind: "deposit" | "withdraw" | "accrue";
    block_number: number;
    tx_index: number;
    log_index: number;
    assets_raw: string | null;
    new_total_assets_raw: string | null;
    created_at: number;
  }>;

  return rows.map((row) => ({
    kind: row.kind,
    blockNumber: row.block_number,
    txIndex: row.tx_index,
    logIndex: row.log_index,
    assetsRaw: row.assets_raw,
    newTotalAssetsRaw: row.new_total_assets_raw,
    createdAt: row.created_at,
  }));
}

function applyAssetFlowEvent(totalAssetsRaw: bigint, event: AssetFlowEvent): bigint {
  switch (event.kind) {
    case "deposit":
      return totalAssetsRaw + BigInt(event.assetsRaw ?? "0");
    case "withdraw":
      return subtractNonnegative(totalAssetsRaw, BigInt(event.assetsRaw ?? "0"));
    case "accrue":
      return BigInt(event.newTotalAssetsRaw ?? totalAssetsRaw.toString());
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

function buildAssetsOverTime(
  events: AssetFlowEvent[],
  reference: { blockNumber: number; capturedAt: number } | null,
  dayKeys: string[],
  latestAssetsRaw: string | null,
): Array<{ day: string; totalAssetsRaw: string }> {
  const assetsByDay = new Map<string, string>();
  let totalAssetsRaw = 0n;
  const firstDay = dayKeys[0];
  let seedAssetsRaw = "0";

  for (const event of events) {
    totalAssetsRaw = applyAssetFlowEvent(totalAssetsRaw, event);
    const eventMs = estimateBlockTimeMs(event.blockNumber, reference, event.createdAt);
    const day = dayKey(eventMs);

    if (firstDay !== undefined && day < firstDay) {
      seedAssetsRaw = totalAssetsRaw.toString();
      continue;
    }

    assetsByDay.set(day, totalAssetsRaw.toString());
  }

  if (latestAssetsRaw !== null && dayKeys.length > 0) {
    assetsByDay.set(dayKeys[dayKeys.length - 1]!, latestAssetsRaw);
  }

  let lastAssetsRaw = seedAssetsRaw;
  return dayKeys.map((day) => {
    const value = assetsByDay.get(day);
    if (value !== undefined) {
      lastAssetsRaw = value;
    }

    return {
      day,
      totalAssetsRaw: lastAssetsRaw,
    };
  });
}

export function getOverviewStats(
  db: Database.Database,
  config: AppConfig,
  windowDays: OverviewWindowDays = DEFAULT_OVERVIEW_WINDOW_DAYS,
): OverviewStatsResponse {
  const nowMs = Date.now();
  const windowStartMs = nowMs - (windowDays - 1) * MS_PER_DAY;
  const dayKeys = buildDayRange(nowMs, windowDays);
  const vault = getVaultMetrics(db, config);
  const reference = readTimeReference(db);
  const flowEvents = readAssetFlowEvents(db, config);

  const addresses = db
    .prepare(
      `
      SELECT address
      FROM account_positions
      ORDER BY address ASC
    `,
    )
    .all() as Array<{ address: string }>;

  let totalDepositedRaw = 0n;
  let totalEarnedRaw = 0n;
  let earnedComplete = vault.totalAssetsRaw !== null;
  const walletValues: Array<{ address: string; netValueRaw: bigint }> = [];

  for (const { address } of addresses) {
    const metrics = getAccountMetrics(db, config, address);
    totalDepositedRaw += BigInt(metrics.lifetimeDeposited.raw);

    if (metrics.estimatedNetLifetimeEarned.raw === null) {
      earnedComplete = false;
    } else {
      totalEarnedRaw += BigInt(metrics.estimatedNetLifetimeEarned.raw);
    }

    if (metrics.activeDeposit.valueRaw !== null) {
      const netValueRaw = BigInt(metrics.activeDeposit.valueRaw);
      if (netValueRaw > 0n) {
        walletValues.push({
          address: metrics.address,
          netValueRaw,
        });
      }
    }
  }

  walletValues.sort((left, right) => compareBigIntDesc(left.netValueRaw, right.netValueRaw));

  const assetsOverTime = buildAssetsOverTime(
    flowEvents,
    reference,
    dayKeys,
    vault.totalAssetsRaw,
  );

  const depositedByDay = new Map<string, bigint>();
  const withdrawnByDay = new Map<string, bigint>();

  for (const event of flowEvents) {
    if (event.kind !== "deposit" && event.kind !== "withdraw") {
      continue;
    }

    const eventMs = estimateBlockTimeMs(event.blockNumber, reference, event.createdAt);
    if (eventMs < windowStartMs) {
      continue;
    }

    const day = dayKey(eventMs);
    const amount = BigInt(event.assetsRaw ?? "0");
    if (event.kind === "deposit") {
      depositedByDay.set(day, (depositedByDay.get(day) ?? 0n) + amount);
    } else {
      withdrawnByDay.set(day, (withdrawnByDay.get(day) ?? 0n) + amount);
    }
  }

  const volumeOverTime = dayKeys.map((day) => ({
    day,
    depositedRaw: (depositedByDay.get(day) ?? 0n).toString(),
    withdrawnRaw: (withdrawnByDay.get(day) ?? 0n).toString(),
  }));

  return {
    windowDays,
    totals: {
      totalAssetsRaw: vault.totalAssetsRaw,
      totalDepositedRaw: totalDepositedRaw.toString(),
      totalEarnedRaw: earnedComplete ? totalEarnedRaw.toString() : null,
      totalWallets: addresses.length,
    },
    assetsOverTime,
    volumeOverTime,
    topWallets: walletValues.slice(0, OVERVIEW_TOP_WALLETS_LIMIT).map((wallet) => ({
      address: wallet.address,
      netValueRaw: wallet.netValueRaw.toString(),
    })),
    valuationBlock: vault.valuationBlock,
    valuationTime: vault.valuationTime,
  };
}
