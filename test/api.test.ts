import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { loadConfig } from "../src/config";
import {
  closeDatabase,
  getOrCreateVaultCursor,
  insertAccrueInterestEvent,
  insertSnapshot,
  insertTransferEvent,
  insertWithdrawEvent,
  openDatabase,
  runMigrations,
  upsertAccountPosition,
  upsertWalletAdditionalBoostBps,
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

test("api serves the dashboard shell and static assets", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
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
  const [dashboardRes, dashboardSlashRes, cssRes, jsRes, missingRes] =
    await Promise.all([
      fetch(`${baseUrl}/dashboard`),
      fetch(`${baseUrl}/dashboard/`),
      fetch(`${baseUrl}/dashboard/styles.css`),
      fetch(`${baseUrl}/dashboard/app.js`),
      fetch(`${baseUrl}/dashboard/missing.js`),
    ]);

  assert.equal(dashboardRes.status, 200);
  assert.equal(dashboardSlashRes.status, 200);
  assert.equal(cssRes.status, 200);
  assert.equal(jsRes.status, 200);
  assert.equal(missingRes.status, 404);

  assert.match(dashboardRes.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(cssRes.headers.get("content-type") ?? "", /^text\/css/);
  assert.match(jsRes.headers.get("content-type") ?? "", /^text\/javascript/);

  const html = await dashboardRes.text();
  assert.match(html, /Ethra Harbor Dashboard/);
  assert.match(html, /\/dashboard\/styles\.css/);
  assert.match(html, /\/dashboard\/app\.js/);

  const js = await jsRes.text();
  assert.match(js, /Estimated net earned/);
  assert.match(js, /Gross generated yield/);
  assert.match(js, /Estimated performance fee/);
  assert.match(js, /Estimate freshness/);
  assert.match(js, /estimatedNetLifetimeEarned/);
  assert.match(js, /blocksSincePerformanceFeeMint/);

  assert.deepEqual(await missingRes.json(), {
    error: "not found",
  });
});

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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700010);

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
    cursorBlock: 48700010,
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
    blockContext: {
      currentBlock: 48700010,
      lastProcessedLogBlock: 48700010,
    },
  });

  assert.deepEqual(await accountRes.json(), {
    address: known,
    activeDeposit: {
      shares: "1000000000000000000",
      valueRaw: "1375000",
    },
    lifetimeDeposited: {
      raw: "1000000",
    },
    lifetimeWithdrawn: {
      raw: "200000",
    },
    lifetimeEarned: {
      raw: "575000",
    },
    grossLifetimeEarned: {
      raw: "1150000",
    },
    estimatedNetLifetimeEarned: {
      raw: "575000",
      performanceFeeRateBps: "5000",
    },
    estimatedPerformanceFee: {
      raw: "575000",
    },
    boost: {
      baseBoostBps: "40000",
      additionalBoostBps: "0",
      totalBoostBps: "40000",
    },
    vship: {
      crystallizedRaw: "0",
      pendingRaw: "46000000",
      totalRaw: "46000000",
      feeWatermarkRaw: "0",
      priceUsdRaw: "50000",
      priceUsdDecimals: 6,
    },
    earnedPerformanceFee: {
      shares: "300000000000000000",
      valueRaw: "450000",
    },
    blockContext: {
      currentBlock: 48700010,
      lastProcessedLogBlock: 48700010,
      lastPerformanceFeeMintBlock: null,
      blocksSincePerformanceFeeMint: null,
    },
    valuationBlock: 48700010,
    valuationTime: 1712345600,
  });
});

