# API Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a lightweight browser dashboard for the existing `/health`, `/vault`, and `/accounts/:address` API routes.

**Architecture:** The existing `node:http` server will serve a static dashboard from `public/` at `/dashboard`. Browser JavaScript will call the existing same-origin JSON routes, render readable metric cards, and preserve raw blockchain integer values for auditability.

**Tech Stack:** Node.js, TypeScript, CommonJS, built-in `node:http`, static HTML/CSS/JavaScript, `node:test`.

## Global Constraints

- Keep this repository a backend indexer; do not add React, a frontend framework, a bundler, or wallet UX.
- Keep the API read-only. Do not add write endpoints or request-path RPC calls.
- Serve only known static dashboard assets; do not add a general-purpose file server.
- Format USDC-like raw values as six-decimal values and share-like raw values as eighteen-decimal values.
- Preserve raw values in the dashboard UI.
- Add focused API tests before implementation.
- Update `README.md`, `docs/overview.md`, `docs/architecture.md`, and `docs/evolution.md` after the behavior change.

---

### Task 1: Static Dashboard Route Tests

**Files:**
- Modify: `test/api.test.ts`

**Interfaces:**
- Consumes: `createApiServer({ db, config })`
- Produces: route expectations for `GET /dashboard`, `GET /dashboard/`, `GET /dashboard/styles.css`, `GET /dashboard/app.js`, and unknown dashboard assets.

- [x] **Step 1: Write the failing test**

Add a test near the other API server tests:

```ts
test("api serves the dashboard shell and static assets", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig();
  const server = createApiServer({ db, config });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    closeDatabase(db);
  });

  runMigrations(db);

  const baseUrl = await startServer(server);
  const [dashboardRes, dashboardSlashRes, cssRes, jsRes, missingRes] =
    await Promise.all([
      fetch(`${baseUrl}/dashboard`),
      fetch(`${baseUrl}/dashboard/`),
      fetch(`${baseUrl}/dashboard/styles.css`),
      fetch(`${baseUrl}/dashboard/app.js`),
      fetch(`${baseUrl}/dashboard/missing.js`),
    ]);

  assert.equal(dashboardRes.status, 200);
  assert.equal(dashboardSlashRes.status, 200);
  assert.equal(cssRes.status, 200);
  assert.equal(jsRes.status, 200);
  assert.equal(missingRes.status, 404);

  assert.match(dashboardRes.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(cssRes.headers.get("content-type") ?? "", /^text\/css/);
  assert.match(jsRes.headers.get("content-type") ?? "", /^text\/javascript/);

  const html = await dashboardRes.text();
  assert.match(html, /Ethra Harbor Dashboard/);
  assert.match(html, /\/dashboard\/styles\.css/);
  assert.match(html, /\/dashboard\/app\.js/);

  assert.deepEqual(await missingRes.json(), {
    error: "not found",
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/api.test.ts`

Expected: FAIL because `/dashboard` returns `404`.

### Task 2: Serve Known Dashboard Assets

**Files:**
- Modify: `src/api/server.ts`
- Create: `public/dashboard.html`
- Create: `public/dashboard.css`
- Create: `public/dashboard.js`

**Interfaces:**
- Consumes: browser requests for `GET /dashboard`, `GET /dashboard/`, `GET /dashboard/styles.css`, and `GET /dashboard/app.js`
- Produces: static responses with explicit content type strings.

- [x] **Step 1: Add minimal initial assets**

Create:

```html
<!-- public/dashboard.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ethra Harbor Dashboard</title>
    <link rel="stylesheet" href="/dashboard/styles.css">
  </head>
  <body>
    <main>
      <h1>Ethra Harbor Dashboard</h1>
    </main>
    <script src="/dashboard/app.js" defer></script>
  </body>
</html>
```

