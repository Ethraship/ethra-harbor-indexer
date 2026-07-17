import assert from "node:assert/strict";
import test from "node:test";

import { Interface, getAddress, type Log } from "ethers";

import { MORPHO_VAULT_ABI } from "../src/abi/morphoVault";
import { vaultCursorId, type AppConfig } from "../src/config";
import {
  closeDatabase,
  getOrCreateVaultCursor,
  openDatabase,
  readAccountPosition,
  readVaultState,
  runMigrations,
} from "../src/db";
import { VaultCrawler, nextDelayMs } from "../src/indexer/crawler";
import { createLogger as createStructuredLogger } from "../src/logger";
import type { BaseProviderClient } from "../src/provider/baseProvider";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SCALE = 10n ** 36n;

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: getAddress("0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d"),
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

function createVaultLog(
  iface: Interface,
  eventName: "Deposit" | "Withdraw" | "Transfer" | "AccrueInterest",
  args: readonly unknown[],
  overrides: Partial<Log> = {},
): Log {
  const fragment = iface.getEvent(eventName);
  const encoded = iface.encodeEventLog(fragment, args);

  return {
    address: getAddress("0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d"),
    blockHash: overrides.blockHash ?? `0xblock-${overrides.blockNumber ?? 0}`,
    blockNumber: overrides.blockNumber ?? 101,
    data: encoded.data,
    index: overrides.index ?? 0,
    removed: false,
    topics: encoded.topics,
    transactionHash:
      overrides.transactionHash ??
      `0xtx-${overrides.blockNumber ?? 0}-${overrides.transactionIndex ?? 0}-${overrides.index ?? 0}`,
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

test("tick processes two chunks with a four-topic OR filter and atomically applies sorted ledger state", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const alice = getAddress("0x1111111111111111111111111111111111111111");
  const depositor = getAddress("0x2222222222222222222222222222222222222222");
  const feeRecipient = getAddress("0x3333333333333333333333333333333333333333");
  const calls: Array<
    | { type: "head" }
    | {
        type: "logs";
        key: string;
        address?: string | string[];
        topics?: Array<string | Array<string | null> | null>;
      }
  > = [];
  const mintTransfer = createVaultLog(
    iface,
    "Transfer",
    [ZERO_ADDRESS, alice, 100n],
    {
      blockNumber: 101,
      transactionIndex: 1,
      index: 0,
      transactionHash: "0xtx-mint",
    },
  );
  const deposit = createVaultLog(
    iface,
    "Deposit",
    [depositor, alice, 1000n, 100n],
    {
      blockNumber: 101,
      transactionIndex: 1,
      index: 1,
      transactionHash: "0xtx-mint",
    },
  );
  const accrue = createVaultLog(
    iface,
    "AccrueInterest",
    [1000n, 1200n, 20n, 5n],
    {
      blockNumber: 102,
      transactionIndex: 0,
      index: 0,
      transactionHash: "0xtx-accrue",
    },
  );
  const feeMintTransfer = createVaultLog(
    iface,
    "Transfer",
    [ZERO_ADDRESS, feeRecipient, 20n],
    {
      blockNumber: 102,
      transactionIndex: 0,
      index: 1,
      transactionHash: "0xtx-accrue",
    },
  );
  const withdraw = createVaultLog(
    iface,
    "Withdraw",
    [alice, alice, alice, 400n, 40n],
    {
      blockNumber: 104,
      transactionIndex: 2,
      index: 0,
      transactionHash: "0xtx-withdraw",
    },
  );
  const burnTransfer = createVaultLog(
    iface,
    "Transfer",
    [alice, ZERO_ADDRESS, 40n],
    {
      blockNumber: 104,
      transactionIndex: 2,
      index: 1,
      transactionHash: "0xtx-withdraw",
    },
  );
  const provider = createProvider({
    heads: [106, 106],
    logsByRange: {
      "101-102": [feeMintTransfer, deposit, accrue, mintTransfer],
      "103-104": [burnTransfer, withdraw],
    },
    calls,
  });
  const expectedTopics = [[
    iface.getEvent("Deposit").topicHash,
    iface.getEvent("Withdraw").topicHash,
    iface.getEvent("Transfer").topicHash,
    iface.getEvent("AccrueInterest").topicHash,
  ]];

  try {
    runMigrations(db);

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    const firstTick = await crawler.tick();
    const secondTick = await crawler.tick();

    assert.deepEqual(firstTick, {
      processedLogs: 4,
      fromBlock: 101,
      toBlock: 102,
      safeHead: 104,
      hasMore: true,
    });
    assert.deepEqual(secondTick, {
      processedLogs: 2,
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
        topics: expectedTopics,
      },
      { type: "head" },
      {
        type: "logs",
        key: "103-104",
        address: config.contractAddress,
        topics: expectedTopics,
      },
    ]);

    const deposits = db.prepare(`
      SELECT block_number, tx_hash, tx_index, log_index, sender, on_behalf, assets, shares
      FROM deposit_events
      ORDER BY block_number, tx_index, log_index
    `).all();
    const withdraws = db.prepare(`
      SELECT block_number, tx_hash, tx_index, log_index, on_behalf, assets, shares
      FROM withdraw_events
      ORDER BY block_number, tx_index, log_index
    `).all();
    const transfers = db.prepare(`
      SELECT block_number, tx_hash, tx_index, log_index, from_address, to_address, shares
      FROM transfer_events
      ORDER BY block_number, tx_index, log_index
    `).all();
    const accrues = db.prepare(`
      SELECT
        block_number,
        tx_hash,
        tx_index,
        log_index,
        performance_fee_shares,
        management_fee_shares,
        total_supply_before_raw,
        global_index_after_raw
      FROM accrue_interest_events
      ORDER BY block_number, tx_index, log_index
    `).all();
    const cursor = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(vaultCursorId(config)) as { last_scanned_block: number };
    const alicePosition = readAccountPosition(db, alice);
    const feePosition = readAccountPosition(db, feeRecipient);
    const vaultState = readVaultState(db, config);

    assert.deepEqual(deposits, [
      {
        block_number: 101,
        tx_hash: "0xtx-mint",
        tx_index: 1,
        log_index: 1,
        sender: depositor,
        on_behalf: alice,
        assets: "1000",
        shares: "100",
      },
    ]);
    assert.deepEqual(withdraws, [
      {
        block_number: 104,
        tx_hash: "0xtx-withdraw",
        tx_index: 2,
        log_index: 0,
        on_behalf: alice,
        assets: "400",
        shares: "40",
      },
    ]);
    assert.deepEqual(transfers, [
      {
        block_number: 101,
        tx_hash: "0xtx-mint",
        tx_index: 1,
        log_index: 0,
        from_address: ZERO_ADDRESS,
        to_address: alice,
        shares: "100",
      },
      {
        block_number: 102,
        tx_hash: "0xtx-accrue",
        tx_index: 0,
        log_index: 1,
        from_address: ZERO_ADDRESS,
        to_address: feeRecipient,
        shares: "20",
      },
      {
        block_number: 104,
        tx_hash: "0xtx-withdraw",
        tx_index: 2,
        log_index: 1,
        from_address: alice,
        to_address: ZERO_ADDRESS,
        shares: "40",
      },
    ]);
    assert.deepEqual(accrues, [
      {
        block_number: 102,
        tx_hash: "0xtx-accrue",
        tx_index: 0,
        log_index: 0,
        performance_fee_shares: "20",
        management_fee_shares: "5",
        total_supply_before_raw: "100",
        global_index_after_raw: (SCALE / 5n).toString(),
      },
    ]);
    assert.equal(cursor.last_scanned_block, 104);
    assert.deepEqual(alicePosition, {
      address: alice,
      balanceRaw: "60",
      rewardDebtRaw: (SCALE / 5n).toString(),
      earnedPerfFeeSharesRaw: "20",
      lifetimeDepositedRaw: "1000",
      lifetimeWithdrawnRaw: "400",
      updatedBlockNumber: 104,
      updatedLogIndex: 1,
    });
    assert.deepEqual(feePosition, {
      address: feeRecipient,
      balanceRaw: "20",
      rewardDebtRaw: (SCALE / 5n).toString(),
      earnedPerfFeeSharesRaw: "0",
      lifetimeDepositedRaw: "0",
      lifetimeWithdrawnRaw: "0",
      updatedBlockNumber: 102,
      updatedLogIndex: 1,
    });
    assert.deepEqual(vaultState, {
      globalIndexRaw: (SCALE / 5n).toString(),
      totalSupplyRaw: "80",
      cumulativePerfFeeSharesRaw: "20",
      cumulativeMgmtFeeSharesRaw: "5",
      updatedBlockNumber: 104,
    });
  } finally {
    closeDatabase(db);
  }
});

