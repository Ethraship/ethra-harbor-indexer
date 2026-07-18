# PM2 Ecosystem Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PM2 ecosystem file that runs the compiled Ethra Harbor Indexer through the existing production `npm start` script while keeping runtime settings in `.env`.

**Architecture:** PM2 owns process supervision only. The Node entrypoint continues to load `.env` through `dotenv/config`, and `cwd` is pinned to the repository root so relative `.env` and SQLite paths resolve consistently.

**Tech Stack:** Node.js, TypeScript/CommonJS build output, PM2 ecosystem config, dotenv, SQLite.

## Global Constraints

- Keep runtime environment values in `.env`; do not duplicate RPC URLs, contract addresses, or crawler settings in PM2.
- Run the production script: `npm start`, which executes `node dist/index.js`.
- Require `npm run build` before starting PM2 because `dist/` is gitignored build output.
- Keep this backend-oriented; do not add frontend/mobile assumptions or extra runtime dependencies.
- Update `docs/evolution.md` after this substantive operational/config change.

---

### Task 1: Add PM2 Process Config

**Files:**
- Create: `ecosystem.config.cjs`
- Modify: `README.md`
- Modify: `docs/evolution.md`

**Interfaces:**
- Consumes: `package.json` script `start: node dist/index.js`
- Produces: PM2 app named `ethra-harbor-indexer`

- [x] **Step 1: Create `ecosystem.config.cjs`**

```js
"use strict";

module.exports = {
  apps: [
    {
      name: "ethra-harbor-indexer",
      script: "npm",
      args: "start",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      time: true,
    },
  ],
};
```

- [x] **Step 2: Document PM2 usage in `README.md`**

Add commands showing `npm run build`, `pm2 start ecosystem.config.cjs`, `pm2 save`, reload, PM2's default log viewer, and stop.

- [x] **Step 3: Document the change in `docs/evolution.md`**

Add a 2026-07-18 entry describing the PM2 config and why `.env` remains the source of runtime settings.

- [x] **Step 4: Verify**

Run: `npm run build`

Expected: TypeScript compilation succeeds with exit code `0`.

Run: `node -e "const path = require('node:path'); const config = require('./ecosystem.config.cjs'); const app = config.apps[0]; if (app.name !== 'ethra-harbor-indexer' || app.script !== 'npm' || app.args !== 'start' || app.cwd !== path.resolve('.')) process.exit(1);"`

Expected: command exits with code `0`.

- [x] **Step 5: Review**

Run: `git diff -- ecosystem.config.cjs README.md docs/evolution.md docs/plans/2026-07-18-pm2-ecosystem-config.md`

Expected: diff is limited to the PM2 config, PM2 docs, evolution entry, and this plan.
