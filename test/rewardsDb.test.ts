import assert from "node:assert/strict";
import test from "node:test";
import { closeDatabase, openDatabase, runMigrations } from "../src/db";
import {
  readRewardConfig,
  readWalletAdditionalBoostBps,
  upsertWalletAdditionalBoostBps,
  upsertWalletVshipState,
  readWalletVshipState,
  insertBoostChangeEvent,
  listBoostChangeEvents,
  insertVshipSettlementEvent,
  listVshipSettlementEvents,
  listWalletBoosts,
} from "../src/db/rewards";

test("migration seeds reward_config at 4x and $0.05", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const config = readRewardConfig(db);
    assert.equal(config.baseBoostBps, 40000n);
    assert.equal(config.vshipPriceUsdRaw, 50000n);
    assert.equal(config.vshipPriceUsdDecimals, 6);
    assert.equal(config.vshipTokenDecimals, 6);
    assert.equal(config.feeMintStaleBlocks, 20000);
  } finally {
    closeDatabase(db);
  }
});

test("wallet boost and vship state round-trip", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const address = "0x1111111111111111111111111111111111111111";
    assert.equal(readWalletAdditionalBoostBps(db, address), 0n);
    upsertWalletAdditionalBoostBps(db, address, 100000n, 1);
    assert.equal(readWalletAdditionalBoostBps(db, address), 100000n);
    upsertWalletVshipState(db, address, 75n, 6000n, 2);
    assert.deepEqual(readWalletVshipState(db, address), {
      feeWatermarkRaw: 75n,
      crystallizedVshipRaw: 6000n,
    });
  } finally {
    closeDatabase(db);
  }
});

test("boost change and settlement events list newest first", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    insertBoostChangeEvent(db, {
      changedAt: 1,
      changeType: "base",
      address: null,
      oldBps: 40000n,
      newBps: 50000n,
      actor: "admin",
      settledWalletCount: 0,
    });
    insertBoostChangeEvent(db, {
      changedAt: 2,
      changeType: "wallet_additional",
      address: "0x1111111111111111111111111111111111111111",
      oldBps: 0n,
      newBps: 100000n,
      actor: "admin",
      settledWalletCount: 1,
    });
    const changes = listBoostChangeEvents(db);
    assert.equal(changes[0]!.changedAt, 2);
    insertVshipSettlementEvent(db, {
      settledAt: 10,
      address: "0x1111111111111111111111111111111111111111",
      feeBeforeRaw: 0n,
      feeAfterRaw: 100n,
      feeDeltaRaw: 100n,
      boostBpsApplied: 40000n,
      vshipMintedRaw: 8000n,
      crystallizedVshipAfterRaw: 8000n,
      reason: "wallet_boost_change",
    });
    const settlements = listVshipSettlementEvents(
      db,
      "0x1111111111111111111111111111111111111111",
    );
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]!.vshipMintedRaw, 8000n);
  } finally {
    closeDatabase(db);
  }
});

test("listWalletBoosts returns only positive boosts sorted by address", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const low = "0x1111111111111111111111111111111111111111";
    const high = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const zeroed = "0x2222222222222222222222222222222222222222";
    upsertWalletAdditionalBoostBps(db, high, 50000n, 1);
    upsertWalletAdditionalBoostBps(db, low, 100000n, 1);
    upsertWalletAdditionalBoostBps(db, zeroed, 0n, 1);

    assert.deepEqual(listWalletBoosts(db), [
      { address: "0x1111111111111111111111111111111111111111", additionalBoostBps: 100000n },
      { address: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa", additionalBoostBps: 50000n },
    ]);
  } finally {
    closeDatabase(db);
  }
});
