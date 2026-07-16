import assert from "node:assert/strict";
import test from "node:test";

import { ethers } from "ethers";

import type { AppConfig } from "../src/config";
import {
  createBaseProviderClient,
  type BaseProviderClient,
} from "../src/provider/baseProvider";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    reconcileRpcUrls: ["https://base-rpc.publicnode.com"],
    contractAddress: "0x9D2F57159ECA69265A9B9efAaA8Bc2B6B2df364d",
    databasePath: "./data/test.sqlite",
    startBlock: 0,
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

test("createBaseProviderClient gets the head from the first configured provider", async () => {
  const original = ethers.JsonRpcProvider;
  const created: Array<{ url: string; network: unknown; options: unknown }> = [];

  class FakeProvider {
    constructor(url: string, network: unknown, options: unknown) {
      created.push({ url, network, options });
    }

    async getBlockNumber(): Promise<number> {
      return 123456;
    }

    async getLogs(): Promise<ethers.Log[]> {
      throw new Error("not needed");
    }
  }

  Object.defineProperty(ethers, "JsonRpcProvider", {
    configurable: true,
    value: FakeProvider,
  });

  try {
    const client: BaseProviderClient = createBaseProviderClient(
      createConfig({
        reconcileRpcUrls: [
          "https://primary.example",
          "https://fallback.example",
        ],
      }),
    );

    await assert.doesNotReject(() => client.getBlockNumber());
    assert.equal(await client.getBlockNumber(), 123456);
    assert.equal(created.length, 2);
    assert.deepEqual(created[0], {
      url: "https://primary.example",
      network: { chainId: 8453, name: "base" },
      options: { staticNetwork: true },
    });
    assert.deepEqual(created[1], {
      url: "https://fallback.example",
      network: { chainId: 8453, name: "base" },
      options: { staticNetwork: true },
    });
  } finally {
    Object.defineProperty(ethers, "JsonRpcProvider", {
      configurable: true,
      value: original,
    });
  }
});

test("createBaseProviderClient falls back across providers for block number and returns the first success", async () => {
  const original = ethers.JsonRpcProvider;
  const calls: string[] = [];

  class FakeProvider {
    readonly url: string;

    constructor(url: string) {
      this.url = url;
    }

    async getBlockNumber(): Promise<number> {
      calls.push(this.url);

      if (this.url === "https://primary.example") {
        throw new Error("primary failed");
      }

      return 654321;
    }

    async getLogs(): Promise<ethers.Log[]> {
      throw new Error("not needed");
    }
  }

  Object.defineProperty(ethers, "JsonRpcProvider", {
    configurable: true,
    value: FakeProvider,
  });

  try {
    const client = createBaseProviderClient(
      createConfig({
        reconcileRpcUrls: [
          "https://primary.example",
          "https://secondary.example",
          "https://tertiary.example",
        ],
      }),
    );

    assert.equal(await client.getBlockNumber(), 654321);
    assert.deepEqual(calls, [
      "https://primary.example",
      "https://secondary.example",
    ]);
  } finally {
    Object.defineProperty(ethers, "JsonRpcProvider", {
      configurable: true,
      value: original,
    });
  }
});

test("createBaseProviderClient falls back across providers for logs and returns the first success", async () => {
  const original = ethers.JsonRpcProvider;
  const calls: string[] = [];
  const expectedLogs = [{ blockNumber: 123 } as ethers.Log];

  class FakeProvider {
    readonly url: string;

    constructor(url: string) {
      this.url = url;
    }

    async getBlockNumber(): Promise<number> {
      return 0;
    }

    async getLogs(filter: ethers.Filter): Promise<ethers.Log[]> {
      calls.push(`${this.url}:${filter.fromBlock}-${filter.toBlock}`);

      if (this.url === "https://primary.example") {
        throw new Error("primary failed");
      }

      return expectedLogs;
    }
  }

  Object.defineProperty(ethers, "JsonRpcProvider", {
    configurable: true,
    value: FakeProvider,
  });

  try {
    const client = createBaseProviderClient(
      createConfig({
        reconcileRpcUrls: [
          "https://primary.example",
          "https://secondary.example",
          "https://tertiary.example",
        ],
      }),
    );
    const filter: ethers.Filter = {
      address: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
      fromBlock: 100,
      toBlock: 200,
    };

    const logs = await client.getLogs(filter);

    assert.equal(logs, expectedLogs);
    assert.deepEqual(calls, [
      "https://primary.example:100-200",
      "https://secondary.example:100-200",
    ]);
  } finally {
    Object.defineProperty(ethers, "JsonRpcProvider", {
      configurable: true,
      value: original,
    });
  }
});

test("createBaseProviderClient throws the last provider error when every log request fails", async () => {
  const original = ethers.JsonRpcProvider;

  class FakeProvider {
    readonly url: string;

    constructor(url: string) {
      this.url = url;
    }

    async getBlockNumber(): Promise<number> {
      return 0;
    }

    async getLogs(): Promise<ethers.Log[]> {
      throw new Error(`${this.url} failed`);
    }
  }

  Object.defineProperty(ethers, "JsonRpcProvider", {
    configurable: true,
    value: FakeProvider,
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

    await assert.rejects(
      () =>
        client.getLogs({
          address: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
        }),
      /secondary\.example failed/,
    );
  } finally {
    Object.defineProperty(ethers, "JsonRpcProvider", {
      configurable: true,
      value: original,
    });
  }
});