test("tick publishes safe head for API health, including idle ticks", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig({ chunkSize: 10 });
  const iface = new Interface(MORPHO_VAULT_ABI);
  const published: Array<{
    processedLogs: number;
    fromBlock: number | null;
    toBlock: number | null;
    safeHead: number | null;
    hasMore: boolean;
  }> = [];
  const provider = createProvider({
    heads: [104, 104],
    logsByRange: {
      "101-102": [],
    },
  });

  try {
    runMigrations(db);

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
      onTickResult: (result) => {
        published.push(result);
      },
    });

    const firstTick = await crawler.tick();
    const secondTick = await crawler.tick();

    assert.deepEqual(firstTick, {
      processedLogs: 0,
      fromBlock: 101,
      toBlock: 102,
      safeHead: 102,
      hasMore: false,
    });
    assert.deepEqual(secondTick, {
      processedLogs: 0,
      fromBlock: null,
      toBlock: null,
      safeHead: 102,
      hasMore: false,
    });
    assert.deepEqual(published, [firstTick, secondTick]);
  } finally {
    closeDatabase(db);
  }
});

test("tick retries a failed chunk after transaction rollback and applies it exactly once", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const alice = getAddress("0x1111111111111111111111111111111111111111");
  const depositor = getAddress("0x2222222222222222222222222222222222222222");
  const feeRecipient = getAddress("0x3333333333333333333333333333333333333333");
  const provider = createProvider({
    heads: [104, 104],
    logsByRange: {
      "101-102": [
        createVaultLog(
          iface,
          "Transfer",
          [ZERO_ADDRESS, feeRecipient, 20n],
          {
            blockNumber: 102,
            transactionIndex: 0,
            index: 1,
            transactionHash: "0xtx-accrue",
          },
        ),
        createVaultLog(
          iface,
          "Deposit",
          [depositor, alice, 1000n, 100n],
          {
            blockNumber: 101,
            transactionIndex: 1,
            index: 1,
            transactionHash: "0xtx-mint",
          },
        ),
        createVaultLog(
          iface,
          "AccrueInterest",
          [1000n, 1200n, 20n, 5n],
          {
            blockNumber: 102,
            transactionIndex: 0,
            index: 0,
            transactionHash: "0xtx-accrue",
          },
        ),
        createVaultLog(
          iface,
          "Transfer",
          [ZERO_ADDRESS, alice, 100n],
          {
            blockNumber: 101,
            transactionIndex: 1,
            index: 0,
            transactionHash: "0xtx-mint",
          },
        ),
      ],
    },
  });

  try {
    runMigrations(db);
    db.exec(`
      CREATE TRIGGER fail_account_position_insert
      BEFORE INSERT ON account_positions
      BEGIN
        SELECT RAISE(ABORT, 'forced account position failure');
      END;
    `);

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    await assert.rejects(
      () => crawler.tick(),
      /forced account position failure/,
    );

    const failedCursor = getOrCreateVaultCursor(db, config);
    const failedDepositCount = db.prepare(
      "SELECT COUNT(*) AS count FROM deposit_events",
    ).get() as { count: number };
    const failedTransferCount = db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_events",
    ).get() as { count: number };
    const failedAccrueCount = db.prepare(
      "SELECT COUNT(*) AS count FROM accrue_interest_events",
    ).get() as { count: number };

    assert.equal(failedCursor, config.startBlock);
    assert.equal(failedDepositCount.count, 0);
    assert.equal(failedTransferCount.count, 0);
    assert.equal(failedAccrueCount.count, 0);
    assert.deepEqual(readVaultState(db, config), {
      globalIndexRaw: "0",
      totalSupplyRaw: "0",
      cumulativePerfFeeSharesRaw: "0",
      cumulativeMgmtFeeSharesRaw: "0",
      updatedBlockNumber: 0,
    });

    db.exec("DROP TRIGGER fail_account_position_insert");

    const secondTick = await crawler.tick();
    const cursor = db.prepare(
      "SELECT last_scanned_block FROM indexer_state WHERE id = ?",
    ).get(vaultCursorId(config)) as { last_scanned_block: number };
    const depositCount = db.prepare(
      "SELECT COUNT(*) AS count FROM deposit_events",
    ).get() as { count: number };
    const transferCount = db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_events",
    ).get() as { count: number };
    const accrueCount = db.prepare(
      "SELECT COUNT(*) AS count FROM accrue_interest_events",
    ).get() as { count: number };
    const errorCount = db.prepare(
      "SELECT COUNT(*) AS count FROM crawl_errors",
    ).get() as { count: number };
    const alicePosition = readAccountPosition(db, alice);
    const feePosition = readAccountPosition(db, feeRecipient);

    assert.deepEqual(secondTick, {
      processedLogs: 4,
      fromBlock: 101,
      toBlock: 102,
      safeHead: 102,
      hasMore: false,
    });
    assert.equal(cursor.last_scanned_block, 102);
    assert.equal(depositCount.count, 1);
    assert.equal(transferCount.count, 2);
    assert.equal(accrueCount.count, 1);
    assert.equal(errorCount.count, 1);
    assert.deepEqual(alicePosition, {
      address: alice,
      balanceRaw: "100",
      rewardDebtRaw: "0",
      earnedPerfFeeSharesRaw: "0",
      lifetimeDepositedRaw: "1000",
      lifetimeWithdrawnRaw: "0",
      updatedBlockNumber: 101,
      updatedLogIndex: 1,
    });
    assert.deepEqual(feePosition, {
      address: feeRecipient,
      balanceRaw: "20",
      rewardDebtRaw: (SCALE / 5n).toString(),
      earnedPerfFeeSharesRaw: "0",
      lifetimeDepositedRaw: "0",
      lifetimeWithdrawnRaw: "0",
      updatedBlockNumber: 102,
      updatedLogIndex: 1,
    });
  } finally {
    closeDatabase(db);
  }
});

