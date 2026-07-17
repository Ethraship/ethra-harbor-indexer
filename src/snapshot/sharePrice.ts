import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import { insertSnapshot, type Snapshot } from "../db";
import { serializeError } from "../logger";
import type { VaultTotalsSnapshot } from "../provider/baseProvider";

export interface SharePriceReader {
  readVaultTotals(config: AppConfig): Promise<VaultTotalsSnapshot>;
}

export interface SharePriceSnapshotterDependencies {
  config: AppConfig;
  db: Database.Database;
  provider: SharePriceReader;
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export function valueOfShares(sharesRaw: bigint, snapshot: Snapshot): bigint {
  const totalSupplyRaw = BigInt(snapshot.totalSupplyRaw);

  if (totalSupplyRaw === 0n) {
    return 0n;
  }

  return (sharesRaw * BigInt(snapshot.totalAssetsRaw)) / totalSupplyRaw;
}

export class SharePriceSnapshotter {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly provider: SharePriceReader;
  private readonly logger: SharePriceSnapshotterDependencies["logger"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRunLoop: Promise<void> | null = null;
  private stopped = true;

  constructor(dependencies: SharePriceSnapshotterDependencies) {
    this.config = dependencies.config;
    this.db = dependencies.db;
    this.provider = dependencies.provider;
    this.logger = dependencies.logger;
  }

  async snapshotOnce(): Promise<void> {
    const totals = await this.provider.readVaultTotals(this.config);

    insertSnapshot(this.db, {
      blockNumber: totals.blockNumber,
      totalAssetsRaw: totals.totalAssetsRaw,
      totalSupplyRaw: totals.totalSupplyRaw,
      capturedAt: Date.now(),
    });

    this.logger.debug("share price snapshot captured", {
      blockNumber: totals.blockNumber,
      totalAssetsRaw: totals.totalAssetsRaw,
      totalSupplyRaw: totals.totalSupplyRaw,
    });
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
      await this.snapshotOnce();

      if (!this.stopped) {
        this.schedule(this.config.snapshotIntervalMs);
      }
    } catch (error) {
      this.logger.error("share price snapshot failed", {
        error: serializeError(error),
      });

      if (!this.stopped) {
        this.schedule(this.config.snapshotIntervalMs);
      }
    }
  }
}
