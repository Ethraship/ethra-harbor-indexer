import type Database from "better-sqlite3";

import { readEstimatedPerformanceFeeRaw } from "../api/queries";
import type { AppConfig } from "../config";
import {
  insertBoostChangeEvent,
  insertVshipSettlementEvent,
  listWalletBoostAddresses,
  listWalletVshipAddresses,
  readRewardConfig,
  readWalletAdditionalBoostBps,
  readWalletVshipState,
  updateBaseBoostBps,
  upsertWalletAdditionalBoostBps,
  upsertWalletVshipState,
} from "../db/rewards";
import {
  readLastPerformanceFeeMintBlock,
  readLatestSnapshot,
  readVaultCursor,
} from "../db/vault";
import { calculateVShipRaw } from "./vshipMath";

const PROBE_ADDRESS = "0x0000000000000000000000000000000000000000";

type SettlementReason = "base_boost_change" | "wallet_boost_change";

export class MutationNotReadyError extends Error {
  readonly code = "indexer_not_ready" as const;

  constructor() {
    super("Indexer is not ready for a boost mutation");
  }
}

export class StaleFeeMintError extends Error {
  readonly code = "stale_fee_mint" as const;

  constructor() {
    super("Performance fee mint is stale");
  }
}

export function assertMutationReady(
  db: Database.Database,
  config: AppConfig,
  safeHead: number | null,
): void {
  if (safeHead === null) {
    throw new MutationNotReadyError();
  }

  const cursorBlock = readVaultCursor(db, config);
  if (cursorBlock === null || cursorBlock < safeHead) {
    throw new MutationNotReadyError();
  }

  if (readEstimatedPerformanceFeeRaw(db, config, PROBE_ADDRESS) === null) {
    throw new MutationNotReadyError();
  }
}

export function assertFeeMintFresh(db: Database.Database, config: AppConfig): void {
  const currentBlock = readLatestSnapshot(db)?.blockNumber ?? null;
  const lastProcessedLogBlock = readVaultCursor(db, config);
  const lastPerformanceFeeMintBlock = readLastPerformanceFeeMintBlock(db, config);
  const performanceFeeReferenceBlock =
    currentBlock !== null && lastProcessedLogBlock !== null
      ? Math.max(currentBlock, lastProcessedLogBlock)
      : currentBlock ?? lastProcessedLogBlock;

  if (
    performanceFeeReferenceBlock !== null &&
    lastPerformanceFeeMintBlock !== null &&
    performanceFeeReferenceBlock - lastPerformanceFeeMintBlock >=
      readRewardConfig(db).feeMintStaleBlocks
  ) {
    throw new StaleFeeMintError();
  }
}

export function settleWallet(
  db: Database.Database,
  config: AppConfig,
  address: string,
  boostBpsApplied: bigint,
  reason: SettlementReason,
  settledAt: number,
): { minted: bigint } {
  const feeNow = readEstimatedPerformanceFeeRaw(db, config, address) ?? 0n;
  const state = readWalletVshipState(db, address) ?? {
    feeWatermarkRaw: 0n,
    crystallizedVshipRaw: 0n,
  };
  const feeDeltaRaw = feeNow >= state.feeWatermarkRaw ? feeNow - state.feeWatermarkRaw : 0n;
  const rewardConfig = readRewardConfig(db);
  const minted = calculateVShipRaw(
    feeDeltaRaw,
    boostBpsApplied,
    rewardConfig.vshipPriceUsdRaw,
    rewardConfig.vshipPriceUsdDecimals,
    rewardConfig.vshipTokenDecimals,
  );
  const crystallizedVshipRaw = state.crystallizedVshipRaw + minted;
  const feeWatermarkRaw =
    feeNow >= state.feeWatermarkRaw ? feeNow : state.feeWatermarkRaw;

  upsertWalletVshipState(
    db,
    address,
    feeWatermarkRaw,
    crystallizedVshipRaw,
    settledAt,
  );

  if (feeDeltaRaw > 0n) {
    insertVshipSettlementEvent(db, {
      settledAt,
      address,
      feeBeforeRaw: state.feeWatermarkRaw,
      feeAfterRaw: feeNow,
      feeDeltaRaw,
      boostBpsApplied,
      vshipMintedRaw: minted,
      crystallizedVshipAfterRaw: crystallizedVshipRaw,
      reason,
    });
  }

  return { minted };
}

function listEligibleWalletAddresses(db: Database.Database, config: AppConfig): string[] {
  const addresses = new Set([
    ...listWalletVshipAddresses(db),
    ...listWalletBoostAddresses(db),
  ]);
  const positionAddresses = db.prepare("SELECT address FROM account_positions").all() as Array<{
    address: string;
  }>;

  for (const { address } of positionAddresses) {
    const fee = readEstimatedPerformanceFeeRaw(db, config, address);
    if (fee !== null && fee > 0n) {
      addresses.add(address);
    }
  }

  return [...addresses].sort();
}

export function setBaseBoost(
  db: Database.Database,
  config: AppConfig,
  newBaseBoostBps: bigint,
  safeHead: number | null,
  actor: string,
): { settledWalletCount: number; changed: boolean } {
  assertMutationReady(db, config, safeHead);
  assertFeeMintFresh(db, config);

  const oldBaseBoostBps = readRewardConfig(db).baseBoostBps;
  if (newBaseBoostBps === oldBaseBoostBps) {
    return { settledWalletCount: 0, changed: false };
  }

  const changedAt = Date.now();
  return db.transaction(() => {
    const addresses = listEligibleWalletAddresses(db, config);

    for (const address of addresses) {
      settleWallet(
        db,
        config,
        address,
        oldBaseBoostBps + readWalletAdditionalBoostBps(db, address),
        "base_boost_change",
        changedAt,
      );
    }

    updateBaseBoostBps(db, newBaseBoostBps, changedAt);
    insertBoostChangeEvent(db, {
      changedAt,
      changeType: "base",
      address: null,
      oldBps: oldBaseBoostBps,
      newBps: newBaseBoostBps,
      actor,
      settledWalletCount: addresses.length,
    });

    return { settledWalletCount: addresses.length, changed: true };
  })();
}

export function setWalletAdditionalBoost(
  db: Database.Database,
  config: AppConfig,
  address: string,
  newAdditionalBoostBps: bigint,
  safeHead: number | null,
  actor: string,
): { settledWalletCount: number; changed: boolean } {
  assertMutationReady(db, config, safeHead);
  assertFeeMintFresh(db, config);

  const oldAdditionalBoostBps = readWalletAdditionalBoostBps(db, address);
  if (newAdditionalBoostBps === oldAdditionalBoostBps) {
    return { settledWalletCount: 0, changed: false };
  }

  const changedAt = Date.now();
  return db.transaction(() => {
    const baseBoostBps = readRewardConfig(db).baseBoostBps;
    settleWallet(
      db,
      config,
      address,
      baseBoostBps + oldAdditionalBoostBps,
      "wallet_boost_change",
      changedAt,
    );
    upsertWalletAdditionalBoostBps(db, address, newAdditionalBoostBps, changedAt);
    insertBoostChangeEvent(db, {
      changedAt,
      changeType: "wallet_additional",
      address,
      oldBps: oldAdditionalBoostBps,
      newBps: newAdditionalBoostBps,
      actor,
      settledWalletCount: 1,
    });

    return { settledWalletCount: 1, changed: true };
  })();
}