test("tick records chunk failures without advancing the vault cursor", async () => {
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

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    await assert.rejects(() => crawler.tick(), /rpc getLogs failed/);

    const cursor = getOrCreateVaultCursor(db, config);
    const errors = db.prepare(
      "SELECT chain_id, from_block, to_block, message FROM crawl_errors",
    ).all();

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

test("tick emits structured error details when a crawler chunk fails", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const providerError = Object.assign(new Error("rpc getLogs failed"), {
    code: "SERVER_ERROR",
  });
  const provider = createProvider({
    heads: [105],
    failingRanges: {
      "101-102": providerError,
    },
  });
  const calls: string[] = [];
  const originalError = console.error;

  console.error = (value?: unknown) => {
    calls.push(String(value));
  };

  try {
    runMigrations(db);

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createStructuredLogger("error"),
    });

    await assert.rejects(() => crawler.tick(), /rpc getLogs failed/);

    assert.equal(calls.length, 1);
    const logged = JSON.parse(calls[0]!) as {
      level?: string;
      message?: string;
      fromBlock?: number;
      toBlock?: number;
      error?: {
        name?: string;
        message?: string;
        stack?: string;
        code?: string;
      };
    };

    assert.equal(logged.level, "error");
    assert.equal(logged.message, "crawler chunk failed");
    assert.equal(logged.fromBlock, 101);
    assert.equal(logged.toBlock, 102);
    assert.equal(logged.error?.name, "Error");
    assert.equal(logged.error?.message, "rpc getLogs failed");
    assert.equal(logged.error?.code, "SERVER_ERROR");
    assert.match(logged.error?.stack ?? "", /rpc getLogs failed/);
  } finally {
    console.error = originalError;
    closeDatabase(db);
  }
});

