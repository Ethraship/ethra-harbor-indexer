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
  readLastPerformanceFeeMintBlock(
    db: Parameters<typeof dbApi.closeDatabase>[0],
    config: ReturnType<typeof loadConfig>,
  ): number | null;
  insertSnapshot(db: Parameters<typeof dbApi.closeDatabase>[0], snapshot: Snapshot): void;
  readLatestSnapshot(db: Parameters<typeof dbApi.closeDatabase>[0]): Snapshot | null;
  readLatestSnapshotAtOrBefore(
    db: Parameters<typeof dbApi.closeDatabase>[0],
    maxBlockNumber: number,
  ): Snapshot | null;
  applyChunk(
    db: Parameters<typeof dbApi.closeDatabase>[0],
    config: ReturnType<typeof loadConfig>,
    input: {
      decodedEvents: Array<{
        kind: "deposit";
        sender: string;
        onBehalf: string;
        assets: string;
        shares: string;
        base: {
          chainId: number;
          contractAddress: string;
          blockNumber: number;
          blockHash: string;
          txHash: string;
          txIndex: number;
          logIndex: number;
          rawLogJson: string;
          createdAt: number;
        };
      }>;
      toBlock: number;
    },
  ): void;
  upsertVaultState(
    db: Parameters<typeof dbApi.closeDatabase>[0],
    config: ReturnType<typeof loadConfig>,
    state: VaultRewardState,
  ): void;
};

function createConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    START_BLOCK: "48578254",
    BASE_CONTRACT_ADDRESS: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
    ...overrides,
  });
}

