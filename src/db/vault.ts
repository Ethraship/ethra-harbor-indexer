import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import { vaultCursorId } from "../config";

export interface VaultRewardState {
  globalIndexRaw: string;
  totalSupplyRaw: string;
  cumulativePerfFeeSharesRaw: string;
  cumulativeMgmtFeeSharesRaw: string;
  updatedBlockNumber: number;
}

export interface AccountPosition {
  address: string;
  balanceRaw: string;
  rewardDebtRaw: string;
  earnedPerfFeeSharesRaw: string;
  lifetimeDepositedRaw: string;
  lifetimeWithdrawnRaw: string;
  updatedBlockNumber: number;
  updatedLogIndex: number;
}

export interface Snapshot {
  blockNumber: number;
  totalAssetsRaw: string;
  totalSupplyRaw: string;
  capturedAt: number;
}

export interface WithdrawEventRecord {
  chainId: number;
  contractAddress: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  sender: string;
  receiver: string;
  onBehalf: string;
  assets: string;
  shares: string;
  rawLogJson: string;
  createdAt: number;
}

export interface TransferEventRecord {
  chainId: number;
  contractAddress: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  fromAddress: string;
  toAddress: string;
  shares: string;
  rawLogJson: string;
  createdAt: number;
}

export interface AccrueInterestEventRecord {
  chainId: number;
  contractAddress: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  previousTotalAssets: string;
  newTotalAssets: string;
  performanceFeeShares: string;
  managementFeeShares: string;
  totalSupplyBeforeRaw: string;
  globalIndexAfterRaw: string;
  rawLogJson: string;
  createdAt: number;
}

const ZERO_VAULT_REWARD_STATE: VaultRewardState = {
  globalIndexRaw: "0",
  totalSupplyRaw: "0",
  cumulativePerfFeeSharesRaw: "0",
  cumulativeMgmtFeeSharesRaw: "0",
  updatedBlockNumber: 0,
};

function zeroAccountPosition(address: string): AccountPosition {
  return {
    address,
    balanceRaw: "0",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "0",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 0,
    updatedLogIndex: 0,
  };
}

function ensureVaultRewardStateRow(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO vault_reward_state (
      id,
      global_performance_fee_index_raw,
      total_supply_raw,
      cumulative_performance_fee_shares_raw,
      cumulative_management_fee_shares_raw,
      updated_block_number
    ) VALUES (?, '0', '0', '0', '0', 0)
  `).run(id);
}

function readVaultRewardStateId(db: Database.Database): string | null {
  const rewardStateRow = db.prepare(
    "SELECT id FROM vault_reward_state ORDER BY id LIMIT 1",
  ).get() as { id: string } | undefined;
  if (rewardStateRow) {
    return rewardStateRow.id;
  }

  const cursorRow = db.prepare(
    "SELECT id FROM indexer_state WHERE id LIKE 'base:vault:%' ORDER BY id LIMIT 1",
  ).get() as { id: string } | undefined;

  return cursorRow?.id ?? null;
}

export function getOrCreateVaultCursor(db: Database.Database, config: AppConfig): number {
  const id = vaultCursorId(config);
  const existingCursor = db.prepare(
    "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
  ).get(id) as { last_scanned_block: number } | undefined;

  if (existingCursor) {
    ensureVaultRewardStateRow(db, id);
    return existingCursor.last_scanned_block;
  }

  db.prepare(`
    INSERT INTO indexer_state (
      id,
      chain_id,
      contract_address,
      last_scanned_block,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    config.chainId,
    config.contractAddress,
    config.startBlock,
    Date.now(),
  );
  ensureVaultRewardStateRow(db, id);

  return config.startBlock;
}

export function readVaultState(db: Database.Database): VaultRewardState {
  const id = readVaultRewardStateId(db);
  if (!id) {
    return { ...ZERO_VAULT_REWARD_STATE };
  }

  ensureVaultRewardStateRow(db, id);

  const row = db.prepare(`
    SELECT
      global_performance_fee_index_raw,
      total_supply_raw,
      cumulative_performance_fee_shares_raw,
      cumulative_management_fee_shares_raw,
      updated_block_number
    FROM vault_reward_state
    WHERE id = ?
  `).get(id) as {
    global_performance_fee_index_raw: string;
    total_supply_raw: string;
    cumulative_performance_fee_shares_raw: string;
    cumulative_management_fee_shares_raw: string;
    updated_block_number: number;
  };

  return {
    globalIndexRaw: row.global_performance_fee_index_raw,
    totalSupplyRaw: row.total_supply_raw,
    cumulativePerfFeeSharesRaw: row.cumulative_performance_fee_shares_raw,
    cumulativeMgmtFeeSharesRaw: row.cumulative_management_fee_shares_raw,
    updatedBlockNumber: row.updated_block_number,
  };
}

export function upsertVaultState(
  db: Database.Database,
  config: AppConfig,
  state: VaultRewardState,
): void {
  const id = vaultCursorId(config);

  ensureVaultRewardStateRow(db, id);
  db.prepare(`
    INSERT INTO vault_reward_state (
      id,
      global_performance_fee_index_raw,
      total_supply_raw,
      cumulative_performance_fee_shares_raw,
      cumulative_management_fee_shares_raw,
      updated_block_number
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      global_performance_fee_index_raw = excluded.global_performance_fee_index_raw,
      total_supply_raw = excluded.total_supply_raw,
      cumulative_performance_fee_shares_raw = excluded.cumulative_performance_fee_shares_raw,
      cumulative_management_fee_shares_raw = excluded.cumulative_management_fee_shares_raw,
      updated_block_number = excluded.updated_block_number
  `).run(
    id,
    state.globalIndexRaw,
    state.totalSupplyRaw,
    state.cumulativePerfFeeSharesRaw,
    state.cumulativeMgmtFeeSharesRaw,
    state.updatedBlockNumber,
  );
}