test("account metrics include base boost and pending vSHIP from estimated fee", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x1212121212121212121212121212121212121212";
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
  db.prepare("UPDATE indexer_state SET last_scanned_block = ?").run(48700010);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700010,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "0",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700010,
    updatedLogIndex: 0,
  });
  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "2000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1712345600,
  });

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/accounts/${account}`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.estimatedPerformanceFee.raw, "1000000");
  assert.deepEqual(body.boost, {
    baseBoostBps: "40000",
    additionalBoostBps: "0",
    totalBoostBps: "40000",
  });
  assert.deepEqual(body.vship, {
    crystallizedRaw: "0",
    pendingRaw: "80000000",
    totalRaw: "80000000",
    feeWatermarkRaw: "0",
    priceUsdRaw: "50000",
    priceUsdDecimals: 6,
  });
});

test("pre-deposit wallet_boost still returns additional boost with zero vSHIP", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x3434343434343434343434343434343434343434";
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
  upsertWalletAdditionalBoostBps(db, account, 100000n, 1);

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/accounts/${account}`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.boost, {
    baseBoostBps: "40000",
    additionalBoostBps: "100000",
    totalBoostBps: "140000",
  });
  assert.deepEqual(body.vship, {
    crystallizedRaw: "0",
    pendingRaw: "0",
    totalRaw: "0",
    feeWatermarkRaw: "0",
    priceUsdRaw: "50000",
    priceUsdDecimals: 6,
  });
});

test("api values active deposits with estimated net earnings while preserving losses", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const profitableAccount = "0x8888888888888888888888888888888888888888";
  const lossAccount = "0x9999999999999999999999999999999999999999";
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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700010);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "2000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700000,
  });
  upsertAccountPosition(db, {
    address: profitableAccount,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700000,
    updatedLogIndex: 1,
  });
  upsertAccountPosition(db, {
    address: lossAccount,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700000,
    updatedLogIndex: 2,
  });

  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "2200000",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345600,
  });

  const baseUrl = await startServer(server);
  const profitableBody = await (
    await fetch(`${baseUrl}/accounts/${profitableAccount}`)
  ).json();

  assert.equal(profitableBody.activeDeposit.valueRaw, "1050000");
  assert.equal(profitableBody.lifetimeEarned.raw, "50000");
  assert.equal(profitableBody.estimatedNetLifetimeEarned.raw, "50000");

  db.prepare(`
    DELETE FROM share_price_snapshots
  `).run();
  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "1800000",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345601,
  });

  const refreshedLossBody = await (await fetch(`${baseUrl}/accounts/${lossAccount}`)).json();

  assert.equal(refreshedLossBody.activeDeposit.valueRaw, "900000");
  assert.equal(refreshedLossBody.lifetimeEarned.raw, "0");
  assert.equal(refreshedLossBody.estimatedNetLifetimeEarned.raw, "0");
});

test("api clamps rounded estimated performance fee to net earned and reports freshness", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x5555555555555555555555555555555555555555";
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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700008);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "2000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700000,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700000,
    updatedLogIndex: 3,
  });
  insertSnapshot(db, {
    blockNumber: 48700006,
    totalAssetsRaw: "3000302",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345540,
  });
  insertSnapshot(db, {
    blockNumber: 48700010,
    totalAssetsRaw: "3000302",
    totalSupplyRaw: "2000000000000000000",
    capturedAt: 1712345600,
  });
  insertAccrueInterestEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48700004,
    blockHash: "0xblock-4",
    txHash: "0xtx-4",
    txIndex: 0,
    logIndex: 1,
    previousTotalAssets: "3000000",
    newTotalAssets: "3000001",
    performanceFeeShares: "0",
    managementFeeShares: "0",
    totalSupplyBeforeRaw: "2000000000000000000",
    globalIndexAfterRaw: "0",
    rawLogJson: "{}",
    createdAt: 1712345600,
  });
  insertAccrueInterestEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48700005,
    blockHash: "0xblock-5",
    txHash: "0xtx-5",
    txIndex: 0,
    logIndex: 2,
    previousTotalAssets: "3000001",
    newTotalAssets: "3000002",
    performanceFeeShares: "1",
    managementFeeShares: "0",
    totalSupplyBeforeRaw: "2000000000000000000",
    globalIndexAfterRaw: "1",
    rawLogJson: "{}",
    createdAt: 1712345601,
  });

  const baseUrl = await startServer(server);
  const accountRes = await fetch(`${baseUrl}/accounts/${account}`);

  assert.equal(accountRes.status, 200);
  const body = await accountRes.json();

  assert.deepEqual(body.grossLifetimeEarned, {
    raw: "500151",
  });
  assert.deepEqual(body.estimatedNetLifetimeEarned, {
    raw: "250075",
    performanceFeeRateBps: "5000",
  });
  assert.deepEqual(body.estimatedPerformanceFee, {
    raw: "250075",
  });
  assert.deepEqual(body.blockContext, {
    currentBlock: 48700010,
    lastProcessedLogBlock: 48700008,
    lastPerformanceFeeMintBlock: 48700005,
    blocksSincePerformanceFeeMint: 5,
  });
  assert.equal(body.valuationBlock, 48700006);
  assert.equal(body.valuationTime, 1712345540);
});

