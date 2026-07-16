import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import {
  readAccountPosition,
  readLatestSnapshot,
  readVaultStateSnapshot,
} from "../db";
import { settle, type AccountLedger, SCALE } from "../indexer/ledger";
import { valueOfShares } from "../snapshot/sharePrice";

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
  earnedPerformanceFee: {
    shares: string;
    valueRaw: string | null;
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

export function getAccountMetrics(
  db: Database.Database,
  config: AppConfig,
  address: string,
): AccountMetricsResponse {
  const position = readAccountPosition(db, address);
  const vaultState = readVaultStateSnapshot(db, config);
  const snapshot = readLatestSnapshot(db);
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
      earnedPerformanceFee: {
        shares: account.earnedPerfFeeSharesRaw.toString(),
        valueRaw: null,
      },
      valuationBlock: null,
      valuationTime: null,
    };
  }

  const activeDepositValue = valueOfShares(account.balanceRaw, snapshot);
  const lifetimeEarned =
    activeDepositValue + account.lifetimeWithdrawnRaw - account.lifetimeDepositedRaw;
  const performanceFeeValue = valueOfShares(account.earnedPerfFeeSharesRaw, snapshot);

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
      raw: (lifetimeEarned > 0n ? lifetimeEarned : 0n).toString(),
    },
    earnedPerformanceFee: {
      shares: account.earnedPerfFeeSharesRaw.toString(),
      valueRaw: performanceFeeValue.toString(),
    },
    valuationBlock: snapshot.blockNumber,
    valuationTime: snapshot.capturedAt,
  };
}

export function getVaultMetrics(db: Database.Database, config: AppConfig): VaultMetricsResponse {
  const vaultState = readVaultStateSnapshot(db, config);
  const snapshot = readLatestSnapshot(db);
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
  };
}