function createDepositEvent(overrides: {
  txHash?: string;
  logIndex?: number;
  blockNumber?: number;
  txIndex?: number;
  sender?: string;
  onBehalf?: string;
  assets?: string;
  shares?: string;
  rawLogJson?: string;
} = {}) {
  return {
    kind: "deposit" as const,
    sender: overrides.sender ?? "0x2222222222222222222222222222222222222222",
    onBehalf: overrides.onBehalf ?? "0x1111111111111111111111111111111111111111",
    assets: overrides.assets ?? "1000",
    shares: overrides.shares ?? "100",
    base: {
      chainId: 8453,
      contractAddress: "0x9D2F57159ecA69265a9B9EFAAa8BC2B6b2dF364d",
      blockNumber: overrides.blockNumber ?? 48578255,
      blockHash: "0xblock-48578255",
      txHash: overrides.txHash ?? "0xtx-deposit-1",
      txIndex: overrides.txIndex ?? 0,
      logIndex: overrides.logIndex ?? 0,
      rawLogJson: overrides.rawLogJson ?? '{"topics":["0xdeadbeef"]}',
      createdAt: 1712345600,
    },
  };
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
    assert.deepEqual(
      indexNames
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

    assert.equal(cursor, 48578254);
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

test("readLastPerformanceFeeMintBlock ignores newer nonzero accruals for other contracts on the same chain", () => {
  const db = dbApi.openDatabase(":memory:");
  const config = createConfig();
  const vaultDb = dbApi as VaultDbApi;

  try {
    dbApi.runMigrations(db);

    vaultDb.insertAccrueInterestEvent(db, {
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      blockNumber: 48700001,
      blockHash: "0xblock-1",
      txHash: "0xtx-1",
      txIndex: 0,
      logIndex: 1,
      previousTotalAssets: "1000000",
      newTotalAssets: "1000001",
      performanceFeeShares: "0",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "0",
      rawLogJson: "{}",
      createdAt: 1712345600,
    });
    vaultDb.insertAccrueInterestEvent(db, {
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      blockNumber: 48700003,
      blockHash: "0xblock-3",
      txHash: "0xtx-3",
      txIndex: 0,
      logIndex: 2,
      previousTotalAssets: "1000001",
      newTotalAssets: "1000002",
      performanceFeeShares: "15",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "15",
      rawLogJson: "{}",
      createdAt: 1712345601,
    });
    vaultDb.insertAccrueInterestEvent(db, {
      chainId: 8454,
      contractAddress: config.contractAddress,
      blockNumber: 48700004,
      blockHash: "0xblock-4",
      txHash: "0xtx-4",
      txIndex: 1,
      logIndex: 3,
      previousTotalAssets: "1000002",
      newTotalAssets: "1000003",
      performanceFeeShares: "25",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "40",
      rawLogJson: "{}",
      createdAt: 1712345602,
    });
    vaultDb.insertAccrueInterestEvent(db, {
      chainId: config.chainId,
      contractAddress: "0x1111111111111111111111111111111111111111",
      blockNumber: 48700005,
      blockHash: "0xblock-5",
      txHash: "0xtx-5",
      txIndex: 0,
      logIndex: 4,
      previousTotalAssets: "1000003",
      newTotalAssets: "1000004",
      performanceFeeShares: "35",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "75",
      rawLogJson: "{}",
      createdAt: 1712345603,
    });

    assert.equal(vaultDb.readLastPerformanceFeeMintBlock(db, config), 48700003);
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("readLastPerformanceFeeMintBlock returns null when no nonzero performance fee exists", () => {
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

    vaultDb.insertAccrueInterestEvent(db, {
      chainId: configB.chainId,
      contractAddress: configB.contractAddress,
      blockNumber: 48700001,
      blockHash: "0xblock-1",
      txHash: "0xtx-1",
      txIndex: 0,
      logIndex: 1,
      previousTotalAssets: "1000000",
      newTotalAssets: "1000001",
      performanceFeeShares: "0",
      managementFeeShares: "0",
      totalSupplyBeforeRaw: "1000000000000000000",
      globalIndexAfterRaw: "0",
      rawLogJson: "{}",
      createdAt: 1712345600,
    });

    assert.equal(vaultDb.readLastPerformanceFeeMintBlock(db, configA), null);
    assert.equal(vaultDb.readLastPerformanceFeeMintBlock(db, configB), null);
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

    vaultDb.insertSnapshot(db, {
      blockNumber: 48578261,
      totalAssetsRaw: "1150",
      totalSupplyRaw: "575",
      capturedAt: 1712345800,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 48578261,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1712345800,
    });

    assert.deepEqual(vaultDb.readLatestSnapshot(db), {
      blockNumber: 48578261,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1712345800,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("readLatestSnapshotAtOrBefore returns the newest deterministic eligible snapshot", () => {
  const db = dbApi.openDatabase(":memory:");
  const vaultDb = dbApi as VaultDbApi;

  try {
    dbApi.runMigrations(db);

    assert.equal(typeof vaultDb.readLatestSnapshotAtOrBefore, "function");
    assert.equal(vaultDb.readLatestSnapshotAtOrBefore(db, 99), null);

    vaultDb.insertSnapshot(db, {
      blockNumber: 100,
      totalAssetsRaw: "1000",
      totalSupplyRaw: "500",
      capturedAt: 1000,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 110,
      totalAssetsRaw: "1100",
      totalSupplyRaw: "550",
      capturedAt: 1100,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 110,
      totalAssetsRaw: "1150",
      totalSupplyRaw: "575",
      capturedAt: 1200,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 110,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1200,
    });
    vaultDb.insertSnapshot(db, {
      blockNumber: 120,
      totalAssetsRaw: "1300",
      totalSupplyRaw: "650",
      capturedAt: 1300,
    });

    assert.deepEqual(vaultDb.readLatestSnapshotAtOrBefore(db, 109), {
      blockNumber: 100,
      totalAssetsRaw: "1000",
      totalSupplyRaw: "500",
      capturedAt: 1000,
    });
    assert.deepEqual(vaultDb.readLatestSnapshotAtOrBefore(db, 110), {
      blockNumber: 110,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1200,
    });
    assert.deepEqual(vaultDb.readLatestSnapshotAtOrBefore(db, 119), {
      blockNumber: 110,
      totalAssetsRaw: "1200",
      totalSupplyRaw: "600",
      capturedAt: 1200,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("applyChunk rejects duplicate raw log identities inside one chunk and rolls everything back", () => {
  const db = dbApi.openDatabase(":memory:");
  const config = createConfig();
  const vaultDb = dbApi as VaultDbApi;
  const duplicate = createDepositEvent();

  try {
    dbApi.runMigrations(db);

    assert.throws(
      () => {
        vaultDb.applyChunk(db, config, {
          decodedEvents: [duplicate, duplicate],
          toBlock: 48578255,
        });
      },
      /duplicate raw vault log/i,
    );

    assert.equal(vaultDb.getOrCreateVaultCursor(db, config), 48578254);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM deposit_events").get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.deepEqual(
      vaultDb.readAccountPosition(db, duplicate.onBehalf),
      {
        address: duplicate.onBehalf,
        balanceRaw: "0",
        rewardDebtRaw: "0",
        earnedPerfFeeSharesRaw: "0",
        lifetimeDepositedRaw: "0",
        lifetimeWithdrawnRaw: "0",
        updatedBlockNumber: 0,
        updatedLogIndex: 0,
      },
    );
  } finally {
    dbApi.closeDatabase(db);
  }
});

test("applyChunk rejects already-persisted raw log identities before ledger mutation", () => {
  const db = dbApi.openDatabase(":memory:");
  const config = createConfig();
  const vaultDb = dbApi as VaultDbApi;
  const persisted = createDepositEvent();

  try {
    dbApi.runMigrations(db);

    vaultDb.applyChunk(db, config, {
      decodedEvents: [persisted],
      toBlock: 48578255,
    });

    assert.equal(vaultDb.getOrCreateVaultCursor(db, config), 48578255);
    assert.deepEqual(vaultDb.readAccountPosition(db, persisted.onBehalf), {
      address: persisted.onBehalf,
      balanceRaw: "0",
      rewardDebtRaw: "0",
      earnedPerfFeeSharesRaw: "0",
      lifetimeDepositedRaw: "1000",
      lifetimeWithdrawnRaw: "0",
      updatedBlockNumber: 48578255,
      updatedLogIndex: 0,
    });

    assert.throws(
      () => {
        vaultDb.applyChunk(db, config, {
          decodedEvents: [persisted],
          toBlock: 48578256,
        });
      },
      /already-persisted raw vault log/i,
    );

    assert.equal(vaultDb.getOrCreateVaultCursor(db, config), 48578255);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM deposit_events").get() as {
          count: number;
        }
      ).count,
      1,
    );
    assert.deepEqual(vaultDb.readAccountPosition(db, persisted.onBehalf), {
      address: persisted.onBehalf,
      balanceRaw: "0",
      rewardDebtRaw: "0",
      earnedPerfFeeSharesRaw: "0",
      lifetimeDepositedRaw: "1000",
      lifetimeWithdrawnRaw: "0",
      updatedBlockNumber: 48578255,
      updatedLogIndex: 0,
    });
  } finally {
    dbApi.closeDatabase(db);
  }
});
