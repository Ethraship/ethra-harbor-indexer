import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";

import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";

test("loadConfig returns the documented defaults", () => {
  const config = loadConfig({});

  assert.deepEqual(config, {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: getAddress("0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d"),
    databasePath: "./data/ethra-harbor-indexer.sqlite",
    startBlock: 0,
    confirmations: 2,
    chunkSize: 1000,
    blockTimeMs: 2000,
    fastPollMs: 2000,
    slowPollMs: 50000,
    crawlMode: "auto",
    logLevel: "info",
  });
});

test("loadConfig rejects an invalid crawl mode", () => {
  assert.throws(
    () => loadConfig({ CRAWL_MODE: "turbo" }),
    /CRAWL_MODE/,
  );
});

test("loadConfig rejects an invalid contract address", () => {
  assert.throws(
    () => loadConfig({ BASE_CONTRACT_ADDRESS: "not-an-address" }),
    /BASE_CONTRACT_ADDRESS/,
  );
});

test("loadConfig appends trimmed reconcile RPC URLs after the primary RPC URL", () => {
  const config = loadConfig({
    BASE_RPC_URL: "https://primary.example",
    RECONCILE_RPC_URLS: " https://fallback-1.example, ,https://fallback-2.example  ",
  });

  assert.deepEqual(config.reconcileRpcUrls, [
    "https://primary.example",
    "https://fallback-1.example",
    "https://fallback-2.example",
  ]);
});

test("loadConfig rejects numeric values below the supported minimums", () => {
  assert.throws(
    () => loadConfig({ CONFIRMATIONS: "-1" }),
    /CONFIRMATIONS/,
  );
  assert.throws(
    () => loadConfig({ CHUNK_SIZE: "0" }),
    /CHUNK_SIZE/,
  );
  assert.throws(
    () => loadConfig({ FAST_POLL_MS: "249" }),
    /FAST_POLL_MS/,
  );
  assert.throws(
    () => loadConfig({ SLOW_POLL_MS: "999" }),
    /SLOW_POLL_MS/,
  );
});

test("createLogger suppresses messages below the configured level and emits compact JSON", () => {
  const calls: Array<{ method: string; value: string }> = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (value?: unknown) => {
    calls.push({ method: "log", value: String(value) });
  };
  console.warn = (value?: unknown) => {
    calls.push({ method: "warn", value: String(value) });
  };
  console.error = (value?: unknown) => {
    calls.push({ method: "error", value: String(value) });
  };

  try {
    const logger = createLogger("warn");

    logger.info("skip me");
    logger.warn("heads up", { block: 123 });
    logger.error("boom");

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, "warn");
    assert.deepEqual(JSON.parse(calls[0]!.value), {
      level: "warn",
      message: "heads up",
      block: 123,
    });
    assert.equal(calls[1]?.method, "error");
    assert.deepEqual(JSON.parse(calls[1]!.value), {
      level: "error",
      message: "boom",
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
