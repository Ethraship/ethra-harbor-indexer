import assert from "node:assert/strict";
import test from "node:test";

import { Interface, type Log } from "ethers";

import type { AppConfig } from "../src/config";
import {
  closeDatabase,
  cursorId,
  getOrCreateCursor,
  openDatabase,
  runMigrations,
} from "../src/db";
import { MORPHO_VAULT_ABI } from "../src/abi/morphoVault";
import type { BaseProviderClient } from "../src/provider/baseProvider";
import { DepositCrawler, nextDelayMs } from "../src/indexer/crawler";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: "0x9D2F57159ECA69265A9B9efAaA8Bc2B6B2df364d",
    databasePath: ":memory:",
    startBlock: 100,
    confirmations: 2,
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

function createDepositLog(
  iface: Interface,
  overrides: Partial<Log> & {
    sender?: string;
    onBehalf?: string;
    assets?: bigint;
    shares?: bigint;
  } = {},
): Log {
  const fragment = iface.getEvent("Deposit");
  const sender = overrides.sender ?? "0x1111111111111111111111111111111111111111";
  const onBehalf =
    overrides.onBehalf ?? "0x2222222222222222222222222222222222222222";
  const assets = overrides.assets ?? 1000n;
  const shares = overrides.shares ?? 900n;
  const encoded = iface.encodeEventLog(fragment, [sender, onBehalf, assets, shares]);

  return {
    address: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
    blockHash: overrides.blockHash ?? `0xblock-${overrides.blockNumber ?? 0}`,
    blockNumber: overrides.blockNumber ?? 101,
    data: encoded.data,
    index: overrides.index ?? 0,
    removed: false,
    topics: encoded.topics,
    transactionHash:
      overrides.transactionHash ?? `0xtx-${overrides.blockNumber ?? 0}-${overrides.index ?? 0}`,
    transactionIndex: overrides.transactionIndex ?? 0,
  };
}

function createProvider(options: {
  heads: number[];
  logsByRange?: Record<string, Log[]>;
  failingRanges?: Record<string, Error>;
  calls?: Array<
    | { type: "head" }
    | {
        type: "logs";
        key: string;
        address?: string | string[];
        topics?: Array<string | Array<string | null> | null>;
      }
  >;
}): BaseProviderClient {
  const heads = [...options.heads];

  return {
    async getBlockNumber(): Promise<number> {
      options.calls?.push({ type: "head" });
      return heads.shift() ?? options.heads[options.heads.length - 1] ?? 0;
    },
    async getLogs(filter): Promise<Log[]> {
      const key = `${filter.fromBlock}-${filter.toBlock}`;
      options.calls?.push({
        type: "logs",
        key,
        address: filter.address,
        topics: filter.topics,
      });

      const error = options.failingRanges?.[key];
      if (error) {
        throw error;
      }

      return options.logsByRange?.[key] ?? [];
    },
  };
}

