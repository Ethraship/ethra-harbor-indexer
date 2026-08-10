import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";
import {
  closeDatabase,
  getOrCreateVaultCursor,
  insertAccrueInterestEvent,
  insertSnapshot,
  openDatabase,
  runMigrations,
  upsertAccountPosition,
  upsertVaultState,
} from "../src/db";
import {
  listBoostChangeEvents,
  listVshipSettlementEvents,
  readWalletVshipState,
} from "../src/db/rewards";
import {
  assertFeeMintFresh,
  assertMutationReady,
  MutationNotReadyError,
  setWalletAdditionalBoost,
  settleWallet,
  StaleFeeMintError,
} from "../src/rewards/settle";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const CURSOR_BLOCK = 100;

function createConfig() {
  return loadConfig({
    START_BLOCK: "0",
    BASE_CONTRACT_ADDRESS: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
  });
}

function seedIndexedAccount(totalAssetsRaw = "3000000") {
  const db = openDatabase(":memory:");
  const config = createConfig();
  runMigrations(db);
  getOrCreateVaultCursor(db, config);
  db.prepare("UPDATE indexer_state SET last_scanned_block = ?").run(CURSOR_BLOCK);
  upsertVaultState(db, config, {
    globalIndexRaw: "0",
    totalSupplyRaw: "1000000000000000000",
    cumulativePerfFeeSharesRaw: "0",
    cumulativeMgmtFeeSharesRaw: "0",
    updatedBlockNumber: CURSOR_BLOCK,
  });
  upsertAccountPosition(db, {
    address: ADDRESS,
    balanceRaw: "1000000000000000000",
    rewardDebtRaw: "0",
    earnedPerfFeeSharesRaw: "0",
    lifetimeDepositedRaw: "1000000",
    lifetimeWithdrawnRaw: "0",
    updatedBlockNumber: CURSOR_BLOCK,
    updatedLogIndex: 0,
  });
  insertSnapshot(db, {
    blockNumber: CURSOR_BLOCK,
    totalAssetsRaw,
    totalSupplyRaw: "1000000000000000000",
    capturedAt: 1,
  });

  return { db, config };
}

function setEstimatedFee(db: ReturnType<typeof openDatabase>, feeRaw: bigint): void {
  db.prepare("UPDATE share_price_snapshots SET total_assets_raw = ?").run(
    (1_000_000n + feeRaw * 2n).toString(),
  );
}

test("settleWallet crystallizes new performance fee at the applied boost", () => {
  const { db, config } = seedIndexedAccount();
  try {
    const first = settleWallet(db, config, ADDRESS, 40_000n, "wallet_boost_change", 1);

    assert.equal(first.minted, 80_000_000n);
    assert.deepEqual(readWalletVshipState(db, ADDRESS), {
      feeWatermarkRaw: 1_000_000n,
      crystallizedVshipRaw: 80_000_000n,
    });

    const second = settleWallet(db, config, ADDRESS, 40_000n, "wallet_boost_change", 2);
    assert.equal(second.minted, 0n);

    setEstimatedFee(db, 2_000_000n);
    const grown = settleWallet(db, config, ADDRESS, 40_000n, "wallet_boost_change", 3);
    assert.equal(grown.minted, 80_000_000n);
  } finally {
    closeDatabase(db);
  }
});

test("wallet boost changes crystallize at the old boost and later growth uses the new boost", () => {
  const { db, config } = seedIndexedAccount();
  try {
    const changed = setWalletAdditionalBoost(db, config, ADDRESS, 100_000n, CURSOR_BLOCK, "admin");
    assert.deepEqual(changed, { settledWalletCount: 1, changed: true });
    assert.deepEqual(readWalletVshipState(db, ADDRESS), {
      feeWatermarkRaw: 1_000_000n,
      crystallizedVshipRaw: 80_000_000n,
    });

    setEstimatedFee(db, 2_000_000n);
    const later = settleWallet(db, config, ADDRESS, 140_000n, "wallet_boost_change", 2);
    assert.equal(later.minted, 280_000_000n);
  } finally {
    closeDatabase(db);
  }
});

test("settleWallet keeps the watermark when the estimated fee dips", () => {
  const { db, config } = seedIndexedAccount();
  try {
    settleWallet(db, config, ADDRESS, 40_000n, "wallet_boost_change", 1);
    setEstimatedFee(db, 500_000n);

    const result = settleWallet(db, config, ADDRESS, 40_000n, "wallet_boost_change", 2);
    assert.equal(result.minted, 0n);
    assert.deepEqual(readWalletVshipState(db, ADDRESS), {
      feeWatermarkRaw: 1_000_000n,
      crystallizedVshipRaw: 80_000_000n,
    });
    assert.equal(listVshipSettlementEvents(db, ADDRESS).length, 1);
  } finally {
    closeDatabase(db);
  }
});

test("identical wallet boost changes are no-ops without audit events", () => {
  const { db, config } = seedIndexedAccount();
  try {
    const result = setWalletAdditionalBoost(db, config, ADDRESS, 0n, CURSOR_BLOCK, "admin");

    assert.deepEqual(result, { settledWalletCount: 0, changed: false });
    assert.equal(listBoostChangeEvents(db).length, 0);
    assert.equal(listVshipSettlementEvents(db, ADDRESS).length, 0);
  } finally {
    closeDatabase(db);
  }
});

test("assertMutationReady rejects unknown safe heads, unsynced cursors, and missing valuations", () => {
  const { db, config } = seedIndexedAccount();
  try {
    assert.throws(
      () => assertMutationReady(db, config, null),
      MutationNotReadyError,
    );

    assert.throws(
      () => assertMutationReady(db, config, CURSOR_BLOCK + 1),
      MutationNotReadyError,
    );
  } finally {
    closeDatabase(db);
  }

  const withoutValuation = openDatabase(":memory:");
  const withoutValuationConfig = createConfig();
  try {
    runMigrations(withoutValuation);
    getOrCreateVaultCursor(withoutValuation, withoutValuationConfig);
    assert.throws(
      () => assertMutationReady(withoutValuation, withoutValuationConfig, 0),
      MutationNotReadyError,
    );
  } finally {
    closeDatabase(withoutValuation);
  }
});

test("assertFeeMintFresh rejects fee mints at the configured stale threshold", () => {
  const { db, config } = seedIndexedAccount();
  try {
    db.prepare("UPDATE reward_config SET fee_mint_stale_blocks = ?").run(5);
    insertAccrueInterestEvent(db, {
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      blockNumber: CURSOR_BLOCK - 5,
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

    assert.throws(() => assertFeeMintFresh(db, config), StaleFeeMintError);
  } finally {
    closeDatabase(db);
  }
});