test("tick rejects undecodable vault logs, records the crawl error, and leaves the cursor unchanged", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const malformedLog = createVaultLog(
    iface,
    "Deposit",
    [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      1000n,
      100n,
    ],
    {
      blockNumber: 101,
      transactionHash: "0xtx-bad-vault-log",
    },
  );
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

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    await assert.rejects(
      () => crawler.tick(),
      /encountered undecodable vault log/,
    );

    const cursor = getOrCreateVaultCursor(db, config);
    const depositCount = db.prepare(
      "SELECT COUNT(*) AS count FROM deposit_events",
    ).get() as { count: number };
    const errors = db.prepare(
      "SELECT from_block, to_block, message FROM crawl_errors",
    ).all();

    assert.equal(cursor, 100);
    assert.equal(depositCount.count, 0);
    assert.deepEqual(errors, [
      {
        from_block: 101,
        to_block: 102,
        message:
          "encountered undecodable vault log for 0xtx-bad-vault-log:0 in chunk 101-102",
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

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });

    crawler.start();
    await queued.shift()?.fn();
    await queued.shift()?.fn();
    await crawler.stop();

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

    const crawler = new VaultCrawler({
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

test("stop prevents a queued timeout callback from starting a tick after shutdown", async () => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const iface = new Interface(MORPHO_VAULT_ABI);
  const providerCalls: Array<{ type: "head" }> = [];
  const provider = createProvider({
    heads: [105],
    calls: providerCalls,
  });
  const queued: Array<() => void | Promise<void>> = [];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let tickStarts = 0;

  global.setTimeout = ((fn: () => void | Promise<void>) => {
    queued.push(fn);
    return { id: queued.length } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  global.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    runMigrations(db);

    const crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface,
      logger: createLogger(),
    });
    const originalTick = crawler.tick.bind(crawler);

    crawler.tick = async () => {
      tickStarts += 1;
      return originalTick();
    };

    crawler.start();

    assert.equal(queued.length, 1);

    await crawler.stop();
    await queued.shift()?.();

    assert.equal(tickStarts, 0);
    assert.deepEqual(providerCalls, []);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    closeDatabase(db);
  }
});