test("api promotes one cursor-eligible snapshot for account and vault valuation", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x6666666666666666666666666666666666666666";
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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700110);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700110,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700110,
    updatedLogIndex: 0,
  });
  insertSnapshot(db, {
    blockNumber: 48700100,
    totalAssetsRaw: "1000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1712345600,
  });
  insertSnapshot(db, {
    blockNumber: 48700120,
    totalAssetsRaw: "2000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1712345660,
  });

  const baseUrl = await startServer(server);
  const firstAccount = await (await fetch(`${baseUrl}/accounts/${account}`)).json();
  const firstVault = await (await fetch(`${baseUrl}/vault`)).json();

  assert.deepEqual(firstAccount.activeDeposit, {
    shares: "1000000000000000000",
    valueRaw: "1000000",
  });
  assert.deepEqual(firstAccount.blockContext, {
    currentBlock: 48700120,
    lastProcessedLogBlock: 48700110,
    lastPerformanceFeeMintBlock: null,
    blocksSincePerformanceFeeMint: null,
  });
  assert.equal(firstAccount.valuationBlock, 48700100);
  assert.equal(firstVault.totalAssetsRaw, "1000000");
  assert.equal(firstVault.valuationBlock, 48700100);
  assert.deepEqual(firstVault.blockContext, {
    currentBlock: 48700120,
    lastProcessedLogBlock: 48700110,
  });

  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700120);

  const promotedAccount = await (await fetch(`${baseUrl}/accounts/${account}`)).json();
  const promotedVault = await (await fetch(`${baseUrl}/vault`)).json();

  assert.equal(promotedAccount.activeDeposit.valueRaw, "1500000");
  assert.equal(promotedAccount.valuationBlock, 48700120);
  assert.equal(promotedVault.totalAssetsRaw, "2000000");
  assert.equal(promotedVault.valuationBlock, 48700120);
});

