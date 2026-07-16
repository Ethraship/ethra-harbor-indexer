import { getAddress } from "ethers";

export type CrawlMode = "auto" | "fast" | "slow";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  reconcileRpcUrls: string[];
  contractAddress: string;
  databasePath: string;
  startBlock: number;
  confirmations: number;
  chunkSize: number;
  blockTimeMs: number;
  fastPollMs: number;
  slowPollMs: number;
  crawlMode: CrawlMode;
  logLevel: LogLevel;
}

const DEFAULTS = {
  BASE_CHAIN_ID: "8453",
  BASE_RPC_URL: "https://base-rpc.publicnode.com",
  BASE_CONTRACT_ADDRESS: "0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d",
  DATABASE_PATH: "./data/ethra-harbor-indexer.sqlite",
  START_BLOCK: "0",
  CONFIRMATIONS: "2",
  CHUNK_SIZE: "1000",
  BASE_BLOCK_TIME_MS: "2000",
  FAST_POLL_MS: "2000",
  SLOW_POLL_MS: "50000",
  CRAWL_MODE: "auto",
  RECONCILE_RPC_URLS: "",
  LOG_LEVEL: "info",
} as const;

const CRAWL_MODES = new Set<CrawlMode>(["auto", "fast", "slow"]);
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function readNumber(
  env: NodeJS.ProcessEnv,
  key: keyof typeof DEFAULTS,
  minimum?: number,
): number {
  const rawValue = env[key] ?? DEFAULTS[key];
  const value = Number(rawValue);

  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }

  if (minimum !== undefined && value < minimum) {
    throw new Error(`${key} must be greater than or equal to ${minimum}`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const chainId = readNumber(env, "BASE_CHAIN_ID");
  if (chainId !== 8453) {
    throw new Error(`BASE_CHAIN_ID must be 8453`);
  }

  const crawlMode = (env.CRAWL_MODE ?? DEFAULTS.CRAWL_MODE) as CrawlMode;
  if (!CRAWL_MODES.has(crawlMode)) {
    throw new Error(`CRAWL_MODE must be one of auto, fast, or slow`);
  }

  const logLevel = (env.LOG_LEVEL ?? DEFAULTS.LOG_LEVEL) as LogLevel;
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of debug, info, warn, or error`);
  }

  const rpcUrl = env.BASE_RPC_URL ?? DEFAULTS.BASE_RPC_URL;
  const reconcileRpcUrls = [
    rpcUrl,
    ...(env.RECONCILE_RPC_URLS ?? DEFAULTS.RECONCILE_RPC_URLS)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  ];

  let contractAddress: string;
  try {
    contractAddress = getAddress(
      env.BASE_CONTRACT_ADDRESS ?? DEFAULTS.BASE_CONTRACT_ADDRESS,
    );
  } catch {
    throw new Error(`BASE_CONTRACT_ADDRESS is invalid`);
  }

  return {
    chainId,
    rpcUrl,
    reconcileRpcUrls,
    contractAddress,
    databasePath: env.DATABASE_PATH ?? DEFAULTS.DATABASE_PATH,
    startBlock: readNumber(env, "START_BLOCK", 0),
    confirmations: readNumber(env, "CONFIRMATIONS", 0),
    chunkSize: readNumber(env, "CHUNK_SIZE", 1),
    blockTimeMs: readNumber(env, "BASE_BLOCK_TIME_MS", 1),
    fastPollMs: readNumber(env, "FAST_POLL_MS", 250),
    slowPollMs: readNumber(env, "SLOW_POLL_MS", 1000),
    crawlMode,
    logLevel,
  };
}
