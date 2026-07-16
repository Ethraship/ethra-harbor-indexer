import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";
import * as dbApi from "../src/db";

interface VaultRewardState {
  globalIndexRaw: string;
  totalSupplyRaw: string;
  cumulativePerfFeeSharesRaw: string;
  cumulativeMgmtFeeSharesRaw: string;
  updatedBlockNumber: number;
}

interface AccountPosition {
  address: string;
  balanceRaw: string;
  rewardDebtRaw: string;
  earnedPerfFeeSharesRaw: string;
  lifetimeDepositedRaw: string;
  lifetimeWithdrawnRaw: string;
  updatedBlockNumber: number;
  updatedLogIndex: number;
}

interface Snapshot {
  blockNumber: number;
  totalAssetsRaw: string;
  totalSupplyRaw: string;
  capturedAt: number;
}

type VaultDbApi = typeof dbApi & {
  getOrCreateVaultCursor(db: Parameters<typeof dbApi.closeDatabase>[0], config: ReturnType<typeof loadConfig>): number;
  readVaultState(db: Parameters<typeof dbApi.closeDatabase>[0], config: ReturnType<typeof loadConfig>): VaultRewardState;
  readAccountPosition(db: Parameters<typeof dbApi.closeDatabase>[0], address: string): AccountPosition;
  insertSnapshot(db: Parameters<typeof dbApi.closeDatabase>[0], snapshot: Snapshot): void;
  readLatestSnapshot(db: Parameters<typeof dbApi.closeDatabase>[0]): Snapshot | null;
  upsertVaultState(
    db: Parameters<typeof dbApi.closeDatabase>[0],
    config: ReturnType<typeof loadConfig>,
    state: VaultRewardState,
  ): void;
};

function createConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    START_BLOCK: "48578255",
    BASE_CONTRACT_ADDRESS: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
    ...overrides,
  });
}

test("runMigrations creates the vault schema without changing deposit_events", () => {
  const db = dbApi.openDatabase(":memory:");

  try {
    dbApi.runMigrations(db);

    const tableNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const indexNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const depositColumns = db.prepare(
      "PRAGMA table_info(deposit_events)",
    ).all() as Array<{ name: string }>;

    assert.deepEqual(
      tableNames.map((row) => row.name),
      [
        "account_positions",
        "accrue_interest_events",
        "crawl_errors",
        "deposit_events",
        "indexer_state",
        "migrations",
        "share_price_snapshots",
        "sqlite_sequence",
        "transfer_events",
        "vault_reward_state",
        "withdraw_events",
      ],
    );
    assert.deepEqual(
      indexNames
        .map((row) => row.name)
        .filter((name) => name.startsWith("idx_")),
      [
        "idx_deposit_events_block",
        "idx_snapshots_block",
        "idx_transfer_events_block",
        "idx_withdraw_events_block",
      ],
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
    dbApi.closeDatabase(db);
  }
});

test("runMigrations throws the explicit reset error when only 001 has been applied", () => {
  const db = dbApi.openDatabase(":memory:");

  try {
    db.exec(`
      CREATE TABLE migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "001_initial_schema",
      1712345000,
    );

    assert.throws(
      () => {
        dbApi.runMigrations(db);
      },
      /Delete the existing SQLite database file and rerun the indexer\./,
    );
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("getOrCreateVaultCursor seeds START_BLOCK and vault reads return zero defaults", () => {
  const db = dbApi.openDatabase(":memory:");
  const config = createConfig();
  const vaultDb = dbApi as VaultDbApi;

  try {
    dbApi.runMigrations(db);

    assert.equal(typeof vaultDb.getOrCreateVaultCursor, "function");
    assert.equal(typeof vaultDb.readVaultState, "function");
    assert.equal(typeof vaultDb.readAccountPosition, "function");

    const cursor = vaultDb.getOrCreateVaultCursor(db, config);
    const state = vaultDb.readVaultState(db, config);
    const position = vaultDb.readAccountPosition(
      db,
      "0x1111111111111111111111111111111111111111",
    );

    assert.equal(cursor, 48578255);
    assert.deepEqual(state, {
      globalIndexRaw: "0",
      totalSupplyRaw: "0",
      cumulativePerfFeeSharesRaw: "0",
      cumulativeMgmtFeeSharesRaw: "0",
      updatedBlockNumber: 0,
    });
    assert.deepEqual(position, {
      address: "0x1111111111111111111111111111111111111111",
      balanceRaw: "0",
      rewardDebtRaw: "0",
      earnedPerfFeeSharesRaw: "0",
      lifetimeDepositedRaw: "0",
      lifetimeWithdrawnRaw: "0",
      updatedBlockNumber: 0,
      updatedLogIndex: 0,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("readVaultState is keyed to the active vault config", () => {
  const db = dbApi.openDatabase(":memory:");
  const configA = createConfig({
    BASE_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
  });
  const configB = createConfig({
    BASE_CONTRACT_ADDRESS: "0x2222222222222222222222222222222222222222",
  });
  const vaultDb = dbApi as VaultDbApi;

  try {
    dbApi.runMigrations(db);

    vaultDb.getOrCreateVaultCursor(db, configA);
    vaultDb.getOrCreateVaultCursor(db, configB);

    vaultDb.upsertVaultState(db, configA, {
      globalIndexRaw: "11",
      totalSupplyRaw: "111",
      cumulativePerfFeeSharesRaw: "7",
      cumulativeMgmtFeeSharesRaw: "3",
      updatedBlockNumber: 123,
    });
    vaultDb.upsertVaultState(db, configB, {
      globalIndexRaw: "22",
      totalSupplyRaw: "222",
      cumulativePerfFeeSharesRaw: "8",
      cumulativeMgmtFeeSharesRaw: "4",
      updatedBlockNumber: 456,
    });

    assert.deepEqual(vaultDb.readVaultState(db, configA), {
      globalIndexRaw: "11",
      totalSupplyRaw: "111",
      cumulativePerfFeeSharesRaw: "7",
      cumulativeMgmtFeeSharesRaw: "3",
      updatedBlockNumber: 123,
    });
    assert.deepEqual(vaultDb.readVaultState(db, configB), {
      globalIndexRaw: "22",
      totalSupplyRaw: "222",
      cumulativePerfFeeSharesRaw: "8",
      cumulativeMgmtFeeSharesRaw: "4",
      updatedBlockNumber: 456,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("readLatestSnapshot returns null when empty and the highest block snapshot after inserts", () => {
  const db = dbApi.openDatabase(":memory:");
  const vaultDb = dbApi as VaultDbApi;

  try {
    dbApi.runMigrations(db);

    assert.equal(typeof vaultDb.insertSnapshot, "function");
    assert.equal(typeof vaultDb.readLatestSnapshot, "function");
    assert.equal(vaultDb.readLatestSnapshot(db), null);

    vaultDb.insertSnapshot(db, {
      blockNumber: 48578260,
      totalAssetsRaw: "1000",
      totalSupplyRaw: "500",
      capturedAt: 1712345600,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 48578258,
      totalAssetsRaw: "900",
      totalSupplyRaw: "450",
      capturedAt: 1712345500,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 48578261,
      totalAssetsRaw: "1100",
      totalSupplyRaw: "550",
      capturedAt: 1712345700,
    });

    assert.deepEqual(vaultDb.readLatestSnapshot(db), {
      blockNumber: 48578261,
      totalAssetsRaw: "1100",
      totalSupplyRaw: "550",
      capturedAt: 1712345700,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});