test("api replays processed fee-mint logs after the eligible snapshot before valuing accounts", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x4eC969C24e0Aa04106b8F40a594a18dF37a6e215";
  const feeRecipient = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48853290);

  const postShares = 18996991748348250188n;
  const burnedShares = 999792937035575196n;
  const mintedFeeShares = 742099715642628n;
  const earnedFeeShares = 925320867466409n;
  const postSupply = postShares * 100n;
  const preSupply = postSupply + burnedShares - mintedFeeShares;
  const preMintAssets = 1901126977n;
  const postMintAssets = 1900092600n;

  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: postSupply.toString(),
    cumulativePerfFeeSharesRaw: earnedFeeShares.toString(),
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48853280,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: postShares.toString(),
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: earnedFeeShares.toString(),
    lifetimeDepositedRaw: "39000000",
    lifetimeWithdrawnRaw: "20000000",
    updatedBlockNumber: 48853280,
    updatedLogIndex: 4,
  });
  insertSnapshot(db, {
    blockNumber: 48853260,
    totalAssetsRaw: preMintAssets.toString(),
    totalSupplyRaw: preSupply.toString(),
    capturedAt: 1784495868156,
  });
  insertAccrueInterestEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48853280,
    blockHash: "0xblock-48853280",
    txHash: "0xtx-fee-minting-withdraw",
    txIndex: 0,
    logIndex: 1,
    previousTotalAssets: preMintAssets.toString(),
    newTotalAssets: (postMintAssets + 1000000n).toString(),
    performanceFeeShares: mintedFeeShares.toString(),
    managementFeeShares: "0",
    totalSupplyBeforeRaw: preSupply.toString(),
    globalIndexAfterRaw: "0",
    rawLogJson: "{}",
    createdAt: 1784495800000,
  });
  insertWithdrawEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48853280,
    blockHash: "0xblock-48853280",
    txHash: "0xtx-fee-minting-withdraw",
    txIndex: 0,
    logIndex: 2,
    sender: account,
    receiver: account,
    onBehalf: account,
    assets: "1000000",
    shares: burnedShares.toString(),
    rawLogJson: "{}",
    createdAt: 1784495800000,
  });
  insertTransferEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48853280,
    blockHash: "0xblock-48853280",
    txHash: "0xtx-fee-minting-withdraw",
    txIndex: 0,
    logIndex: 3,
    fromAddress: account,
    toAddress: "0x0000000000000000000000000000000000000000",
    shares: burnedShares.toString(),
    rawLogJson: "{}",
    createdAt: 1784495800000,
  });
  insertTransferEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: 48853280,
    blockHash: "0xblock-48853280",
    txHash: "0xtx-fee-minting-withdraw",
    txIndex: 0,
    logIndex: 4,
    fromAddress: "0x0000000000000000000000000000000000000000",
    toAddress: feeRecipient,
    shares: mintedFeeShares.toString(),
    rawLogJson: "{}",
    createdAt: 1784495800000,
  });

  const baseUrl = await startServer(server);
  const accountBody = await (await fetch(`${baseUrl}/accounts/${account}`)).json();
  const vaultBody = await (await fetch(`${baseUrl}/vault`)).json();

  assert.equal(accountBody.activeDeposit.valueRaw, "19000925");
  assert.equal(accountBody.lifetimeEarned.raw, "925");
  assert.equal(accountBody.grossLifetimeEarned.raw, "1851");
  assert.equal(accountBody.estimatedNetLifetimeEarned.raw, "925");
  assert.equal(accountBody.estimatedPerformanceFee.raw, "925");
  assert.deepEqual(accountBody.earnedPerformanceFee, {
    shares: earnedFeeShares.toString(),
    valueRaw: "925",
  });
  assert.deepEqual(accountBody.blockContext, {
    currentBlock: 48853260,
    lastProcessedLogBlock: 48853290,
    lastPerformanceFeeMintBlock: 48853280,
    blocksSincePerformanceFeeMint: 10,
  });
  assert.equal(accountBody.valuationBlock, 48853280);
  assert.equal(accountBody.valuationTime, 1784495868156);

  assert.equal(vaultBody.totalSupplyRaw, postSupply.toString());
  assert.equal(vaultBody.totalAssetsRaw, postMintAssets.toString());
  assert.equal(vaultBody.valuationBlock, 48853280);
});

