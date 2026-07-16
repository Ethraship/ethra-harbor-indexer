import { getAddress, type Interface, type Log } from "ethers";

import type { AppConfig } from "../config";
import { stringifyRawLog } from "./depositParser";

export interface BaseLogFields {
  chainId: number;
  contractAddress: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  rawLogJson: string;
  createdAt: number;
}

export type DecodedVaultEvent =
  | {
      kind: "deposit";
      sender: string;
      onBehalf: string;
      assets: string;
      shares: string;
      base: BaseLogFields;
    }
  | {
      kind: "withdraw";
      sender: string;
      receiver: string;
      onBehalf: string;
      assets: string;
      shares: string;
      base: BaseLogFields;
    }
  | {
      kind: "transfer";
      from: string;
      to: string;
      shares: string;
      base: BaseLogFields;
    }
  | {
      kind: "accrue";
      previousTotalAssets: string;
      newTotalAssets: string;
      performanceFeeShares: string;
      managementFeeShares: string;
      base: BaseLogFields;
    };

function buildBaseLogFields(
  log: Log,
  config: AppConfig,
  contractAddress: string,
): BaseLogFields {
  return {
    chainId: config.chainId,
    contractAddress,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    txIndex: log.transactionIndex,
    logIndex: log.index,
    rawLogJson: stringifyRawLog(log),
    createdAt: Date.now(),
  };
}

export function decodeVaultLog(
  log: Log,
  iface: Interface,
  config: AppConfig,
): DecodedVaultEvent | null {
  if (config.chainId !== 8453) {
    return null;
  }

  let logContractAddress: string;
  let configContractAddress: string;

  try {
    logContractAddress = getAddress(log.address);
    configContractAddress = getAddress(config.contractAddress);
  } catch {
    return null;
  }

  if (logContractAddress !== configContractAddress) {
    return null;
  }

  let parsedLog;

  try {
    parsedLog = iface.parseLog(log);
  } catch {
    return null;
  }

  if (!parsedLog) {
    return null;
  }

  const base = buildBaseLogFields(log, config, logContractAddress);

  switch (parsedLog.name) {
    case "Deposit":
      return {
        kind: "deposit",
        sender: getAddress(parsedLog.args.sender),
        onBehalf: getAddress(parsedLog.args.onBehalf),
        assets: parsedLog.args.assets.toString(),
        shares: parsedLog.args.shares.toString(),
        base,
      };
    case "Withdraw":
      return {
        kind: "withdraw",
        sender: getAddress(parsedLog.args.sender),
        receiver: getAddress(parsedLog.args.receiver),
        onBehalf: getAddress(parsedLog.args.onBehalf),
        assets: parsedLog.args.assets.toString(),
        shares: parsedLog.args.shares.toString(),
        base,
      };
    case "Transfer":
      return {
        kind: "transfer",
        from: getAddress(parsedLog.args.from),
        to: getAddress(parsedLog.args.to),
        shares: parsedLog.args.shares.toString(),
        base,
      };
    case "AccrueInterest":
      return {
        kind: "accrue",
        previousTotalAssets: parsedLog.args.previousTotalAssets.toString(),
        newTotalAssets: parsedLog.args.newTotalAssets.toString(),
        performanceFeeShares: parsedLog.args.performanceFeeShares.toString(),
        managementFeeShares: parsedLog.args.managementFeeShares.toString(),
        base,
      };
    default:
      return null;
  }
}
