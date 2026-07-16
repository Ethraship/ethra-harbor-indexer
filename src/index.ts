import "dotenv/config";

import { Interface } from "ethers";

import { MORPHO_VAULT_ABI } from "./abi/morphoVault";
import { loadConfig } from "./config";
import { closeDatabase, openDatabase, runMigrations } from "./db";
import { DepositCrawler } from "./indexer/crawler";
import { createLogger } from "./logger";
import { createBaseProviderClient } from "./provider/baseProvider";

function bootstrap(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);
  let shuttingDown = false;

  runMigrations(db);

  const crawler = new DepositCrawler({
    config,
    db,
    provider: createBaseProviderClient(config),
    iface: new Interface(MORPHO_VAULT_ABI),
    logger,
  });

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("shutdown requested", { signal });
    crawler.stop();
    closeDatabase(db);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("starting deposit crawler", {
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
