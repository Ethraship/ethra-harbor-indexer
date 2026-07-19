import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import {
  readAccountPosition,
  readLastPerformanceFeeMintBlock,
  readLatestSnapshot,
  readLatestSnapshotAtOrBefore,
  readSnapshotAdjustedThroughBlock,
  readVaultCursor,
  readVaultStateSnapshot,
} from "../db";
import { settle, type AccountLedger, SCALE } from "../indexer/ledger";
import { valueOfShares } from "../snapshot/sharePrice";

const PERFORMANCE_FEE_RATE_BPS = 5000n;
const BPS_SCALE = 10000n;

export interface AccountMetricsResponse {
  address: string;
  activeDeposit: {
    shares: string;
    valueRaw: string | null;
  };
  lifetimeDeposited: {
    raw: string;
  };
  lifetimeWithdrawn: {
    raw: string;
  };
  lifetimeEarned: {
    raw: string | null;
  };
  grossLifetimeEarned: {
    raw: string | null;
  };
  estimatedNetLifetimeEarned: {
    raw: string | null;
    performanceFeeRateBps: string;
  };
  estimatedPerformanceFee: {
    raw: string | null;
  };
  earnedPerformanceFee: {
    shares: string;
    valueRaw: string | null;
  };
  blockContext: {
    currentBlock: number | null;
    lastProcessedLogBlock: number | null;
    lastPerformanceFeeMintBlock: number | null;
    blocksSincePerformanceFeeMint: number | null;
  };
  valuationBlock: number | null;
  valuationTime: number | null;
}

export interface VaultMetricsResponse {
  totalSupplyRaw: string;
  totalAssetsRaw: string | null;
  sharePriceScaledRaw: string | null;
  sharePriceScale: string;
  cumulativePerformanceFeeSharesRaw: string;
  cumulativePerformanceFeeValueRaw: string | null;
  valuationBlock: number | null;
  valuationTime: number | null;
  blockContext: {
    currentBlock: number | null;
    lastProcessedLogBlock: number | null;
  };
}

interface ValuationSnapshotContext {
  currentBlock: number | null;
  lastProcessedLogBlock: number | null;
  valuationSnapshot: ReturnType<typeof readLatestSnapshot>;
}

function toAccountLedger(position: ReturnType<typeof readAccountPosition>): AccountLedger {
  return {
    balanceRaw: BigInt(position.balanceRaw),
    rewardDebtRaw: BigInt(position.rewardDebtRaw),
    earnedPerfFeeSharesRaw: BigInt(position.earnedPerfFeeSharesRaw),
    lifetimeDepositedRaw: BigInt(position.lifetimeDepositedRaw),
    lifetimeWithdrawnRaw: BigInt(position.lifetimeWithdrawnRaw),
    touched: false,
    updatedBlockNumber: position.updatedBlockNumber,
    updatedLogIndex: position.updatedLogIndex,
  };
}

function blockContext(
  currentBlock: number | null,
  lastProcessedLogBlock: number | null,
  lastPerformanceFeeMintBlock: number | null,
): AccountMetricsResponse["blockContext"] {
  const performanceFeeReferenceBlock =
    currentBlock !== null && lastProcessedLogBlock !== null
      ? Math.max(currentBlock, lastProcessedLogBlock)
      : currentBlock ?? lastProcessedLogBlock;

  return {
    currentBlock,
    lastProcessedLogBlock,
    lastPerformanceFeeMintBlock,
    blocksSincePerformanceFeeMint:
      performanceFeeReferenceBlock !== null && lastPerformanceFeeMintBlock !== null
        ? performanceFeeReferenceBlock - lastPerformanceFeeMintBlock
        : null,
  };
}

function readValuationSnapshotContext(
  db: Database.Database,
  config: AppConfig,
): ValuationSnapshotContext {
  const latestObservedSnapshot = readLatestSnapshot(db);
  const lastProcessedLogBlock = readVaultCursor(db, config);
  const baseValuationSnapshot =
    lastProcessedLogBlock === null
      ? null
      : readLatestSnapshotAtOrBefore(db, lastProcessedLogBlock);
  const valuationSnapshot =
    baseValuationSnapshot === null || lastProcessedLogBlock === null
      ? null
      : readSnapshotAdjustedThroughBlock(
          db,
          config,
          baseValuationSnapshot,
          lastProcessedLogBlock,
        );

  return {
    currentBlock: latestObservedSnapshot?.blockNumber ?? null,
    lastProcessedLogBlock,
    valuationSnapshot,
  };
}