export function readAccountPosition(
  db: Database.Database,
  address: string,
): AccountPosition {
  const row = db.prepare(`
    SELECT
      address,
      balance_raw,
      reward_debt_raw,
      earned_performance_fee_shares_raw,
      lifetime_deposited_raw,
      lifetime_withdrawn_raw,
      updated_block_number,
      updated_log_index
    FROM account_positions
    WHERE address = ?
  `).get(address) as {
    address: string;
    balance_raw: string;
    reward_debt_raw: string;
    earned_performance_fee_shares_raw: string;
    lifetime_deposited_raw: string;
    lifetime_withdrawn_raw: string;
    updated_block_number: number;
    updated_log_index: number;
  } | undefined;

  if (!row) {
    return zeroAccountPosition(address);
  }

  return {
    address: row.address,
    balanceRaw: row.balance_raw,
    rewardDebtRaw: row.reward_debt_raw,
    earnedPerfFeeSharesRaw: row.earned_performance_fee_shares_raw,
    lifetimeDepositedRaw: row.lifetime_deposited_raw,
    lifetimeWithdrawnRaw: row.lifetime_withdrawn_raw,
    updatedBlockNumber: row.updated_block_number,
    updatedLogIndex: row.updated_log_index,
  };
}

export function upsertAccountPosition(
  db: Database.Database,
  position: AccountPosition,
): void {
  db.prepare(`
    INSERT INTO account_positions (
      address,
      balance_raw,
      reward_debt_raw,
      earned_performance_fee_shares_raw,
      lifetime_deposited_raw,
      lifetime_withdrawn_raw,
      updated_block_number,
      updated_log_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      balance_raw = excluded.balance_raw,
      reward_debt_raw = excluded.reward_debt_raw,
      earned_performance_fee_shares_raw = excluded.earned_performance_fee_shares_raw,
      lifetime_deposited_raw = excluded.lifetime_deposited_raw,
      lifetime_withdrawn_raw = excluded.lifetime_withdrawn_raw,
      updated_block_number = excluded.updated_block_number,
      updated_log_index = excluded.updated_log_index
  `).run(
    position.address,
    position.balanceRaw,
    position.rewardDebtRaw,
    position.earnedPerfFeeSharesRaw,
    position.lifetimeDepositedRaw,
    position.lifetimeWithdrawnRaw,
    position.updatedBlockNumber,
    position.updatedLogIndex,
  );
}

export function insertWithdrawEvent(
  db: Database.Database,
  event: WithdrawEventRecord,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO withdraw_events (
      chain_id,
      contract_address,
      block_number,
      block_hash,
      tx_hash,
      tx_index,
      log_index,
      sender,
      receiver,
      on_behalf,
      assets,
      shares,
      raw_log_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.chainId,
    event.contractAddress,
    event.blockNumber,
    event.blockHash,
    event.txHash,
    event.txIndex,
    event.logIndex,
    event.sender,
    event.receiver,
    event.onBehalf,
    event.assets,
    event.shares,
    event.rawLogJson,
    event.createdAt,
  );
}

export function insertTransferEvent(
  db: Database.Database,
  event: TransferEventRecord,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO transfer_events (
      chain_id,
      contract_address,
      block_number,
      block_hash,
      tx_hash,
      tx_index,
      log_index,
      from_address,
      to_address,
      shares,
      raw_log_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.chainId,
    event.contractAddress,
    event.blockNumber,
    event.blockHash,
    event.txHash,
    event.txIndex,
    event.logIndex,
    event.fromAddress,
    event.toAddress,
    event.shares,
    event.rawLogJson,
    event.createdAt,
  );
}

export function insertAccrueInterestEvent(
  db: Database.Database,
  event: AccrueInterestEventRecord,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO accrue_interest_events (
      chain_id,
      contract_address,
      block_number,
      block_hash,
      tx_hash,
      tx_index,
      log_index,
      previous_total_assets,
      new_total_assets,
      performance_fee_shares,
      management_fee_shares,
      total_supply_before_raw,
      global_index_after_raw,
      raw_log_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.chainId,
    event.contractAddress,
    event.blockNumber,
    event.blockHash,
    event.txHash,
    event.txIndex,
    event.logIndex,
    event.previousTotalAssets,
    event.newTotalAssets,
    event.performanceFeeShares,
    event.managementFeeShares,
    event.totalSupplyBeforeRaw,
    event.globalIndexAfterRaw,
    event.rawLogJson,
    event.createdAt,
  );
}

export function insertSnapshot(db: Database.Database, snapshot: Snapshot): void {
  db.prepare(`
    INSERT INTO share_price_snapshots (
      block_number,
      total_assets_raw,
      total_supply_raw,
      captured_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    snapshot.blockNumber,
    snapshot.totalAssetsRaw,
    snapshot.totalSupplyRaw,
    snapshot.capturedAt,
  );
}

export function readLatestSnapshot(db: Database.Database): Snapshot | null {
  const row = db.prepare(`
    SELECT
      block_number,
      total_assets_raw,
      total_supply_raw,
      captured_at
    FROM share_price_snapshots
    ORDER BY block_number DESC
    LIMIT 1
  `).get() as {
    block_number: number;
    total_assets_raw: string;
    total_supply_raw: string;
    captured_at: number;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    blockNumber: row.block_number,
    totalAssetsRaw: row.total_assets_raw,
    totalSupplyRaw: row.total_supply_raw,
    capturedAt: row.captured_at,
  };
}
