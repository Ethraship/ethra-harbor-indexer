import assert from "node:assert/strict";
import test from "node:test";

import { ethers } from "ethers";

import type { AppConfig } from "../src/config";
import { openDatabase, readLatestSnapshot, runMigrations } from "../src/db";
import { createBaseProviderClient } from "../src/provider/baseProvider";
import { SharePriceSnapshotter, valueOfShares } from "../src/snapshot/sharePrice";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: "0x9D2F57159ECA69265A9B9efAaA8Bc2B6B2df364d",
    databasePath: ":memory:",
    startBlock: 100,
    confirmations: 2,
    snapshotIntervalMs: 60000,
    apiEnabled: false,
    apiPort: 8080,
    chunkSize: 2,
    blockTimeMs: 2000,
    fastPollMs: 2000,
    slowPollMs: 50000,
    crawlMode: "auto",
    logLevel: "info",
    ...overrides,
  };
}

function createLogger() {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}

test("valueOfShares floors the share value and returns zero when supply is zero", () => {
  assert.equal(
    valueOfShares(5n, {
      blockNumber: 123,
      totalAssetsRaw: "3",
      totalSupplyRaw: "2",
      capturedAt: 1712345678000,
    }),
    7n,
  );
  assert.equal(
    valueOfShares(5n, {
      blockNumber: 123,
      totalAssetsRaw: "3",
      totalSupplyRaw: "0",
      capturedAt: 1712345678000,
    }),
    0n,
  );
});

test("snapshotOnce inserts a snapshot from the latest vault totals", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const provider = {
    async readVaultTotals() {
      return {
        blockNumber: 48578260,
        totalAssetsRaw: "1000",
        totalSupplyRaw: "500",
      };
    },
  };
  const snapshotter = new SharePriceSnapshotter({
    config,
    db,
    provider,
    logger: createLogger(),
  });
  const before = Date.now();

  try {
    runMigrations(db);

    await snapshotter.snapshotOnce();

    const snapshot = readLatestSnapshot(db);

    assert.ok(snapshot);
    assert.deepEqual(snapshot, {
      blockNumber: 48578260,
      totalAssetsRaw: "1000",
      totalSupplyRaw: "500",
      capturedAt: snapshot.capturedAt,
    });
    assert.ok(snapshot.capturedAt >= before);
    assert.ok(snapshot.capturedAt <= Date.now());
  } finally {
    await snapshotter.stop();
    db.close();
  }
});

test("readVaultTotals falls back across providers and reads both totals at the same block", async () => {
  const originalProvider = ethers.JsonRpcProvider;
  const originalContract = ethers.Contract;
  const calls: string[] = [];

  class FakeProvider {
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      calls.push(`ctor:${url}`);
    }

    async getBlockNumber(): Promise<number> {
      calls.push(`head:${this.url}`);

      if (this.url === "https://primary.example") {
        throw new Error("primary failed");
      }

      return 2468;
    }

    async getLogs(): Promise<ethers.Log[]> {
      throw new Error("not needed");
    }
  }

  class FakeContract {
    readonly provider: { url: string };

    constructor(_address: string, _abi: unknown, provider: { url: string }) {
      this.provider = provider;
      calls.push(`contract:${provider.url}`);
    }

    async totalAssets({ blockTag }: { blockTag: number }): Promise<bigint> {
      calls.push(`assets:${this.provider.url}:${blockTag}`);
      return 1000n;
    }

    async totalSupply({ blockTag }: { blockTag: number }): Promise<bigint> {
      calls.push(`supply:${this.provider.url}:${blockTag}`);
      return 500n;
    }
  }

  Object.defineProperty(ethers, "JsonRpcProvider", {
    configurable: true,
    value: FakeProvider,
  });
  Object.defineProperty(ethers, "Contract", {
    configurable: true,
    value: FakeContract,
  });

  try {
    const client = createBaseProviderClient(
      createConfig({
        reconcileRpcUrls: [
          "https://primary.example",
          "https://secondary.example",
        ],
      }),
    );

    assert.ok(client.readVaultTotals);
    assert.deepEqual(
      await client.readVaultTotals(
        createConfig({
          reconcileRpcUrls: [
            "https://primary.example",
            "https://secondary.example",
          ],
        }),
      ),
      {
        blockNumber: 2468,
        totalAssetsRaw: "1000",
        totalSupplyRaw: "500",
      },
    );
    assert.deepEqual(calls, [
      "ctor:https://primary.example",
      "ctor:https://secondary.example",
      "head:https://primary.example",
      "head:https://secondary.example",
      "contract:https://secondary.example",
      "assets:https://secondary.example:2468",
      "supply:https://secondary.example:2468",
    ]);
  } finally {
    Object.defineProperty(ethers, "JsonRpcProvider", {
      configurable: true,
      value: originalProvider,
    });
    Object.defineProperty(ethers, "Contract", {
      configurable: true,
      value: originalContract,
    });
  }
});

test("stop waits for an active snapshot to finish before returning", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig({ snapshotIntervalMs: 5 });
  let resolveRead: ((value: {
    blockNumber: number;
    totalAssetsRaw: string;
    totalSupplyRaw: string;
  }) => void) | null = null;
  let readCalls = 0;
  const provider = {
    async readVaultTotals() {
      readCalls += 1;

      return await new Promise<{
        blockNumber: number;
        totalAssetsRaw: string;
        totalSupplyRaw: string;
      }>((resolve) => {
        resolveRead = resolve;
      });
    },
  };
  const snapshotter = new SharePriceSnapshotter({
    config,
    db,
    provider,
    logger: createLogger(),
  });

  try {
    runMigrations(db);

    snapshotter.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(readCalls, 1);

    const stopPromise = snapshotter.stop();
    resolveRead?.({
      blockNumber: 48578261,
      totalAssetsRaw: "1100",
      totalSupplyRaw: "550",
    });
    await stopPromise;

    assert.equal(readCalls, 1);
    const snapshot = readLatestSnapshot(db);

    assert.ok(snapshot);
    assert.deepEqual(snapshot, {
      blockNumber: 48578261,
      totalAssetsRaw: "1100",
      totalSupplyRaw: "550",
      capturedAt: snapshot.capturedAt,
    });
  } finally {
    await snapshotter.stop();
    db.close();
  }
});
