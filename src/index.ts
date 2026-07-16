import "dotenv/config";

import { Interface } from "ethers";

import { MORPHO_VAULT_ABI } from "./abi/morphoVault";
import { loadConfig } from "./config";
import { closeDatabase, openDatabase, runMigrations } from "./db";
import { VaultCrawler } from "./indexer/crawler";
import { createLogger } from "./logger";
import { createBaseProviderClient } from "./provider/baseProvider";

function bootstrap(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);
  let shuttingDown = false;

  runMigrations(db);

  const crawler = new VaultCrawler({
    config,
    db,
    provider: createBaseProviderClient(config),
    iface: new Interface(MORPHO_VAULT_ABI),
    logger,
  });

  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("shutdown requested", { signal });

    try {
      await crawler.stop();
      closeDatabase(db);
      logger.info("shutdown complete", { signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("shutdown failed", { signal, message });
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  logger.info("starting vault crawler", {
    contractAddress: config.contractAddress,
    startBlock: config.startBlock,
    chunkSize: config.chunkSize,
    crawlMode: config.crawlMode,
  });
  crawler.start();
}

try {
  bootstrap();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: "error", message }));
  process.exitCode = 1;
}
