import "dotenv/config";

import http from "node:http";

import { Interface } from "ethers";

import { MORPHO_VAULT_ABI } from "./abi/morphoVault";
import { createApiServer } from "./api/server";
import { loadConfig } from "./config";
import { closeDatabase, openDatabase, runMigrations } from "./db";
import { VaultCrawler } from "./indexer/crawler";
import { createLogger, serializeError } from "./logger";
import { createBaseProviderClient } from "./provider/baseProvider";
import {
  SharePriceSnapshotter,
  type SharePriceReader,
} from "./snapshot/sharePrice";

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);
  let shuttingDown = false;
  let dbClosed = false;
  let crawler: VaultCrawler | null = null;
  let snapshotter: SharePriceSnapshotter | null = null;
  let apiServer: http.Server | null = null;
  const health = {
    safeHead: null as number | null,
  };

  const closeDbOnce = () => {
    if (dbClosed) {
      return;
    }

    closeDatabase(db);
    dbClosed = true;
  };

  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("shutdown requested", { signal });

    let shutdownError: unknown;

    try {
      await crawler?.stop();
    } catch (error) {
      shutdownError = error;
      logger.error("crawler shutdown failed", { signal, error: serializeError(error) });
    }

    try {
      await snapshotter?.stop();
    } catch (error) {
      shutdownError ??= error;
      logger.error("snapshotter shutdown failed", {
        signal,
        error: serializeError(error),
      });
    }

    try {
      if (apiServer) {
        await closeServer(apiServer);
      }
    } catch (error) {
      shutdownError ??= error;
      logger.error("api server shutdown failed", { signal, error: serializeError(error) });
    } finally {
      closeDbOnce();
    }

    if (shutdownError) {
      logger.error("shutdown failed", {
        signal,
        error: serializeError(shutdownError),
      });
      process.exitCode = 1;
      return;
    }

    logger.info("shutdown complete", { signal });
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    runMigrations(db);

    if (shuttingDown) {
      closeDbOnce();
      return;
    }

    const provider = createBaseProviderClient(config);

    crawler = new VaultCrawler({
      config,
      db,
      provider,
      iface: new Interface(MORPHO_VAULT_ABI),
      onTickResult: (result) => {
        health.safeHead = result.safeHead;
      },
      logger,
    });

    snapshotter = new SharePriceSnapshotter({
      config,
      db,
      provider: provider as SharePriceReader,
      logger,
    });

    if (config.apiEnabled) {
      apiServer = createApiServer({ db, config, health });
      await listen(apiServer, config.apiPort);

      if (shuttingDown) {
        closeDbOnce();
        return;
      }

      logger.info("api server listening", {
        port: config.apiPort,
      });
    }

    logger.info("starting indexer", {
      contractAddress: config.contractAddress,
      startBlock: config.startBlock,
      chunkSize: config.chunkSize,
      crawlMode: config.crawlMode,
      snapshotIntervalMs: config.snapshotIntervalMs,
      apiEnabled: config.apiEnabled,
      apiPort: config.apiEnabled ? config.apiPort : null,
    });

    crawler.start();
    snapshotter.start();
  } catch (error) {
    closeDbOnce();
    if (shuttingDown) {
      return;
    }

    throw error;
  }
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: "error", message }));
  process.exitCode = 1;
});