test("tick processes two chunks with sorted deposits and exact deposit filters", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const calls: Array<
    | { type: "head" }
    | {
        type: "logs";
        key: string;
        address?: string | string[];
        topics?: Array<string | Array<string | null> | null>;
      }
  > = [];
  const provider = createProvider({
    heads: [106, 106],
    logsByRange: {
      "101-102": [
        createDepositLog(iface, {
          blockNumber: 102,
          transactionIndex: 2,
          index: 1,
          transactionHash: "0xtx-b",
          assets: 2000n,
        }),
        createDepositLog(iface, {
          blockNumber: 101,
          transactionIndex: 1,
          index: 0,
          transactionHash: "0xtx-a",
          assets: 1000n,
        }),
      ],
      "103-104": [
        createDepositLog(iface, {
          blockNumber: 104,
          transactionIndex: 0,
          index: 3,
          transactionHash: "0xtx-c",
          assets: 3000n,
        }),
      ],
    },
    calls,
  });

  try {
    runMigrations(db);

    const crawler = new DepositCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    const firstTick = await crawler.tick();
    const secondTick = await crawler.tick();

    assert.deepEqual(firstTick, {
      processedLogs: 2,
      fromBlock: 101,
      toBlock: 102,
      safeHead: 104,
      hasMore: true,
    });
    assert.deepEqual(secondTick, {
      processedLogs: 1,
      fromBlock: 103,
      toBlock: 104,
      safeHead: 104,
      hasMore: false,
    });

    assert.deepEqual(calls, [
      { type: "head" },
      {
        type: "logs",
        key: "101-102",
        address: config.contractAddress,
        topics: [iface.getEvent("Deposit").topicHash],
      },
      { type: "head" },
      {
        type: "logs",
        key: "103-104",
        address: config.contractAddress,
        topics: [iface.getEvent("Deposit").topicHash],
      },
    ]);

    const deposits = db.prepare(
      `
        SELECT block_number, tx_hash, tx_index, log_index, assets
        FROM deposit_events
        ORDER BY block_number, tx_index, log_index
      `,
    ).all() as Array<{
      block_number: number;
      tx_hash: string;
      tx_index: number;
      log_index: number;
      assets: string;
    }>;
    const cursor = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(cursorId(config)) as { last_scanned_block: number };

    assert.deepEqual(deposits, [
      {
        block_number: 101,
        tx_hash: "0xtx-a",
        tx_index: 1,
        log_index: 0,
        assets: "1000",
      },
      {
        block_number: 102,
        tx_hash: "0xtx-b",
        tx_index: 2,
        log_index: 1,
        assets: "2000",
      },
      {
        block_number: 104,
        tx_hash: "0xtx-c",
        tx_index: 0,
        log_index: 3,
        assets: "3000",
      },
    ]);
    assert.equal(cursor.last_scanned_block, 104);
  } finally {
    closeDatabase(db);
  }
});

test("tick is idempotent when the same chunk is retried and logs repeat", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const repeatedLog = createDepositLog(iface, {
    blockNumber: 101,
    transactionIndex: 0,
    index: 0,
    transactionHash: "0xtx-repeat",
    assets: 777n,
  });
  const provider = createProvider({
    heads: [103, 103],
    logsByRange: {
      "101-101": [repeatedLog],
    },
  });

  try {
    runMigrations(db);

    const crawler = new DepositCrawler({
      config: createConfig({ chunkSize: 1 }),
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    const firstTick = await crawler.tick();

    db.prepare("UPDATE indexer_state SET last_scanned_block = ? WHERE id = ?").run(
      100,
      cursorId(config),
    );

    const secondTick = await crawler.tick();
    const depositCount = db.prepare(
      "SELECT COUNT(*) AS count FROM deposit_events",
    ).get() as { count: number };
    const cursor = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(cursorId(config)) as { last_scanned_block: number };

    assert.equal(firstTick.processedLogs, 1);
    assert.equal(secondTick.processedLogs, 1);
    assert.equal(depositCount.count, 1);
    assert.equal(cursor.last_scanned_block, 101);
  } finally {
    closeDatabase(db);
  }
});

test("tick records chunk failures without advancing the cursor", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const provider = createProvider({
    heads: [105],
    failingRanges: {
      "101-102": new Error("rpc getLogs failed"),
    },
  });

  try {
    runMigrations(db);

    const crawler = new DepositCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    await assert.rejects(() => crawler.tick(), /rpc getLogs failed/);

    const cursor = getOrCreateCursor(db, config);
    const errors = db.prepare(
      "SELECT chain_id, from_block, to_block, message FROM crawl_errors",
    ).all() as Array<{
      chain_id: number;
      from_block: number;
      to_block: number;
      message: string;
    }>;

    assert.equal(cursor, 100);
    assert.deepEqual(errors, [
      {
        chain_id: 8453,
        from_block: 101,
        to_block: 102,
        message: "rpc getLogs failed",
      },
    ]);
  } finally {
    closeDatabase(db);
  }
});

