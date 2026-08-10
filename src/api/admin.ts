import http from "node:http";

import type Database from "better-sqlite3";
import { getAddress } from "ethers";

import type { AppConfig } from "../config";
import {
  listBoostChangeEvents,
  listVshipSettlementEvents,
  type BoostChangeEventRow,
  type VshipSettlementEventRow,
} from "../db/rewards";
import {
  setBaseBoost,
  setWalletAdditionalBoost,
} from "../rewards/settle";

export class InvalidAdminRequestError extends Error {}

export function requireAdminAuth(
  request: http.IncomingMessage,
  adminApiToken: string,
): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === adminApiToken;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readNonNegativeIntegerString(
  request: http.IncomingMessage,
  field: "baseBoostBps" | "additionalBoostBps",
): Promise<bigint> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch {
    throw new InvalidAdminRequestError();
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !(field in body) ||
    typeof body[field as keyof typeof body] !== "string"
  ) {
    throw new InvalidAdminRequestError();
  }

  const value = body[field as keyof typeof body] as string;
  if (!/^\d+$/.test(value)) {
    throw new InvalidAdminRequestError();
  }

  return BigInt(value);
}

function serializeBoostChangeEvent(row: BoostChangeEventRow) {
  return {
    ...row,
    oldBps: row.oldBps.toString(),
    newBps: row.newBps.toString(),
  };
}

function serializeVshipSettlementEvent(row: VshipSettlementEventRow) {
  return {
    ...row,
    feeBeforeRaw: row.feeBeforeRaw.toString(),
    feeAfterRaw: row.feeAfterRaw.toString(),
    feeDeltaRaw: row.feeDeltaRaw.toString(),
    boostBpsApplied: row.boostBpsApplied.toString(),
    vshipMintedRaw: row.vshipMintedRaw.toString(),
    crystallizedVshipAfterRaw: row.crystallizedVshipAfterRaw.toString(),
  };
}

export async function handleAdminRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  db: Database.Database,
  config: AppConfig,
  safeHead: number | null,
  pathname: string,
): Promise<boolean> {
  if (request.method === "PUT" && pathname === "/admin/boost/base") {
    const baseBoostBps = await readNonNegativeIntegerString(request, "baseBoostBps");
    const result = setBaseBoost(db, config, baseBoostBps, safeHead, "admin");
    writeJson(response, 200, {
      ok: true,
      ...result,
      baseBoostBps: baseBoostBps.toString(),
    });
    return true;
  }

  const walletBoostMatch = /^\/admin\/boost\/wallets\/([^/]+)$/.exec(pathname);
  if (request.method === "PUT" && walletBoostMatch) {
    let address: string;
    try {
      address = getAddress(walletBoostMatch[1]!);
    } catch {
      throw new InvalidAdminRequestError();
    }

    const additionalBoostBps = await readNonNegativeIntegerString(
      request,
      "additionalBoostBps",
    );
    const result = setWalletAdditionalBoost(
      db,
      config,
      address,
      additionalBoostBps,
      safeHead,
      "admin",
    );
    writeJson(response, 200, {
      ok: true,
      ...result,
      additionalBoostBps: additionalBoostBps.toString(),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/admin/boost/changes") {
    writeJson(response, 200, listBoostChangeEvents(db).map(serializeBoostChangeEvent));
    return true;
  }

  const settlementsMatch = /^\/admin\/vship\/settlements\/([^/]+)$/.exec(pathname);
  if (request.method === "GET" && settlementsMatch) {
    let address: string;
    try {
      address = getAddress(settlementsMatch[1]!);
    } catch {
      throw new InvalidAdminRequestError();
    }

    writeJson(
      response,
      200,
      listVshipSettlementEvents(db, address).map(serializeVshipSettlementEvent),
    );
    return true;
  }

  return false;
}
