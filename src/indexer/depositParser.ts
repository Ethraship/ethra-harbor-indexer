import { Interface, getAddress, type Log } from "ethers";

import type { AppConfig } from "../config";

export interface ParsedDepositEvent {
  chainId: number;
  contractAddress: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  sender: string;
  onBehalf: string;
  assets: string;
  shares: string;
  rawLogJson: string;
  createdAt: number;
}

function stringifyRawLog(log: Log): string {
  return JSON.stringify(log, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function parseDepositLog(
  log: Log,
  iface: Interface,
  config: AppConfig,
): ParsedDepositEvent | null {
  let parsedLog;

  try {
    parsedLog = iface.parseLog(log);
  } catch {
    return null;
  }

  if (!parsedLog || parsedLog.name !== "Deposit") {
    return null;
  }

  return {
    chainId: config.chainId,
    contractAddress: getAddress(log.address),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    txIndex: log.transactionIndex,
    logIndex: log.index,
    sender: getAddress(parsedLog.args.sender),
    onBehalf: getAddress(parsedLog.args.onBehalf),
    assets: parsedLog.args.assets.toString(),
    shares: parsedLog.args.shares.toString(),
    rawLogJson: stringifyRawLog(log),
    createdAt: Date.now(),
  };
}
