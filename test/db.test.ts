import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config";
import {
  closeDatabase,
  openDatabase,
  runMigrations,
} from "../src/db";
import {
  cursorId,
  getOrCreateCursor,
  recordCrawlError,
  saveDepositsAndCursor,
  type CrawlErrorRecord,
  type DepositEventRecord,
} from "../src/db/deposits";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: "0x9D2F57159ECA69265A9B9efAaA8Bc2B6B2df364d",
    databasePath: "./data/test.sqlite",
    startBlock: 123,
    confirmations: 2,
    chunkSize: 1000,
    blockTimeMs: 2000,
    fastPollMs: 2000,
    slowPollMs: 50000,
    crawlMode: "auto",
    logLevel: "info",
    ...overrides,
  };
}

function createDeposit(overrides: Partial<DepositEventRecord> = {}): DepositEventRecord {
  return {
    chainId: 8453,
    contractAddress: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
    blockNumber: 200,
    blockHash: "0xblock-1",
    txHash: "0xtx-1",
    txIndex: 0,
    logIndex: 1,
    sender: "0x1111111111111111111111111111111111111111",
    onBehalf: "0x2222222222222222222222222222222222222222",
    assets: "1000000000000000000",
    shares: "950000000000000000",
    rawLogJson: JSON.stringify({ logIndex: 1 }),
    createdAt: 1712345678,
    ...overrides,
  };
}

function createCrawlError(overrides: Partial<CrawlErrorRecord> = {}): CrawlErrorRecord {
  return {
    chainId: 8453,
    fromBlock: 100,
    toBlock: 120,
    message: "range failed",
    createdAt: 1712345688,
    ...overrides,
  };
}

