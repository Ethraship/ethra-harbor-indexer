import type Database from "better-sqlite3";

import type { AppConfig } from "../config";

export interface DepositEventRecord {
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
}

export interface CrawlErrorRecord {
  chainId: number;
  fromBlock: number;
  toBlock: number;
  message: string;
  createdAt: number;
}

export function cursorId(config: AppConfig): string {
  return `base:deposit:${config.contractAddress.toLowerCase()}`;
}

export function getOrCreateCursor(db: Database.Database, config: AppConfig): number {
  const id = cursorId(config);
  const existingCursor = db.prepare(
    "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
  ).get(id) as { last_scanned_block: number } | undefined;

  if (existingCursor) {
    return existingCursor.last_scanned_block;
  }

  db.prepare(
    `
      INSERT INTO indexer_state (
        id,
        chain_id,
        contract_address,
        last_scanned_block,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    config.chainId,
    config.contractAddress,
    config.startBlock,
    Date.now(),
  );

  return config.startBlock;
}

export function saveDepositsAndCursor(
  db: Database.Database,
  config: AppConfig,
  deposits: DepositEventRecord[],
  toBlock: number,
): void {
  const insertDeposit = db.prepare(`
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
  `);
  const updateCursor = db.prepare(`
    UPDATE indexer_state
    SET chain_id = ?, contract_address = ?, last_scanned_block = ?, updated_at = ?
    WHERE id = ?
  `);

  const persistBatch = db.transaction((batch: DepositEventRecord[], nextBlock: number) => {
    getOrCreateCursor(db, config);

    for (const deposit of batch) {
      insertDeposit.run(
        deposit.chainId,
        deposit.contractAddress,
        deposit.blockNumber,
        deposit.blockHash,
        deposit.txHash,
        deposit.txIndex,
        deposit.logIndex,
        deposit.sender,
        deposit.onBehalf,
        deposit.assets,
        deposit.shares,
        deposit.rawLogJson,
        deposit.createdAt,
      );
    }

    updateCursor.run(
      config.chainId,
      config.contractAddress,
      nextBlock,
      Date.now(),
      cursorId(config),
    );
  });

  persistBatch(deposits, toBlock);
}

export function recordCrawlError(
  db: Database.Database,
  error: CrawlErrorRecord,
): void {
  db.prepare(`
    INSERT INTO crawl_errors (
      chain_id,
      from_block,
      to_block,
      message,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    error.chainId,
    error.fromBlock,
    error.toBlock,
    error.message,
    error.createdAt,
  );
}
