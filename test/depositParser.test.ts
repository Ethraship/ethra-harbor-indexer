import assert from "node:assert/strict";
import test from "node:test";

import { Interface, getAddress, type Log } from "ethers";

import type { AppConfig } from "../src/config";
import { MORPHO_VAULT_ABI } from "../src/abi/morphoVault";
import { parseDepositLog } from "../src/indexer/depositParser";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: "0x9D2F57159ECA69265A9B9efAaA8Bc2B6B2df364d",
    databasePath: "./data/test.sqlite",
    startBlock: 123,
    confirmations: 2,
    chunkSize: 1000,
    blockTimeMs: 2000,
    fastPollMs: 2000,
    slowPollMs: 50000,
    crawlMode: "auto",
    logLevel: "info",
    ...overrides,
  };
}

function createDepositLog(): Log {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const fragment = iface.getEvent("Deposit");
  const sender = "0x1111111111111111111111111111111111111111";
  const onBehalf = "0x2222222222222222222222222222222222222222";
  const encoded = iface.encodeEventLog(fragment, [
    sender,
    onBehalf,
    1234567890123456789n,
    987654321098765432n,
  ]);

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
  };
}

test("parseDepositLog returns normalized Morpho Vault deposit fields", () => {
  const iface = new Interface(MORPHO_VAULT_ABI);
  const log = createDepositLog();
  const originalDateNow = Date.now;

  Date.now = () => 1712345678000;

  try {
    const parsed = parseDepositLog(log, iface, createConfig());

    assert.deepEqual(parsed, {
      chainId: 8453,
      contractAddress: getAddress(log.address),
      blockNumber: 48678603,
      blockHash: "0xabc123",
      txHash: "0xdef456",
      txIndex: 3,
      logIndex: 7,
      sender: "0x1111111111111111111111111111111111111111",
      onBehalf: "0x2222222222222222222222222222222222222222",
      assets: "1234567890123456789",
      shares: "987654321098765432",
      rawLogJson: JSON.stringify(log),
      createdAt: 1712345678000,
    });
  } finally {
    Date.now = originalDateNow;
  }
});

test("parseDepositLog returns null when the log is not a Deposit event", () => {
  const depositInterface = new Interface(MORPHO_VAULT_ABI);
  const otherInterface = new Interface([
    "event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  ]);
  const fragment = otherInterface.getEvent("Withdraw");
  const encoded = otherInterface.encodeEventLog(fragment, [
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
    10n,
    9n,
  ]);

  const parsed = parseDepositLog(
    {
      address: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      blockHash: "0xwithdraw",
      blockNumber: 48678604,
      data: encoded.data,
      index: 8,
      removed: false,
      topics: encoded.topics,
      transactionHash: "0xwithdrawtx",
      transactionIndex: 4,
    },
    depositInterface,
    createConfig(),
  );

  assert.equal(parsed, null);
});