test("tick rejects undecodable deposit logs, records the crawl error, and leaves the cursor unchanged", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const malformedLog = createDepositLog(iface, {
    blockNumber: 101,
    transactionHash: "0xtx-bad-deposit",
  });
  const provider = createProvider({
    heads: [105],
    logsByRange: {
      "101-102": [
        {
          ...malformedLog,
          data: "0x1234",
        },
      ],
    },
  });

  try {
    runMigrations(db);

    const crawler = new DepositCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    await assert.rejects(
      () => crawler.tick(),
      /undecodable Deposit log/,
    );

    const cursor = getOrCreateCursor(db, config);
    const deposits = db.prepare("SELECT COUNT(*) AS count FROM deposit_events").get() as {
      count: number;
    };
    const errors = db.prepare(
      "SELECT from_block, to_block, message FROM crawl_errors",
    ).all() as Array<{
      from_block: number;
      to_block: number;
      message: string;
    }>;

    assert.equal(cursor, 100);
    assert.equal(deposits.count, 0);
    assert.deepEqual(errors, [
      {
        from_block: 101,
        to_block: 102,
        message:
          "encountered undecodable Deposit log for 0xtx-bad-deposit:0 in chunk 101-102",
      },
    ]);
  } finally {
    closeDatabase(db);
  }
});

test("nextDelayMs respects fast, slow, and auto scheduling modes", () => {
  assert.equal(nextDelayMs(createConfig({ crawlMode: "fast" }), false), 2000);
  assert.equal(nextDelayMs(createConfig({ crawlMode: "slow" }), true), 50000);
  assert.equal(nextDelayMs(createConfig({ crawlMode: "auto" }), true), 2000);
  assert.equal(nextDelayMs(createConfig({ crawlMode: "auto" }), false), 50000);
});

test("start schedules fast then slow in auto mode and stop clears the pending timer", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig({ chunkSize: 2 });
  const iface = new Interface(MORPHO_VAULT_ABI);
  const provider = createProvider({
    heads: [106, 106],
    logsByRange: {
      "101-102": [],
      "103-104": [],
    },
  });
  const scheduledDelays: number[] = [];
  const clearedHandles: Array<{ id: number }> = [];
  const queued: Array<{ id: number; fn: () => void | Promise<void> }> = [];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextHandleId = 1;

  global.setTimeout = ((fn: () => void | Promise<void>, delay?: number) => {
    const handle = { id: nextHandleId++ };
    scheduledDelays.push(delay ?? 0);
    queued.push({ id: handle.id, fn });
    return handle as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  global.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle && typeof handle === "object" && "id" in handle) {
      clearedHandles.push(handle as { id: number });
    }
  }) as typeof clearTimeout;

  try {
    runMigrations(db);

    const crawler = new DepositCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    crawler.start();
    await queued.shift()?.fn();
    await queued.shift()?.fn();
    crawler.stop();

    assert.deepEqual(scheduledDelays, [0, 2000, 50000]);
    assert.deepEqual(clearedHandles, [{ id: 3 }]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    closeDatabase(db);
  }
});

test("stop waits for the active run loop to finish before resolving", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig({ chunkSize: 2 });
  const iface = new Interface(MORPHO_VAULT_ABI);
  const provider = createProvider({
    heads: [102],
    logsByRange: {
      "101-100": [],
    },
  });
  const queued: Array<() => void | Promise<void>> = [];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let resolveTick: (() => void) | undefined;
  let tickFinished = false;

  global.setTimeout = ((fn: () => void | Promise<void>) => {
    queued.push(fn);
    return { id: queued.length } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  global.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    runMigrations(db);

    const crawler = new DepositCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });
    const originalTick = crawler.tick.bind(crawler);

    crawler.tick = async () => {
      await new Promise<void>((resolve) => {
        resolveTick = resolve;
      });
      const result = await originalTick();
      tickFinished = true;
      return result;
    };

    crawler.start();

    const runLoop = queued.shift();
    assert.ok(runLoop);
    const activeRun = Promise.resolve(runLoop());
    const stopPromise = crawler.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    assert.equal(stopResolved, false);

    resolveTick?.();
    await activeRun;
    await stopPromise;

    assert.equal(tickFinished, true);
    assert.equal(stopResolved, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    closeDatabase(db);
  }
});
