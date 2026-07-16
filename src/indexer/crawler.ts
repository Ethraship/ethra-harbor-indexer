import { ethers } from "ethers";
import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import {
  applyChunk,
  getOrCreateVaultCursor,
  recordCrawlError,
} from "../db";
import { calculateRange } from "./blockRange";
import { decodeVaultLog, type DecodedVaultEvent } from "./eventDecoder";
import type { BaseProviderClient } from "../provider/baseProvider";

export interface CrawlerDependencies {
  config: AppConfig;
  db: Database.Database;
  provider: BaseProviderClient;
  iface: ethers.Interface;
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface CrawlerTickResult {
  processedLogs: number;
  fromBlock: number | null;
  toBlock: number | null;
  safeHead: number | null;
  hasMore: boolean;
}

function compareEvents(left: DecodedVaultEvent, right: DecodedVaultEvent): number {
  return (
    left.base.blockNumber - right.base.blockNumber ||
    left.base.txIndex - right.base.txIndex ||
    left.base.logIndex - right.base.logIndex
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function nextDelayMs(config: AppConfig, hasMore: boolean): number {
  switch (config.crawlMode) {
    case "fast":
      return config.fastPollMs;
    case "slow":
      return config.slowPollMs;
    case "auto":
    default:
      return hasMore ? config.fastPollMs : config.slowPollMs;
  }
}

export class VaultCrawler {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly provider: BaseProviderClient;
  private readonly iface: ethers.Interface;
  private readonly logger: CrawlerDependencies["logger"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRunLoop: Promise<void> | null = null;
  private stopped = true;

  constructor(dependencies: CrawlerDependencies) {
    this.config = dependencies.config;
    this.db = dependencies.db;
    this.provider = dependencies.provider;
    this.iface = dependencies.iface;
    this.logger = dependencies.logger;
  }

  async tick(): Promise<CrawlerTickResult> {
    const cursor = getOrCreateVaultCursor(this.db, this.config);
    const head = await this.provider.getBlockNumber();
    const range = calculateRange(
      cursor,
      head,
      this.config.confirmations,
      this.config.chunkSize,
    );

    if (!range) {
      return {
        processedLogs: 0,
        fromBlock: null,
        toBlock: null,
        safeHead: null,
        hasMore: false,
      };
    }

    try {
      const depositFragment = this.iface.getEvent("Deposit")!;
      const withdrawFragment = this.iface.getEvent("Withdraw")!;
      const transferFragment = this.iface.getEvent("Transfer")!;
      const accrueFragment = this.iface.getEvent("AccrueInterest")!;
      const topics = [[
        depositFragment.topicHash,
        withdrawFragment.topicHash,
        transferFragment.topicHash,
        accrueFragment.topicHash,
      ]];
      const logs = await this.provider.getLogs({
        address: this.config.contractAddress,
        topics,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      });
      const decodedEvents = logs.map((log) => {
        const decodedEvent = decodeVaultLog(log, this.iface, this.config);

        if (!decodedEvent) {
          throw new Error(
            `encountered undecodable vault log for ${log.transactionHash}:${log.index} in chunk ${range.fromBlock}-${range.toBlock}`,
          );
        }

        return decodedEvent;
      });
      decodedEvents.sort(compareEvents);

      applyChunk(this.db, this.config, {
        decodedEvents,
        toBlock: range.toBlock,
      });

      this.logger.debug("crawler chunk processed", {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        processedLogs: decodedEvents.length,
        safeHead: range.safeHead,
        hasMore: range.hasMore,
      });

      return {
        processedLogs: decodedEvents.length,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        safeHead: range.safeHead,
        hasMore: range.hasMore,
      };
    } catch (error) {
      const message = errorMessage(error);

      recordCrawlError(this.db, {
        chainId: this.config.chainId,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        message,
        createdAt: Date.now(),
      });
      this.logger.error("crawler chunk failed", {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        message,
      });

      throw error;
    }
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.activeRunLoop;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(async () => {
      this.timer = null;

      if (this.stopped) {
        return;
      }

      const runLoop = this.runLoop();
      this.activeRunLoop = runLoop;

      try {
        await runLoop;
      } finally {
        if (this.activeRunLoop === runLoop) {
          this.activeRunLoop = null;
        }
      }
    }, delayMs);
  }

  private async runLoop(): Promise<void> {
    try {
      const result = await this.tick();

      if (!this.stopped) {
        this.schedule(nextDelayMs(this.config, result.hasMore));
      }
    } catch (error) {
      if (!this.stopped) {
        this.schedule(nextDelayMs(this.config, false));
      }
    }
  }
}
