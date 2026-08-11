import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress } from "ethers";
import type Database from "better-sqlite3";

import type { AppConfig } from "../config";
import { readVaultCursor } from "../db";
import {
  handleAdminRequest,
  InvalidAdminRequestError,
  requireAdminAuth,
} from "./admin";
import { getOverviewStats, parseOverviewWindowDays } from "./overview";
import { getAccountMetrics, getVaultMetrics } from "./queries";
import { MutationNotReadyError, StaleFeeMintError } from "../rewards/settle";

const DASHBOARD_ROOT = join(process.cwd(), "public");
const VENDOR_ROOT = join(process.cwd(), "node_modules");

type StaticAsset = {
  root: string;
  fileName: string;
  contentType: string;
};

const DASHBOARD_ASSETS = new Map<string, StaticAsset>([
  [
    "/dashboard",
    {
      root: DASHBOARD_ROOT,
      fileName: "dashboard.html",
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/dashboard/",
    {
      root: DASHBOARD_ROOT,
      fileName: "dashboard.html",
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/dashboard/styles.css",
    {
      root: DASHBOARD_ROOT,
      fileName: "dashboard.css",
      contentType: "text/css; charset=utf-8",
    },
  ],
  [
    "/dashboard/app.js",
    {
      root: DASHBOARD_ROOT,
      fileName: "dashboard.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/overview",
    {
      root: DASHBOARD_ROOT,
      fileName: "overview.html",
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/overview/",
    {
      root: DASHBOARD_ROOT,
      fileName: "overview.html",
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/overview/styles.css",
    {
      root: DASHBOARD_ROOT,
      fileName: "overview.css",
      contentType: "text/css; charset=utf-8",
    },
  ],
  [
    "/overview/app.js",
    {
      root: DASHBOARD_ROOT,
      fileName: "overview.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/overview/chart.umd.min.js",
    {
      root: VENDOR_ROOT,
      fileName: "chart.js/dist/chart.umd.min.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/admin",
    {
      root: DASHBOARD_ROOT,
      fileName: "admin.html",
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/admin/",
    {
      root: DASHBOARD_ROOT,
      fileName: "admin.html",
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/admin/app.js",
    {
      root: DASHBOARD_ROOT,
      fileName: "admin.js",
      contentType: "text/javascript; charset=utf-8",
    },
  ],
]);

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
  includeBody = true,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  if (!includeBody) {
    response.end();
    return;
  }

  response.end(JSON.stringify(body));
}

function writeText(
  response: http.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.end(body);
}

function tryWriteDashboardAsset(
  response: http.ServerResponse,
  pathname: string,
): boolean {
  const asset = DASHBOARD_ASSETS.get(pathname);
  if (!asset) {
    return false;
  }

  const body = readFileSync(join(asset.root, asset.fileName), "utf8");
  writeText(response, 200, asset.contentType, body);
  return true;
}

export function createApiServer(dependencies: ApiServerDependencies): http.Server {
  const { db, config, health } = dependencies;
  const adminEnabled = config.adminApiToken !== null;

  return http.createServer(async (request, response) => {
    if (!request.url) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "PUT"
    ) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      tryWriteDashboardAsset(response, url.pathname)
    ) {
      return;
    }

    if (url.pathname.startsWith("/admin/")) {
      const isPublicAdminRead =
        request.method === "GET" &&
        (url.pathname === "/admin/boost/changes" ||
          url.pathname === "/admin/boost/wallets" ||
          /^\/admin\/vship\/settlements\/[^/]+$/.test(url.pathname));

      if (!isPublicAdminRead) {
        if (!adminEnabled) {
          writeJson(response, 404, { error: "not found" });
          return;
        }
        if (!requireAdminAuth(request, config.adminApiToken!)) {
          writeJson(response, 401, { error: "unauthorized" });
          return;
        }
      }

      try {
        const handled = await handleAdminRequest(
          request,
          response,
          db,
          config,
          health?.safeHead ?? null,
          url.pathname,
        );
        if (!handled) {
          writeJson(response, 404, { error: "not found" });
        }
      } catch (error) {
        if (error instanceof InvalidAdminRequestError) {
          writeJson(response, 400, { error: "invalid request" });
        } else if (error instanceof MutationNotReadyError) {
          writeJson(response, 409, { error: "indexer not ready" });
        } else if (error instanceof StaleFeeMintError) {
          writeJson(response, 409, { error: "fee mint is stale" });
        } else {
          writeJson(response, 500, { error: "internal server error" });
        }
      }
      return;
    }

    if (request.method === "PUT") {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    if (url.pathname === "/health") {
      const cursorBlock = readVaultCursor(db, config);
      const safeHead = health?.safeHead ?? null;
      const isHead = request.method === "HEAD";

      writeJson(response, 200, {
        status: "ok",
        cursorBlock,
        safeHead,
        safeHeadKnown: safeHead !== null,
        syncedToSafeHead:
          cursorBlock !== null && safeHead !== null && cursorBlock >= safeHead,
      }, !isHead);
      return;
    }

    if (url.pathname === "/vault") {
      writeJson(response, 200, getVaultMetrics(db, config));
      return;
    }

    if (url.pathname === "/overview/stats") {
      try {
        const windowDays = parseOverviewWindowDays(url.searchParams.get("windowDays"));
        writeJson(response, 200, getOverviewStats(db, config, windowDays));
      } catch {
        writeJson(response, 400, { error: "invalid windowDays" });
      }
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