```css
/* public/dashboard.css */
body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

```js
// public/dashboard.js
document.documentElement.dataset.dashboardReady = "true";
```

- [x] **Step 2: Implement static asset serving in `src/api/server.ts`**

Add imports:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

Add constants near the top:

```ts
const DASHBOARD_ROOT = join(process.cwd(), "public");
const DASHBOARD_ASSETS = new Map<string, { fileName: string; contentType: string }>([
  ["/dashboard", { fileName: "dashboard.html", contentType: "text/html; charset=utf-8" }],
  ["/dashboard/", { fileName: "dashboard.html", contentType: "text/html; charset=utf-8" }],
  [
    "/dashboard/styles.css",
    { fileName: "dashboard.css", contentType: "text/css; charset=utf-8" },
  ],
  [
    "/dashboard/app.js",
    { fileName: "dashboard.js", contentType: "text/javascript; charset=utf-8" },
  ],
]);
```

Add helper:

```ts
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

  const body = readFileSync(join(DASHBOARD_ROOT, asset.fileName), "utf8");
  writeText(response, 200, asset.contentType, body);
  return true;
}
```

Call it after method/url parsing and before `/health`:

```ts
if (tryWriteDashboardAsset(response, url.pathname)) {
  return;
}
```

- [x] **Step 3: Run the targeted test**

Run: `node --import tsx --test test/api.test.ts`

Expected: PASS.

### Task 3: Build Dashboard UI Behavior

**Files:**
- Modify: `public/dashboard.html`
- Modify: `public/dashboard.css`
- Modify: `public/dashboard.js`

**Interfaces:**
- Consumes: JSON from `/health`, `/vault`, and `/accounts/:address`
- Produces: readable dashboard state in the browser.

- [x] **Step 1: Replace initial HTML with semantic dashboard markup**

Use:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ethra Harbor Dashboard</title>
    <link rel="stylesheet" href="/dashboard/styles.css">
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div>
          <p class="label">Base Morpho Vault V2</p>
          <h1>Ethra Harbor Dashboard</h1>
        </div>
        <button class="button button-secondary" id="refresh-overview" type="button">
          Refresh
        </button>
      </header>

      <section class="status-strip" aria-live="polite">
        <div>
          <span class="status-dot" id="health-dot"></span>
          <span id="health-summary">Loading health</span>
        </div>
        <span id="last-refresh">Waiting for first refresh</span>
      </section>

      <section class="grid grid-two">
        <article class="panel">
          <div class="panel-heading">
            <h2>Indexer Health</h2>
            <span class="pill" id="health-pill">Loading</span>
          </div>
          <div class="metric-list" id="health-metrics"></div>
          <p class="error-text" id="health-error" hidden></p>
        </article>

        <article class="panel">
          <div class="panel-heading">
            <h2>Vault Metrics</h2>
            <span class="pill" id="vault-pill">Loading</span>
          </div>
          <div class="metric-list" id="vault-metrics"></div>
          <p class="error-text" id="vault-error" hidden></p>
        </article>
      </section>

      <section class="panel account-panel">
        <div class="panel-heading">
          <div>
            <h2>Account Lookup</h2>
            <p class="panel-copy">Enter a wallet address to read the indexed account metrics.</p>
          </div>
        </div>

        <form class="lookup-form" id="lookup-form">
          <label for="address-input">Wallet address</label>
          <div class="lookup-row">
            <input
              id="address-input"
              name="address"
              type="text"
              inputmode="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="0x..."
            >
            <button class="button" id="lookup-button" type="submit">Get Details</button>
          </div>
          <p class="error-text" id="account-error" hidden></p>
        </form>

        <div class="empty-state" id="account-empty">
          Address metrics will appear here after a lookup.
        </div>
        <div class="account-results" id="account-results" hidden></div>
      </section>
    </main>
    <script src="/dashboard/app.js" defer></script>
  </body>
</html>
```

- [x] **Step 2: Add restrained responsive product styling**

Use a neutral, readable product dashboard palette with explicit loading/error
states, stable card dimensions, and responsive columns.

- [x] **Step 3: Implement dashboard JavaScript**

Implement these functions:

```js
const USDC_DECIMALS = 6;
const SHARE_DECIMALS = 18;

async function fetchJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }
  return body;
}

function formatRawDecimal(value, decimals, suffix) {
  if (value === null || value === undefined) {
    return "Not captured yet";
  }

  const negative = String(value).startsWith("-");
  const digits = negative ? String(value).slice(1) : String(value);
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  const formatted = fraction ? `${whole}.${fraction}` : whole;
  return `${negative ? "-" : ""}${formatted} ${suffix}`;
}

function renderMetricList(container, metrics) {
  container.replaceChildren(
    ...metrics.map(({ label, value, raw }) => {
      const item = document.createElement("div");
      item.className = "metric";
      const name = document.createElement("span");
      name.textContent = label;
      const display = document.createElement("strong");
      display.textContent = value;
      item.append(name, display);
      if (raw !== undefined) {
        const rawValue = document.createElement("code");
        rawValue.textContent = raw === null ? "raw: null" : `raw: ${raw}`;
        item.append(rawValue);
      }
      return item;
    }),
  );
}
```

Then wire:

- `loadOverview()` fetches `/health` and `/vault` in parallel.
- `renderHealth(data)` sets sync status and health metric rows.
- `renderVault(data)` renders total assets, total supply, share price, cumulative performance fee shares, and cumulative performance fee value.
- `lookupAccount(address)` fetches `/accounts/${encodeURIComponent(address)}` and renders active deposit, lifetime deposited, lifetime withdrawn, lifetime earned, earned performance fee, and valuation metadata.
- Form submit disables the button while loading and restores it afterward.

- [x] **Step 4: Manually smoke check the page**

Run: `npm run dev`

Open: `http://127.0.0.1:8080/dashboard`

Check:

- Health and vault panels load.
- Refresh reloads health and vault.
- A valid address lookup renders account fields.
- An invalid address lookup shows `invalid address`.
- Mobile width keeps input/button and metric rows readable.

### Task 4: Documentation Updates

**Files:**
- Modify: `README.md`
- Modify: `docs/overview.md`
- Modify: `docs/architecture.md`
- Modify: `docs/evolution.md`

**Interfaces:**
- Consumes: completed dashboard behavior.
- Produces: docs that match the running backend.

- [x] **Step 1: Update `README.md`**

Add `/dashboard` to the API section:

```md
- `GET /dashboard`
  - Serves a local browser dashboard for health, vault metrics, and account lookup
```

- [x] **Step 2: Update `docs/overview.md`**

Update `docs/overview.md` first so the source-of-truth product scope says this
is a backend service with a bundled static local dashboard, not a separate
frontend app.

- [x] **Step 3: Update `docs/architecture.md`**

Change the API layer description to mention static dashboard assets and add:

```md
- `GET /dashboard`
  - Serves the local HTML dashboard. The dashboard calls `/health`, `/vault`,
    and `/accounts/:address` from the browser.
```

- [x] **Step 4: Update `docs/evolution.md`**

Append under `2026-07-17`:

```md
- Area: local API dashboard
- Changed: added a static `/dashboard` page served by the existing HTTP API server, with health, vault, and address lookup panels backed by the read-only JSON routes.
- Why: operators need a quick browser view of indexed state without curl commands or a separate frontend stack.
```

### Task 5: Final Verification

**Files:**
- No new files.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified dashboard change.

- [x] **Step 1: Run targeted API tests**

Run: `node --import tsx --test test/api.test.ts`

Expected: PASS.

- [x] **Step 2: Run all tests**

Run: `npm test`

Expected: PASS.

- [x] **Step 3: Run TypeScript build**

Run: `npm run build`

Expected: PASS.

- [x] **Step 4: Review changed files**

Run: `git diff -- src/api/server.ts test/api.test.ts public/dashboard.html public/dashboard.css public/dashboard.js README.md docs/overview.md docs/architecture.md docs/evolution.md docs/superpowers/specs/2026-07-17-api-dashboard-design.md docs/plans/2026-07-17-api-dashboard-plan.md`

Expected: Diff only contains dashboard, tests, and matching documentation.
