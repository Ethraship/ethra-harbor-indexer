import http from "node:http";

import { getAddress } from "ethers";
import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import { readVaultCursor } from "../db";
import { getAccountMetrics, getVaultMetrics } from "./queries";

export interface ApiServerDependencies {
  db: Database.Database;
  config: AppConfig;
  health?: {
    safeHead: number | null;
  };
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

export function createApiServer(dependencies: ApiServerDependencies): http.Server {
  const { db, config, health } = dependencies;

  return http.createServer((request, response) => {
    if (!request.url) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method !== "GET") {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    if (url.pathname === "/health") {
      const cursorBlock = readVaultCursor(db, config);
      const safeHead = health?.safeHead ?? null;

      writeJson(response, 200, {
        status: "ok",
        cursorBlock,
        safeHead,
        safeHeadKnown: safeHead !== null,
        syncedToSafeHead:
          cursorBlock !== null && safeHead !== null && cursorBlock >= safeHead,
      });
      return;
    }

    if (url.pathname === "/vault") {
      writeJson(response, 200, getVaultMetrics(db, config));
      return;
    }

    const accountMatch = /^\/accounts\/([^/]+)$/.exec(url.pathname);
    if (!accountMatch) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    try {
      const address = getAddress(accountMatch[1]!);
      writeJson(response, 200, getAccountMetrics(db, config, address));
    } catch {
      writeJson(response, 400, {
        error: "invalid address",
      });
    }
  });
}