test("api reports observed freshness but null valuation when only pending snapshots exist", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const account = "0x7777777777777777777777777777777777777777";
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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700110);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "100000000000000000",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: 48700110,
  });
  upsertAccountPosition(db, {
    address: account,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "100000000000000000",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: 48700110,
    updatedLogIndex: 0,
  });
  insertSnapshot(db, {
    blockNumber: 48700120,
    totalAssetsRaw: "2000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1712345660,
  });

  const baseUrl = await startServer(server);
  const accountBody = await (await fetch(`${baseUrl}/accounts/${account}`)).json();
  const vaultBody = await (await fetch(`${baseUrl}/vault`)).json();

  assert.deepEqual(accountBody.activeDeposit, {
    shares: "1000000000000000000",
    valueRaw: null,
  });
  assert.deepEqual(accountBody.earnedPerformanceFee, {
    shares: "100000000000000000",
    valueRaw: null,
  });
  assert.deepEqual(accountBody.blockContext, {
    currentBlock: 48700120,
    lastProcessedLogBlock: 48700110,
    lastPerformanceFeeMintBlock: null,
    blocksSincePerformanceFeeMint: null,
  });
  assert.equal(accountBody.lifetimeEarned.raw, null);
  assert.equal(accountBody.grossLifetimeEarned.raw, null);
  assert.equal(accountBody.estimatedNetLifetimeEarned.raw, null);
  assert.equal(accountBody.estimatedPerformanceFee.raw, null);
  assert.equal(accountBody.valuationBlock, null);
  assert.equal(accountBody.valuationTime, null);

  assert.deepEqual(vaultBody, {
    totalSupplyRaw: "1000000000000000000",
    totalAssetsRaw: null,
    sharePriceScaledRaw: null,
    sharePriceScale: "1000000000000000000",
    cumulativePerformanceFeeSharesRaw: "100000000000000000",
    cumulativePerformanceFeeValueRaw: null,
    valuationBlock: null,
    valuationTime: null,
    blockContext: {
      currentBlock: 48700120,
      lastProcessedLogBlock: 48700110,
    },
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
    blockContext: {
      currentBlock: null,
      lastProcessedLogBlock: null,
    },
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
    grossLifetimeEarned: {
      raw: null,
    },
    estimatedNetLifetimeEarned: {
      raw: null,
      performanceFeeRateBps: "5000",
    },
    estimatedPerformanceFee: {
      raw: null,
    },
    boost: {
      baseBoostBps: "40000",
      additionalBoostBps: "0",
      totalBoostBps: "40000",
    },
    vship: {
      crystallizedRaw: "0",
      pendingRaw: "0",
      totalRaw: "0",
      feeWatermarkRaw: "0",
      priceUsdRaw: "50000",
      priceUsdDecimals: 6,
    },
    earnedPerformanceFee: {
      shares: "0",
      valueRaw: null,
    },
    blockContext: {
      currentBlock: null,
      lastProcessedLogBlock: null,
      lastPerformanceFeeMintBlock: null,
      blocksSincePerformanceFeeMint: null,
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
  db.prepare(`
    UPDATE indexer_state
    SET last_scanned_block = ?
  `).run(48700010);
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
    grossLifetimeEarned: {
      raw: "0",
    },
    estimatedNetLifetimeEarned: {
      raw: "0",
      performanceFeeRateBps: "5000",
    },
    estimatedPerformanceFee: {
      raw: "0",
    },
    boost: {
      baseBoostBps: "40000",
      additionalBoostBps: "0",
      totalBoostBps: "40000",
    },
    vship: {
      crystallizedRaw: "0",
      pendingRaw: "0",
      totalRaw: "0",
      feeWatermarkRaw: "0",
      priceUsdRaw: "50000",
      priceUsdDecimals: 6,
    },
    earnedPerformanceFee: {
      shares: "0",
      valueRaw: "0",
    },
    blockContext: {
      currentBlock: 48700010,
      lastProcessedLogBlock: 48700010,
      lastPerformanceFeeMintBlock: null,
      blocksSincePerformanceFeeMint: null,
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
    grossLifetimeEarned: {
      raw: null,
    },
    estimatedNetLifetimeEarned: {
      raw: null,
      performanceFeeRateBps: "5000",
    },
    estimatedPerformanceFee: {
      raw: null,
    },
    boost: {
      baseBoostBps: "40000",
      additionalBoostBps: "0",
      totalBoostBps: "40000",
    },
    vship: {
      crystallizedRaw: "0",
      pendingRaw: "0",
      totalRaw: "0",
      feeWatermarkRaw: "0",
      priceUsdRaw: "50000",
      priceUsdDecimals: 6,
    },
    earnedPerformanceFee: {
      shares: "60000000000000000",
      valueRaw: null,
    },
    blockContext: {
      currentBlock: null,
      lastProcessedLogBlock: 48578254,
      lastPerformanceFeeMintBlock: null,
      blocksSincePerformanceFeeMint: null,
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
    blockContext: {
      currentBlock: null,
      lastProcessedLogBlock: 48578254,
    },
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

const ADMIN_ADDRESS = "0x5555555555555555555555555555555555555555";
const ADMIN_CURSOR_BLOCK = 100;

function seedReadyAdminDatabase(db: ReturnType<typeof openDatabase>, config: ReturnType<typeof createConfig>): void {
  runMigrations(db);
  getOrCreateVaultCursor(db, config);
  db.prepare("UPDATE indexer_state SET last_scanned_block = ?").run(ADMIN_CURSOR_BLOCK);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: ADMIN_CURSOR_BLOCK,
  });
  upsertAccountPosition(db, {
    address: ADMIN_ADDRESS,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: ADMIN_CURSOR_BLOCK,
    updatedLogIndex: 0,
  });
  insertSnapshot(db, {
    blockNumber: ADMIN_CURSOR_BLOCK,
    totalAssetsRaw: "3000000",
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1,
  });
}

function setAdminEstimatedFee(db: ReturnType<typeof openDatabase>, feeRaw: bigint): void {
  db.prepare("UPDATE share_price_snapshots SET total_assets_raw = ?").run(
    (1_000_000n + feeRaw * 2n).toString(),
  );
}

async function closeApiTestServer(
  server: ReturnType<typeof createApiServer>,
  db: ReturnType<typeof openDatabase>,
): Promise<void> {
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
}

test("admin routes are 404 when ADMIN_API_TOKEN is unset", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const server = createApiServer({ db, config, health: { safeHead: 1 } });
  t.after(() => closeApiTestServer(server, db));
  runMigrations(db);

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/admin/boost/base`, {
    method: "PUT",
    body: JSON.stringify({ baseBoostBps: "50000" }),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
});

test("enabled admin routes require bearer token", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  const server = createApiServer({ db, config, health: { safeHead: 1 } });
  t.after(() => closeApiTestServer(server, db));
  runMigrations(db);

  const baseUrl = await startServer(server);
  const [missingToken, wrongToken] = await Promise.all([
    fetch(`${baseUrl}/admin/boost/base`, {
      method: "PUT",
      body: JSON.stringify({ baseBoostBps: "50000" }),
    }),
    fetch(`${baseUrl}/admin/boost/base`, {
      method: "PUT",
      headers: { Authorization: "Bearer wrong" },
      body: JSON.stringify({ baseBoostBps: "50000" }),
    }),
  ]);

  assert.equal(missingToken.status, 401);
  assert.equal(wrongToken.status, 401);
  assert.deepEqual(await missingToken.json(), { error: "unauthorized" });
  assert.deepEqual(await wrongToken.json(), { error: "unauthorized" });
});

test("PUT base boost settles and updates config when ready", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  seedReadyAdminDatabase(db, config);
  const server = createApiServer({
    db,
    config,
    health: { safeHead: ADMIN_CURSOR_BLOCK },
  });
  t.after(() => closeApiTestServer(server, db));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/admin/boost/base`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ baseBoostBps: "50000" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });

  const accountResponse = await fetch(`${baseUrl}/accounts/${ADMIN_ADDRESS}`);
  const account = await accountResponse.json();
  assert.equal(account.boost.baseBoostBps, "50000");
  assert.equal(account.vship.crystallizedRaw, "80000000");
  assert.equal(account.vship.feeWatermarkRaw, "1000000");

  const [changesResponse, settlementsResponse] = await Promise.all([
    fetch(`${baseUrl}/admin/boost/changes`, {
      headers: { Authorization: "Bearer secret" },
    }),
    fetch(`${baseUrl}/admin/vship/settlements/${ADMIN_ADDRESS}`, {
      headers: { Authorization: "Bearer secret" },
    }),
  ]);
  const changes = await changesResponse.json();
  const settlements = await settlementsResponse.json();

  assert.equal(changesResponse.status, 200);
  assert.equal(settlementsResponse.status, 200);
  assert.equal(changes.length, 1);
  assert.equal(settlements.length, 1);
});

