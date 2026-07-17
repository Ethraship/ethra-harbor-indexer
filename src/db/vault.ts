import type Database from "better-sqlite3";
import type { AppConfig } from "../config";
import { vaultCursorId } from "../config";
import type { DecodedVaultEvent } from "../indexer/eventDecoder";
import {
  applyAccrue,
  applyDeposit,
  applyTransfer,
  applyWithdraw,
  type AccountLedger,
  type LedgerState,
  ZERO_ADDRESS,
} from "../indexer/ledger";

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

export interface ApplyChunkInput {
  decodedEvents: DecodedVaultEvent[];
  toBlock: number;
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

function toLedgerAccount(position: AccountPosition): AccountLedger {
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

function toAccountPosition(address: string, account: AccountLedger): AccountPosition {
  return {
    address,
    balanceRaw: account.balanceRaw.toString(),
    rewardDebtRaw: account.rewardDebtRaw.toString(),
    earnedPerfFeeSharesRaw: account.earnedPerfFeeSharesRaw.toString(),
    lifetimeDepositedRaw: account.lifetimeDepositedRaw.toString(),
    lifetimeWithdrawnRaw: account.lifetimeWithdrawnRaw.toString(),
    updatedBlockNumber: account.updatedBlockNumber,
    updatedLogIndex: account.updatedLogIndex,
  };
}

function insertDepositEvent(
  db: Database.Database,
  event: {
    chainId: number;
    contractAddress: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    txIndex: number;
    logIndex: number;
    sender: string;
    onBehalf: string;
    assets: string;
    shares: string;
    rawLogJson: string;
    createdAt: number;
  },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO deposit_events (
      chain_id,
      contract_address,
      block_number,
      block_hash,
      tx_hash,
      tx_index,
      log_index,
      sender,
      on_behalf,
      assets,
      shares,
      raw_log_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.chainId,
    event.contractAddress,
    event.blockNumber,
    event.blockHash,
    event.txHash,
    event.txIndex,
    event.logIndex,
    event.sender,
    event.onBehalf,
    event.assets,
    event.shares,
    event.rawLogJson,
    event.createdAt,
  );
}

function rawLogIdentity(event: DecodedVaultEvent): string {
  return `${event.base.chainId}:${event.base.txHash}:${event.base.logIndex}`;
}

function assertNoDuplicateRawLogsInChunk(decodedEvents: DecodedVaultEvent[]): void {
  const seen = new Set<string>();

  for (const event of decodedEvents) {
    const identity = rawLogIdentity(event);

    if (seen.has(identity)) {
      throw new Error(`duplicate raw vault log identity in chunk: ${identity}`);
    }

    seen.add(identity);
  }
}

function prepareRawLogExistsStatement(db: Database.Database): Database.Statement {
  return db.prepare(`
    SELECT 1
    FROM (
      SELECT chain_id, tx_hash, log_index FROM deposit_events
      UNION ALL
      SELECT chain_id, tx_hash, log_index FROM withdraw_events
      UNION ALL
      SELECT chain_id, tx_hash, log_index FROM transfer_events
      UNION ALL
      SELECT chain_id, tx_hash, log_index FROM accrue_interest_events
    )
    WHERE chain_id = ? AND tx_hash = ? AND log_index = ?
    LIMIT 1
  `);
}

function assertNoPersistedRawLogs(
  rawLogExists: Database.Statement,
  decodedEvents: DecodedVaultEvent[],
): void {
  for (const event of decodedEvents) {
    const existing = rawLogExists.get(
      event.base.chainId,
      event.base.txHash,
      event.base.logIndex,
    ) as { 1: number } | undefined;

    if (existing) {
      throw new Error(
        `already-persisted raw vault log identity: ${rawLogIdentity(event)}`,
      );
    }
  }
}

function collectTouchedAddresses(decodedEvents: DecodedVaultEvent[]): string[] {
  const addresses = new Set<string>();

  for (const event of decodedEvents) {
    switch (event.kind) {
      case "deposit":
      case "withdraw":
        addresses.add(event.onBehalf);
        break;
      case "transfer":
        if (event.from !== ZERO_ADDRESS) {
          addresses.add(event.from);
        }
        if (event.to !== ZERO_ADDRESS) {
          addresses.add(event.to);
        }
        break;
      case "accrue":
        break;
    }
  }

  return [...addresses];
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

export function readVaultCursor(db: Database.Database, config: AppConfig): number | null {
  const id = vaultCursorId(config);
  const row = db.prepare(
    "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
  ).get(id) as { last_scanned_block: number } | undefined;

  return row ? row.last_scanned_block : null;
}

export function getOrCreateVaultCursor(db: Database.Database, config: AppConfig): number {
  const id = vaultCursorId(config);
  const existingCursor = readVaultCursor(db, config);

  if (existingCursor !== null) {
    ensureVaultRewardStateRow(db, id);
    return existingCursor;
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

function readVaultStateRow(
  db: Database.Database,
  config: AppConfig,
): VaultRewardState | null {
  const id = vaultCursorId(config);
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
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    globalIndexRaw: row.global_performance_fee_index_raw,
    totalSupplyRaw: row.total_supply_raw,
    cumulativePerfFeeSharesRaw: row.cumulative_performance_fee_shares_raw,
    cumulativeMgmtFeeSharesRaw: row.cumulative_management_fee_shares_raw,
    updatedBlockNumber: row.updated_block_number,
  };
}

export function readVaultStateSnapshot(
  db: Database.Database,
  config: AppConfig,
): VaultRewardState {
  return readVaultStateRow(db, config) ?? { ...ZERO_VAULT_REWARD_STATE };
}

export function readVaultState(
  db: Database.Database,
  config: AppConfig,
): VaultRewardState {
  const id = vaultCursorId(config);
  ensureVaultRewardStateRow(db, id);

  return readVaultStateRow(db, config) ?? { ...ZERO_VAULT_REWARD_STATE };
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

export function readLastPerformanceFeeMintBlock(
  db: Database.Database,
): number | null {
  const row = db.prepare(`
    SELECT block_number
    FROM accrue_interest_events
    WHERE performance_fee_shares != '0'
    ORDER BY block_number DESC, tx_index DESC, log_index DESC
    LIMIT 1
  `).get() as { block_number: number } | undefined;

  return row ? row.block_number : null;
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
      id,
      block_number,
      total_assets_raw,
      total_supply_raw,
      captured_at
    FROM share_price_snapshots
    ORDER BY block_number DESC, captured_at DESC, id DESC
    LIMIT 1
  `).get() as {
    id: number;
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

export function applyChunk(
  db: Database.Database,
  config: AppConfig,
  input: ApplyChunkInput,
): void {
  const rawLogExists = prepareRawLogExistsStatement(db);
  const updateCursor = db.prepare(`
    UPDATE indexer_state
    SET chain_id = ?, contract_address = ?, last_scanned_block = ?, updated_at = ?
    WHERE id = ?
  `);
  const persistChunk = db.transaction((chunk: ApplyChunkInput) => {
    getOrCreateVaultCursor(db, config);
    assertNoDuplicateRawLogsInChunk(chunk.decodedEvents);
    assertNoPersistedRawLogs(rawLogExists, chunk.decodedEvents);

    const currentVaultState = readVaultState(db, config);
    const accounts = new Map<string, AccountLedger>();

    for (const address of collectTouchedAddresses(chunk.decodedEvents)) {
      accounts.set(address, toLedgerAccount(readAccountPosition(db, address)));
    }

    const ledgerState: LedgerState = {
      globalIndexRaw: BigInt(currentVaultState.globalIndexRaw),
      totalSupplyRaw: BigInt(currentVaultState.totalSupplyRaw),
      cumulativePerfFeeSharesRaw: BigInt(currentVaultState.cumulativePerfFeeSharesRaw),
      cumulativeMgmtFeeSharesRaw: BigInt(currentVaultState.cumulativeMgmtFeeSharesRaw),
      accounts,
    };
    let updatedBlockNumber = currentVaultState.updatedBlockNumber;

    for (const event of chunk.decodedEvents) {
      updatedBlockNumber = event.base.blockNumber;

      switch (event.kind) {
        case "deposit":
          applyDeposit(ledgerState, {
            onBehalf: event.onBehalf,
            assets: BigInt(event.assets),
            shares: BigInt(event.shares),
            block: event.base.blockNumber,
            logIndex: event.base.logIndex,
          });
          insertDepositEvent(db, {
            chainId: event.base.chainId,
            contractAddress: event.base.contractAddress,
            blockNumber: event.base.blockNumber,
            blockHash: event.base.blockHash,
            txHash: event.base.txHash,
            txIndex: event.base.txIndex,
            logIndex: event.base.logIndex,
            sender: event.sender,
            onBehalf: event.onBehalf,
            assets: event.assets,
            shares: event.shares,
            rawLogJson: event.base.rawLogJson,
            createdAt: event.base.createdAt,
          });
          break;
        case "withdraw":
          applyWithdraw(ledgerState, {
            onBehalf: event.onBehalf,
            assets: BigInt(event.assets),
            shares: BigInt(event.shares),
            block: event.base.blockNumber,
            logIndex: event.base.logIndex,
          });
          insertWithdrawEvent(db, {
            chainId: event.base.chainId,
            contractAddress: event.base.contractAddress,
            blockNumber: event.base.blockNumber,
            blockHash: event.base.blockHash,
            txHash: event.base.txHash,
            txIndex: event.base.txIndex,
            logIndex: event.base.logIndex,
            sender: event.sender,
            receiver: event.receiver,
            onBehalf: event.onBehalf,
            assets: event.assets,
            shares: event.shares,
            rawLogJson: event.base.rawLogJson,
            createdAt: event.base.createdAt,
          });
          break;
        case "transfer":
          applyTransfer(ledgerState, {
            from: event.from,
            to: event.to,
            shares: BigInt(event.shares),
            block: event.base.blockNumber,
            logIndex: event.base.logIndex,
          });
          insertTransferEvent(db, {
            chainId: event.base.chainId,
            contractAddress: event.base.contractAddress,
            blockNumber: event.base.blockNumber,
            blockHash: event.base.blockHash,
            txHash: event.base.txHash,
            txIndex: event.base.txIndex,
            logIndex: event.base.logIndex,
            fromAddress: event.from,
            toAddress: event.to,
            shares: event.shares,
            rawLogJson: event.base.rawLogJson,
            createdAt: event.base.createdAt,
          });
          break;
        case "accrue": {
          const result = applyAccrue(ledgerState, {
            performanceFeeShares: BigInt(event.performanceFeeShares),
            managementFeeShares: BigInt(event.managementFeeShares),
            block: event.base.blockNumber,
            logIndex: event.base.logIndex,
          });
          insertAccrueInterestEvent(db, {
            chainId: event.base.chainId,
            contractAddress: event.base.contractAddress,
            blockNumber: event.base.blockNumber,
            blockHash: event.base.blockHash,
            txHash: event.base.txHash,
            txIndex: event.base.txIndex,
            logIndex: event.base.logIndex,
            previousTotalAssets: event.previousTotalAssets,
            newTotalAssets: event.newTotalAssets,
            performanceFeeShares: event.performanceFeeShares,
            managementFeeShares: event.managementFeeShares,
            totalSupplyBeforeRaw: result.totalSupplyBeforeRaw.toString(),
            globalIndexAfterRaw: result.globalIndexAfterRaw.toString(),
            rawLogJson: event.base.rawLogJson,
            createdAt: event.base.createdAt,
          });
          break;
        }
      }
    }

    for (const [address, account] of ledgerState.accounts) {
      if (!account.touched) {
        continue;
      }

      upsertAccountPosition(db, toAccountPosition(address, account));
    }

    upsertVaultState(db, config, {
      globalIndexRaw: ledgerState.globalIndexRaw.toString(),
      totalSupplyRaw: ledgerState.totalSupplyRaw.toString(),
      cumulativePerfFeeSharesRaw: ledgerState.cumulativePerfFeeSharesRaw.toString(),
      cumulativeMgmtFeeSharesRaw: ledgerState.cumulativeMgmtFeeSharesRaw.toString(),
      updatedBlockNumber,
    });
    updateCursor.run(
      config.chainId,
      config.contractAddress,
      chunk.toBlock,
      Date.now(),
      vaultCursorId(config),
    );
  });

  persistChunk(input);
}
