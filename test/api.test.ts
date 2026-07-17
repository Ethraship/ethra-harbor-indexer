import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { loadConfig } from "../src/config";
import {
  closeDatabase,
  getOrCreateVaultCursor,
  insertSnapshot,
  openDatabase,
  runMigrations,
  upsertAccountPosition,
  upsertVaultState,
} from "../src/db";
import { SCALE } from "../src/indexer/ledger";
import { createApiServer } from "../src/api/server";

function createConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    START_BLOCK: "48578254",
    BASE_CONTRACT_ADDRESS: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
    ...overrides,
  });
}

async function startServer(server: ReturnType<typeof createApiServer>): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test("api serves account, vault, and health metrics from indexed state", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const known = "0x1111111111111111111111111111111111111111";
  const server = createApiServer({ db, config });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);

  const cursorBlock = getOrCreateVaultCursor(db, config);
  assert.equal(cursorBlock, 48578254);

  upsertVaultState(db, config, {
    globalIndexRaw: (SCALE / 10n).toString(),
    totalSupplyRaw: "2000000000000000000",
    cumulativePerfFeeSharesRaw: "500000000000000000",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700000,
  });
  upsertAccountPosition(db, {
    address: known,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "200000000000000000",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "200000",
    updatedBlockNumber: 48700000,
    updatedLogIndex: 7,
  });
  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "3000000",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345600,
  });

  const baseUrl = await startServer(server);

  const [healthRes, vaultRes, accountRes] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/vault`),
    fetch(`${baseUrl}/accounts/${known}`),
  ]);

  assert.equal(healthRes.status, 200);
  assert.equal(vaultRes.status, 200);
  assert.equal(accountRes.status, 200);
  assert.equal(healthRes.headers.get("content-type"), "application/json");
  assert.equal(vaultRes.headers.get("content-type"), "application/json");
  assert.equal(accountRes.headers.get("content-type"), "application/json");

  assert.deepEqual(await healthRes.json(), {
    status: "ok",
    cursorBlock: 48578254,
    safeHead: null,
    safeHeadKnown: false,
    syncedToSafeHead: false,
  });

  assert.deepEqual(await vaultRes.json(), {
    totalSupplyRaw: "2000000000000000000",
    totalAssetsRaw: "3000000",
    sharePriceScaledRaw: "1500000",
    sharePriceScale: "1000000000000000000",
    cumulativePerformanceFeeSharesRaw: "500000000000000000",
    cumulativePerformanceFeeValueRaw: "750000",
    valuationBlock: 48700010,
    valuationTime: 1712345600,
  });

  assert.deepEqual(await accountRes.json(), {
    address: known,
    activeDeposit: {
      shares: "1000000000000000000",
      valueRaw: "1500000",
    },
    lifetimeDeposited: {
      raw: "1000000",
    },
    lifetimeWithdrawn: {
      raw: "200000",
    },
    lifetimeEarned: {
      raw: "700000",
    },
    earnedPerformanceFee: {
      shares: "300000000000000000",
      valueRaw: "450000",
    },
    valuationBlock: 48700010,
    valuationTime: 1712345600,
  });
});

test("api GETs do not seed rows on a freshly migrated database", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x4444444444444444444444444444444444444444";
  const server = createApiServer({ db, config });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);

  const baseUrl = await startServer(server);
  const [healthRes, vaultRes, accountRes] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/vault`),
    fetch(`${baseUrl}/accounts/${account}`),
  ]);

  assert.equal(healthRes.status, 200);
  assert.equal(vaultRes.status, 200);
  assert.equal(accountRes.status, 200);

  assert.deepEqual(await healthRes.json(), {
    status: "ok",
    cursorBlock: null,
    safeHead: null,
    safeHeadKnown: false,
    syncedToSafeHead: false,
  });
  assert.deepEqual(await vaultRes.json(), {
    totalSupplyRaw: "0",
    totalAssetsRaw: null,
    sharePriceScaledRaw: null,
    sharePriceScale: "1000000000000000000",
    cumulativePerformanceFeeSharesRaw: "0",
    cumulativePerformanceFeeValueRaw: null,
    valuationBlock: null,
    valuationTime: null,
  });
  assert.deepEqual(await accountRes.json(), {
    address: account,
    activeDeposit: {
      shares: "0",
      valueRaw: null,
    },
    lifetimeDeposited: {
      raw: "0",
    },
    lifetimeWithdrawn: {
      raw: "0",
    },
    lifetimeEarned: {
      raw: null,
    },
    earnedPerformanceFee: {
      shares: "0",
      valueRaw: null,
    },
    valuationBlock: null,
    valuationTime: null,
  });

  const indexerStateCount = db.prepare("SELECT COUNT(*) AS count FROM indexer_state").get() as {
    count: number;
  };
  const vaultRewardStateCount = db.prepare(
    "SELECT COUNT(*) AS count FROM vault_reward_state",
  ).get() as {
    count: number;
  };

  assert.equal(indexerStateCount.count, 0);
  assert.equal(vaultRewardStateCount.count, 0);
});