test("PUT boost returns 409 when indexer not ready", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  seedReadyAdminDatabase(db, config);
  const server = createApiServer({ db, config, health: { safeHead: null } });
  t.after(() => closeApiTestServer(server, db));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/admin/boost/base`, {
    method: "PUT",
    headers: { Authorization: "Bearer secret" },
    body: JSON.stringify({ baseBoostBps: "50000" }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "indexer not ready" });
});

test("PUT boost returns 409 when fee mint is stale", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  seedReadyAdminDatabase(db, config);
  db.prepare("UPDATE reward_config SET fee_mint_stale_blocks = ?").run(5);
  insertAccrueInterestEvent(db, {
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    blockNumber: ADMIN_CURSOR_BLOCK - 5,
    blockHash: "0xblock",
    txHash: "0xtx",
    txIndex: 0,
    logIndex: 0,
    previousTotalAssets: "0",
    newTotalAssets: "0",
    performanceFeeShares: "1",
    managementFeeShares: "0",
    totalSupplyBeforeRaw: "0",
    globalIndexAfterRaw: "0",
    rawLogJson: "{}",
    createdAt: 1,
  });
  const server = createApiServer({
    db,
    config,
    health: { safeHead: ADMIN_CURSOR_BLOCK },
  });
  t.after(() => closeApiTestServer(server, db));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/admin/boost/base`, {
    method: "PUT",
    headers: { Authorization: "Bearer secret" },
    body: JSON.stringify({ baseBoostBps: "50000" }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "fee mint is stale" });
});

