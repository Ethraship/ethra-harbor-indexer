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
  readVaultState(db: Parameters<typeof dbApi.closeDatabase>[0]): VaultRewardState;
  readAccountPosition(db: Parameters<typeof dbApi.closeDatabase>[0], address: string): AccountPosition;
  insertSnapshot(db: Parameters<typeof dbApi.closeDatabase>[0], snapshot: Snapshot): void;
  readLatestSnapshot(db: Parameters<typeof dbApi.closeDatabase>[0]): Snapshot | null;
};

function createConfig() {
  return loadConfig({
    START_BLOCK: "48578255",
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
    const state = vaultDb.readVaultState(db);
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