test("api returns zeros for unknown accounts and 400 for invalid addresses", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const unknown = "0x2222222222222222222222222222222222222222";
  const server = createApiServer({ db, config });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);
  getOrCreateVaultCursor(db, config);
  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "3000000",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345600,
  });

  const baseUrl = await startServer(server);
  const unknownRes = await fetch(`${baseUrl}/accounts/${unknown}`);
  const invalidRes = await fetch(`${baseUrl}/accounts/not-an-address`);

  assert.equal(unknownRes.status, 200);
  assert.equal(invalidRes.status, 400);
  assert.equal(unknownRes.headers.get("content-type"), "application/json");
  assert.equal(invalidRes.headers.get("content-type"), "application/json");

  assert.deepEqual(await unknownRes.json(), {
    address: unknown,
    activeDeposit: {
      shares: "0",
      valueRaw: "0",
    },
    lifetimeDeposited: {
      raw: "0",
    },
    lifetimeWithdrawn: {
      raw: "0",
    },
    lifetimeEarned: {
      raw: "0",
    },
    earnedPerformanceFee: {
      shares: "0",
      valueRaw: "0",
    },
    valuationBlock: 48700010,
    valuationTime: 1712345600,
  });
  assert.deepEqual(await invalidRes.json(), {
    error: "invalid address",
  });
});

test("api returns raw metrics with null valuation fields when no snapshot exists", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x3333333333333333333333333333333333333333";
  const server = createApiServer({ db, config });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);
  getOrCreateVaultCursor(db, config);
  upsertVaultState(db, config, {
    globalIndexRaw: (SCALE / 5n).toString(),
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "100000000000000000",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700000,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "250000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "10000000000000000",
    lifetimeDepositedRaw: "400000",
    lifetimeWithdrawnRaw: "100000",
    updatedBlockNumber: 48700000,
    updatedLogIndex: 4,
  });

  const baseUrl = await startServer(server);
  const accountRes = await fetch(`${baseUrl}/accounts/${account}`);
  const vaultRes = await fetch(`${baseUrl}/vault`);

  assert.equal(accountRes.status, 200);
  assert.equal(vaultRes.status, 200);

  assert.deepEqual(await accountRes.json(), {
    address: account,
    activeDeposit: {
      shares: "250000000000000000",
      valueRaw: null,
    },
    lifetimeDeposited: {
      raw: "400000",
    },
    lifetimeWithdrawn: {
      raw: "100000",
    },
    lifetimeEarned: {
      raw: null,
    },
    earnedPerformanceFee: {
      shares: "60000000000000000",
      valueRaw: null,
    },
    valuationBlock: null,
    valuationTime: null,
  });
  assert.deepEqual(await vaultRes.json(), {
    totalSupplyRaw: "1000000000000000000",
    totalAssetsRaw: null,
    sharePriceScaledRaw: null,
    sharePriceScale: "1000000000000000000",
    cumulativePerformanceFeeSharesRaw: "100000000000000000",
    cumulativePerformanceFeeValueRaw: null,
    valuationBlock: null,
    valuationTime: null,
  });
});

test("api health reports safe head sync status when crawler state is known", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const health = {
    safeHead: 48748007,
  };
  const server = createApiServer({ db, config, health });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);
  getOrCreateVaultCursor(db, config);
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(health.safeHead);

  const baseUrl = await startServer(server);
  const healthRes = await fetch(`${baseUrl}/health`);

  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), {
    status: "ok",
    cursorBlock: 48748007,
    safeHead: 48748007,
    safeHeadKnown: true,
    syncedToSafeHead: true,
  });
});