test("GET admin history endpoints return newest-first rows", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  seedReadyAdminDatabase(db, config);
  const server = createApiServer({
    db,
    config,
    health: { safeHead: ADMIN_CURSOR_BLOCK },
  });
  t.after(() => closeApiTestServer(server, db));

  const baseUrl = await startServer(server);
  const headers = {
    Authorization: "Bearer secret",
    "Content-Type": "application/json",
  };
  await fetch(`${baseUrl}/admin/boost/wallets/${ADMIN_ADDRESS}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ additionalBoostBps: "100000" }),
  });
  setAdminEstimatedFee(db, 2_000_000n);
  await fetch(`${baseUrl}/admin/boost/wallets/${ADMIN_ADDRESS}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ additionalBoostBps: "200000" }),
  });

  const [changesResponse, settlementsResponse] = await Promise.all([
    fetch(`${baseUrl}/admin/boost/changes`, { headers }),
    fetch(`${baseUrl}/admin/vship/settlements/${ADMIN_ADDRESS}`, { headers }),
  ]);
  const changes = await changesResponse.json();
  const settlements = await settlementsResponse.json();

  assert.equal(changesResponse.status, 200);
  assert.equal(settlementsResponse.status, 200);
  assert.equal(changes[0].oldBps, "100000");
  assert.equal(changes[0].newBps, "200000");
  assert.equal(typeof changes[0].oldBps, "string");
  assert.equal(typeof changes[0].newBps, "string");
  assert.equal(settlements[0].feeBeforeRaw, "1000000");
  assert.equal(settlements[0].feeAfterRaw, "2000000");
  assert.equal(settlements[0].feeDeltaRaw, "1000000");
  assert.equal(settlements[0].boostBpsApplied, "140000");
  assert.equal(settlements[0].vshipMintedRaw, "280000000");
  assert.equal(settlements[0].crystallizedVshipAfterRaw, "360000000");
  assert.equal(typeof settlements[0].feeBeforeRaw, "string");
  assert.equal(typeof settlements[0].feeAfterRaw, "string");
  assert.equal(typeof settlements[0].feeDeltaRaw, "string");
  assert.equal(typeof settlements[0].boostBpsApplied, "string");
  assert.equal(typeof settlements[0].vshipMintedRaw, "string");
  assert.equal(typeof settlements[0].crystallizedVshipAfterRaw, "string");
});

test("PUT transaction failure returns 500 and rolls back all reward writes", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  seedReadyAdminDatabase(db, config);
  db.exec(`
    CREATE TRIGGER abort_reward_config_update
    BEFORE UPDATE ON reward_config
    BEGIN
      SELECT RAISE(ABORT, 'stop update');
    END;
  `);
  const server = createApiServer({
    db,
    config,
    health: { safeHead: ADMIN_CURSOR_BLOCK },
  });
  t.after(() => closeApiTestServer(server, db));

  const baseUrl = await startServer(server);
  const response = await fetch(`${baseUrl}/admin/boost/base`, {
    method: "PUT",
    headers: { Authorization: "Bearer secret" },
    body: JSON.stringify({ baseBoostBps: "50000" }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal server error" });
  assert.equal(
    (db.prepare("SELECT base_boost_bps FROM reward_config WHERE id = 1").get() as {
      base_boost_bps: string;
    }).base_boost_bps,
    "40000",
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM wallet_vship_state").get() as {
      count: number;
    }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM boost_change_events").get() as {
      count: number;
    }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM vship_settlement_events").get() as {
      count: number;
    }).count,
    0,
  );
});
