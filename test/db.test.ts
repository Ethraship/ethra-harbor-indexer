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
    commitment: "0xcommitment-1",
    leafIndex: 9,
    token: "0xtoken-1",
    amount: "1000000000000000000",
    encryptedClaim: "ciphertext-1",
    eventTimestamp: "1712345678",
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
    const journalMode = db.pragma("journal_mode", { simple: true });

    assert.deepEqual(
      tables.map((row) => row.name),
      [
        "crawl_errors",
        "deposit_events",
        "indexer_state",
        "migrations",
        "sqlite_sequence",
      ],
    );
    assert.equal(journalMode, "wal");
    assert.deepEqual(
      indexes
        .map((row) => row.name)
        .filter((name) => name.startsWith("idx_")),
      [
        "idx_deposit_events_block",
        "idx_deposit_events_commitment",
        "idx_deposit_events_token",
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
      "SELECT chain_id, tx_hash, log_index, commitment, leaf_index FROM deposit_events",
    ).all() as Array<{
      chain_id: number;
      tx_hash: string;
      log_index: number;
      commitment: string;
      leaf_index: number | null;
    }>;
    const cursorRow = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(cursorId(config)) as { last_scanned_block: number };

    assert.equal(depositRows.length, 1);
    assert.deepEqual(depositRows[0], {
      chain_id: duplicateDeposit.chainId,
      tx_hash: duplicateDeposit.txHash,
      log_index: duplicateDeposit.logIndex,
      commitment: duplicateDeposit.commitment,
      leaf_index: duplicateDeposit.leafIndex,
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