test("openDatabase creates parent directories and runMigrations creates the expected schema", () => {
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ethra-db-"));
  const databasePath = path.join(databaseDir, "nested", "indexer.sqlite");

  const db = openDatabase(databasePath);

  try {
    runMigrations(db);

    assert.equal(fs.existsSync(path.dirname(databasePath)), true);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const performanceFeeIndex = db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_accrue_perf_fee_latest'
    `).get() as { name: string; sql: string } | undefined;
    const depositColumns = db.prepare(
      "PRAGMA table_info(deposit_events)",
    ).all() as Array<{ name: string }>;
    const journalMode = db.pragma("journal_mode", { simple: true });

    assert.deepEqual(
      tables.map((row) => row.name),
      [
        "account_positions",
        "accrue_interest_events",
        "boost_change_events",
        "crawl_errors",
        "deposit_events",
        "indexer_state",
        "migrations",
        "reward_config",
        "share_price_snapshots",
        "sqlite_sequence",
        "transfer_events",
        "vault_reward_state",
        "vship_settlement_events",
        "wallet_boost",
        "wallet_vship_state",
        "withdraw_events",
      ],
    );
    assert.equal(journalMode, "wal");
    assert.deepEqual(
      indexes
        .map((row) => row.name)
        .filter((name) => name.startsWith("idx_")),
      [
        "idx_accrue_perf_fee_latest",
        "idx_boost_change_events_changed_at",
        "idx_deposit_events_block",
        "idx_snapshots_block",
        "idx_transfer_events_block",
        "idx_vship_settlement_events_address_settled_at",
        "idx_withdraw_events_block",
      ],
    );
    assert.equal(performanceFeeIndex?.name, "idx_accrue_perf_fee_latest");
    assert.equal(
      performanceFeeIndex?.sql.replace(/\s+/g, " ").trim(),
      "CREATE INDEX idx_accrue_perf_fee_latest ON accrue_interest_events( chain_id, contract_address, block_number DESC, tx_index DESC, log_index DESC ) WHERE performance_fee_shares != '0'",
    );
    assert.deepEqual(
      depositColumns.map((column) => column.name),
      [
        "id",
        "chain_id",
        "contract_address",
        "block_number",
        "block_hash",
        "tx_hash",
        "tx_index",
        "log_index",
        "sender",
        "on_behalf",
        "assets",
        "shares",
        "raw_log_json",
        "created_at",
      ],
    );
  } finally {
    closeDatabase(db);
    fs.rmSync(databaseDir, { recursive: true, force: true });
  }
});

test("getOrCreateCursor returns the configured start block and reuses the same cursor row", () => {
  const db = openDatabase(":memory:");
  const config = createConfig();

  try {
    runMigrations(db);

    const firstValue = getOrCreateCursor(db, config);
    const secondValue = getOrCreateCursor(db, config);

    const row = db.prepare(
      "SELECT id, chain_id, contract_address, last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(cursorId(config)) as {
      id: string;
      chain_id: number;
      contract_address: string;
      last_scanned_block: number;
    };

    assert.equal(firstValue, config.startBlock);
    assert.equal(secondValue, config.startBlock);
    assert.deepEqual(row, {
      id: "base:deposit:0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      chain_id: config.chainId,
      contract_address: config.contractAddress,
      last_scanned_block: config.startBlock,
    });
  } finally {
    closeDatabase(db);
  }
});

test("saveDepositsAndCursor ignores duplicate deposits and advances the cursor once", () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const duplicateDeposit = createDeposit();

  try {
    runMigrations(db);

    saveDepositsAndCursor(db, config, [duplicateDeposit, duplicateDeposit], 250);

    const depositRows = db.prepare(
      "SELECT chain_id, tx_hash, log_index, sender, on_behalf, assets, shares FROM deposit_events",
    ).all() as Array<{
      chain_id: number;
      tx_hash: string;
      log_index: number;
      sender: string;
      on_behalf: string;
      assets: string;
      shares: string;
    }>;
    const cursorRow = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(cursorId(config)) as { last_scanned_block: number };

    assert.equal(depositRows.length, 1);
    assert.deepEqual(depositRows[0], {
      chain_id: duplicateDeposit.chainId,
      tx_hash: duplicateDeposit.txHash,
      log_index: duplicateDeposit.logIndex,
      sender: duplicateDeposit.sender,
      on_behalf: duplicateDeposit.onBehalf,
      assets: duplicateDeposit.assets,
      shares: duplicateDeposit.shares,
    });
    assert.equal(cursorRow.last_scanned_block, 250);
  } finally {
    closeDatabase(db);
  }
});

test("saveDepositsAndCursor rolls back the cursor update when a deposit insert fails", () => {
  const db = openDatabase(":memory:");
  const config = createConfig();

  try {
    runMigrations(db);
    assert.equal(getOrCreateCursor(db, config), config.startBlock);
    db.exec(`
      CREATE TRIGGER reject_bad_tx_hash
      BEFORE INSERT ON deposit_events
      WHEN NEW.tx_hash = '0xtx-bad'
      BEGIN
        SELECT RAISE(ABORT, 'forced insert failure');
      END;
    `);

    assert.throws(
      () =>
        saveDepositsAndCursor(
          db,
          config,
          [
            createDeposit({ txHash: "0xtx-ok" }),
            createDeposit({
              txHash: "0xtx-bad",
            }),
          ],
          260,
        ),
      /forced insert failure/i,
    );

    const depositCount = db.prepare(
      "SELECT COUNT(*) AS count FROM deposit_events",
    ).get() as { count: number };
    const cursorRow = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(cursorId(config)) as { last_scanned_block: number };

    assert.equal(depositCount.count, 0);
    assert.equal(cursorRow.last_scanned_block, config.startBlock);
  } finally {
    closeDatabase(db);
  }
});

test("recordCrawlError persists crawl error rows", () => {
  const db = openDatabase(":memory:");

  try {
    runMigrations(db);

    recordCrawlError(db, createCrawlError());

    const row = db.prepare(
      "SELECT chain_id, from_block, to_block, message, created_at FROM crawl_errors",
    ).get() as {
      chain_id: number;
      from_block: number;
      to_block: number;
      message: string;
      created_at: number;
    };

    assert.deepEqual(row, {
      chain_id: 8453,
      from_block: 100,
      to_block: 120,
      message: "range failed",
      created_at: 1712345688,
    });
  } finally {
    closeDatabase(db);
  }
});