export function getAccountMetrics(
  db: Database.Database,
  config: AppConfig,
  address: string,
): AccountMetricsResponse {
  const snapshotContext = readValuationSnapshotContext(db, config);
  const snapshot = snapshotContext.valuationSnapshot;
  const { currentBlock, lastProcessedLogBlock } = snapshotContext;
  const lastPerformanceFeeMintBlock = readLastPerformanceFeeMintBlock(db, config);
  const position = readAccountPosition(db, address);
  const vaultState = readVaultStateSnapshot(db, config);
  const account = toAccountLedger(position);

  settle(account, BigInt(vaultState.globalIndexRaw));

  if (!snapshot) {
    return {
      address: position.address,
      activeDeposit: {
        shares: account.balanceRaw.toString(),
        valueRaw: null,
      },
      lifetimeDeposited: {
        raw: account.lifetimeDepositedRaw.toString(),
      },
      lifetimeWithdrawn: {
        raw: account.lifetimeWithdrawnRaw.toString(),
      },
      lifetimeEarned: {
        raw: null,
      },
      grossLifetimeEarned: {
        raw: null,
      },
      estimatedNetLifetimeEarned: {
        raw: null,
        performanceFeeRateBps: PERFORMANCE_FEE_RATE_BPS.toString(),
      },
      estimatedPerformanceFee: {
        raw: null,
      },
      earnedPerformanceFee: {
        shares: account.earnedPerfFeeSharesRaw.toString(),
        valueRaw: null,
      },
      blockContext: blockContext(currentBlock, lastProcessedLogBlock, lastPerformanceFeeMintBlock),
      valuationBlock: null,
      valuationTime: null,
    };
  }

  const grossActiveDepositValue = valueOfShares(account.balanceRaw, snapshot);
  const markToMarketLifetimeEarned =
    grossActiveDepositValue + account.lifetimeWithdrawnRaw - account.lifetimeDepositedRaw;
  const positiveMarkToMarketLifetimeEarned =
    markToMarketLifetimeEarned > 0n ? markToMarketLifetimeEarned : 0n;
  const performanceFeeValue = valueOfShares(account.earnedPerfFeeSharesRaw, snapshot);
  const grossLifetimeEarned = positiveMarkToMarketLifetimeEarned + performanceFeeValue;
  const estimatedNetLifetimeEarned =
    (grossLifetimeEarned * (BPS_SCALE - PERFORMANCE_FEE_RATE_BPS)) / BPS_SCALE;
  const roundedEstimatedPerformanceFee = grossLifetimeEarned - estimatedNetLifetimeEarned;
  const estimatedPerformanceFee =
    roundedEstimatedPerformanceFee > estimatedNetLifetimeEarned
      ? estimatedNetLifetimeEarned
      : roundedEstimatedPerformanceFee;
  const estimatedActiveDepositValue =
    markToMarketLifetimeEarned > 0n
      ? account.lifetimeDepositedRaw - account.lifetimeWithdrawnRaw + estimatedNetLifetimeEarned
      : grossActiveDepositValue;
  const activeDepositValue =
    estimatedActiveDepositValue > 0n ? estimatedActiveDepositValue : 0n;

  return {
    address: position.address,
    activeDeposit: {
      shares: account.balanceRaw.toString(),
      valueRaw: activeDepositValue.toString(),
    },
    lifetimeDeposited: {
      raw: account.lifetimeDepositedRaw.toString(),
    },
    lifetimeWithdrawn: {
      raw: account.lifetimeWithdrawnRaw.toString(),
    },
    lifetimeEarned: {
      raw: estimatedNetLifetimeEarned.toString(),
    },
    grossLifetimeEarned: {
      raw: grossLifetimeEarned.toString(),
    },
    estimatedNetLifetimeEarned: {
      raw: estimatedNetLifetimeEarned.toString(),
      performanceFeeRateBps: PERFORMANCE_FEE_RATE_BPS.toString(),
    },
    estimatedPerformanceFee: {
      raw: estimatedPerformanceFee.toString(),
    },
    earnedPerformanceFee: {
      shares: account.earnedPerfFeeSharesRaw.toString(),
      valueRaw: performanceFeeValue.toString(),
    },
    blockContext: blockContext(currentBlock, lastProcessedLogBlock, lastPerformanceFeeMintBlock),
    valuationBlock: snapshot.blockNumber,
    valuationTime: snapshot.capturedAt,
  };
}

export function getVaultMetrics(db: Database.Database, config: AppConfig): VaultMetricsResponse {
  const vaultState = readVaultStateSnapshot(db, config);
  const snapshotContext = readValuationSnapshotContext(db, config);
  const snapshot = snapshotContext.valuationSnapshot;
  const sharePriceScale = (10n ** 18n).toString();

  if (!snapshot) {
    return {
      totalSupplyRaw: vaultState.totalSupplyRaw,
      totalAssetsRaw: null,
      sharePriceScaledRaw: null,
      sharePriceScale,
      cumulativePerformanceFeeSharesRaw: vaultState.cumulativePerfFeeSharesRaw,
      cumulativePerformanceFeeValueRaw: null,
      valuationBlock: null,
      valuationTime: null,
      blockContext: {
        currentBlock: snapshotContext.currentBlock,
        lastProcessedLogBlock: snapshotContext.lastProcessedLogBlock,
      },
    };
  }

  const snapshotSupplyRaw = BigInt(snapshot.totalSupplyRaw);
  const sharePriceScaledRaw =
    snapshotSupplyRaw === 0n
      ? "0"
      : ((BigInt(snapshot.totalAssetsRaw) * (SCALE / 10n ** 18n)) / snapshotSupplyRaw).toString();
  const cumulativePerformanceFeeValueRaw = valueOfShares(
    BigInt(vaultState.cumulativePerfFeeSharesRaw),
    snapshot,
  ).toString();

  return {
    totalSupplyRaw: vaultState.totalSupplyRaw,
    totalAssetsRaw: snapshot.totalAssetsRaw,
    sharePriceScaledRaw,
    sharePriceScale,
    cumulativePerformanceFeeSharesRaw: vaultState.cumulativePerfFeeSharesRaw,
    cumulativePerformanceFeeValueRaw,
    valuationBlock: snapshot.blockNumber,
    valuationTime: snapshot.capturedAt,
    blockContext: {
      currentBlock: snapshotContext.currentBlock,
      lastProcessedLogBlock: snapshotContext.lastProcessedLogBlock,
    },
  };
}
