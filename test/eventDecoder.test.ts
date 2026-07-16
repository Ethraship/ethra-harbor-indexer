import assert from "node:assert/strict";
import test from "node:test";

import { Interface, ZeroAddress, getAddress, type Log } from "ethers";

import { MORPHO_VAULT_ABI } from "../src/abi/morphoVault";
import type { AppConfig } from "../src/config";
import { decodeVaultLog } from "../src/indexer/eventDecoder";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: "0x9D2F57159ECA69265A9B9efAaA8Bc2B6B2df364d",
    databasePath: "./data/test.sqlite",
    startBlock: 123,
    confirmations: 2,
    snapshotIntervalMs: 60000,
    apiEnabled: false,
    apiPort: 8080,
    chunkSize: 1000,
    blockTimeMs: 2000,
    fastPollMs: 2000,
    slowPollMs: 50000,
    crawlMode: "auto",
    logLevel: "info",
    ...overrides,
  };
}

function createLog(
  iface: Interface,
  eventName: "Deposit" | "Withdraw" | "Transfer" | "AccrueInterest",
  args: readonly unknown[],
  overrides: Partial<Log> = {},
): Log {
  const fragment = iface.getEvent(eventName);
  const encoded = iface.encodeEventLog(fragment, args);

  return {
    address: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
    blockHash: "0xabc123",
    blockNumber: 48678603,
    data: encoded.data,
    index: 7,
    removed: false,
    topics: encoded.topics,
    transactionHash: "0xdef456",
    transactionIndex: 3,
    ...overrides,
  };
}

function withMockedDateNow<T>(value: number, fn: () => T): T {
  const originalDateNow = Date.now;
  Date.now = () => value;

  try {
    return fn();
  } finally {
    Date.now = originalDateNow;
  }
}

test("decodeVaultLog returns normalized deposit fields", () => {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const log = createLog(iface, "Deposit", [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    1234567890123456789n,
    987654321098765432n,
  ]);

  withMockedDateNow(1712345678000, () => {
    const decoded = decodeVaultLog(log, iface, createConfig());

    assert.deepEqual(decoded, {
      kind: "deposit",
      onBehalf: "0x2222222222222222222222222222222222222222",
      assets: "1234567890123456789",
      shares: "987654321098765432",
      base: {
        chainId: 8453,
        contractAddress: getAddress(log.address),
        blockNumber: 48678603,
        blockHash: "0xabc123",
        txHash: "0xdef456",
        txIndex: 3,
        logIndex: 7,
        rawLogJson: JSON.stringify(log),
        createdAt: 1712345678000,
      },
    });
  });
});

test("decodeVaultLog returns normalized withdraw fields", () => {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const log = createLog(iface, "Withdraw", [
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
    555n,
    444n,
  ]);

  withMockedDateNow(1712345678001, () => {
    assert.deepEqual(decodeVaultLog(log, iface, createConfig()), {
      kind: "withdraw",
      sender: "0x3333333333333333333333333333333333333333",
      receiver: "0x4444444444444444444444444444444444444444",
      onBehalf: "0x5555555555555555555555555555555555555555",
      assets: "555",
      shares: "444",
      base: {
        chainId: 8453,
        contractAddress: getAddress(log.address),
        blockNumber: 48678603,
        blockHash: "0xabc123",
        txHash: "0xdef456",
        txIndex: 3,
        logIndex: 7,
        rawLogJson: JSON.stringify(log),
        createdAt: 1712345678001,
      },
    });
  });
});

test("decodeVaultLog returns normalized transfer fields", () => {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const log = createLog(iface, "Transfer", [
    ZeroAddress,
    "0x6666666666666666666666666666666666666666",
    222n,
  ]);

  withMockedDateNow(1712345678002, () => {
    assert.deepEqual(decodeVaultLog(log, iface, createConfig()), {
      kind: "transfer",
      from: ZeroAddress,
      to: "0x6666666666666666666666666666666666666666",
      shares: "222",
      base: {
        chainId: 8453,
        contractAddress: getAddress(log.address),
        blockNumber: 48678603,
        blockHash: "0xabc123",
        txHash: "0xdef456",
        txIndex: 3,
        logIndex: 7,
        rawLogJson: JSON.stringify(log),
        createdAt: 1712345678002,
      },
    });
  });
});

test("decodeVaultLog returns normalized accrue fields", () => {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const log = createLog(iface, "AccrueInterest", [1000n, 1200n, 33n, 44n]);

  withMockedDateNow(1712345678003, () => {
    assert.deepEqual(decodeVaultLog(log, iface, createConfig()), {
      kind: "accrue",
      previousTotalAssets: "1000",
      newTotalAssets: "1200",
      performanceFeeShares: "33",
      managementFeeShares: "44",
      base: {
        chainId: 8453,
        contractAddress: getAddress(log.address),
        blockNumber: 48678603,
        blockHash: "0xabc123",
        txHash: "0xdef456",
        txIndex: 3,
        logIndex: 7,
        rawLogJson: JSON.stringify(log),
        createdAt: 1712345678003,
      },
    });
  });
});

test("decodeVaultLog returns null for a garbage-topic log", () => {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const decoded = decodeVaultLog(
    {
      address: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      blockHash: "0xgarbage",
      blockNumber: 48678604,
      data: "0x",
      index: 9,
      removed: false,
      topics: ["0x1234"],
      transactionHash: "0xgarbagetx",
      transactionIndex: 4,
    },
    iface,
    createConfig(),
  );

  assert.equal(decoded, null);
});
