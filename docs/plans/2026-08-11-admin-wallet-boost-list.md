# Admin Wallet Boost List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public on-demand admin list of wallets with non-zero additional boost, plus a Remove quick action that PUTs `"0"` with the page API key.

**Architecture:** Extend `rewards.ts` with `listWalletBoosts`, expose `GET /admin/boost/wallets` as a public admin read (same gate as `GET /admin/boost/changes`), and add an admin panel that loads the list on demand and clears boosts via the existing authenticated wallet PUT.

**Tech Stack:** TypeScript, better-sqlite3, Node `http` admin API, vanilla `public/admin.html` + `admin.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-11-admin-wallet-boost-list-design.md`

## Global Constraints

- List GET is public (no API key); Remove requires Bearer API key.
- Remove reuses `PUT /admin/boost/wallets/:address` with `{ "additionalBoostBps": "0" }` — no DELETE route.
- List only rows with `additional_boost_bps > 0`; sort by address ascending; bps as decimal strings.
- Do not delete zeroed `wallet_boost` rows.
- Prefer TDD; run focused tests before claiming done; update architecture + evolution with the feature.

## File map

| File | Responsibility |
|------|----------------|
| `src/db/rewards.ts` | `listWalletBoosts(db)` query helper |
| `src/api/admin.ts` | Handle `GET /admin/boost/wallets` |
| `src/api/server.ts` | Allowlist path as public admin GET |
| `public/admin.html` | Panel markup |
| `public/admin.js` | Load + Remove handlers |
| `public/dashboard.css` | Minimal table styles for the panel |
| `test/rewardsDb.test.ts` | Unit coverage for list helper |
| `test/api.test.ts` | HTTP coverage for list + public access |
| `docs/architecture.md` | Document new GET |
| `docs/evolution.md` | Short change entry |

---

### Task 1: `listWalletBoosts` DB helper

**Files:**
- Modify: `src/db/rewards.ts`
- Test: `test/rewardsDb.test.ts`

**Interfaces:**
- Consumes: existing `wallet_boost` table; `upsertWalletAdditionalBoostBps`
- Produces: `listWalletBoosts(db: Database): Array<{ address: string; additionalBoostBps: bigint }>`

- [ ] **Step 1: Write the failing test**

Append to `test/rewardsDb.test.ts`:

```ts
import { listWalletBoosts } from "../src/db/rewards";

test("listWalletBoosts returns only positive boosts sorted by address", () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const low = "0x1111111111111111111111111111111111111111";
    const high = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const zeroed = "0x2222222222222222222222222222222222222222";
    upsertWalletAdditionalBoostBps(db, high, 50000n, 1);
    upsertWalletAdditionalBoostBps(db, low, 100000n, 1);
    upsertWalletAdditionalBoostBps(db, zeroed, 0n, 1);

    assert.deepEqual(listWalletBoosts(db), [
      { address: "0x1111111111111111111111111111111111111111", additionalBoostBps: 100000n },
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", additionalBoostBps: 50000n },
    ]);
  } finally {
    closeDatabase(db);
  }
});
```

Note: `upsertWalletAdditionalBoostBps` normalizes via `getAddress`. Assert against the **checksummed** addresses returned by a one-off `getAddress(...)` import from `ethers` if the lowercase expectation above fails — match whatever `normalizeAddress` stores.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/rewardsDb.test.ts`

Expected: FAIL — `listWalletBoosts` is not exported / not a function.

- [ ] **Step 3: Implement `listWalletBoosts`**

In `src/db/rewards.ts`, next to `listWalletBoostAddresses`:

```ts
export function listWalletBoosts(
  db: Database.Database,
): Array<{ address: string; additionalBoostBps: bigint }> {
  const rows = db.prepare(`
    SELECT address, additional_boost_bps
    FROM wallet_boost
    WHERE CAST(additional_boost_bps AS INTEGER) > 0
    ORDER BY address ASC
  `).all() as Array<{ address: string; additional_boost_bps: string }>;

  return rows.map((row) => ({
    address: row.address,
    additionalBoostBps: BigInt(row.additional_boost_bps),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/rewardsDb.test.ts`

Expected: PASS (fix asserted address checksums if needed).

- [ ] **Step 5: Commit** (only if the user asked for commits)

```bash
git add src/db/rewards.ts test/rewardsDb.test.ts
git commit -m "$(cat <<'EOF'
feat: list non-zero wallet additional boosts

EOF
)"
```

---

### Task 2: Public `GET /admin/boost/wallets`

**Files:**
- Modify: `src/api/admin.ts`
- Modify: `src/api/server.ts` (public-read allowlist)
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `listWalletBoosts(db)` from Task 1
- Produces: HTTP `200` JSON `[{ address, additionalBoostBps: string }, ...]`

- [ ] **Step 1: Write the failing API tests**

Add near other admin tests in `test/api.test.ts` (reuse `createConfig`, `openDatabase`, `createApiServer`, `startServer`, `closeApiTestServer`, `upsertWalletAdditionalBoostBps`):

```ts
test("GET /admin/boost/wallets lists positive boosts without auth", async (t) => {
  const db = openDatabase(":memory:");
  const config = createConfig({ ADMIN_API_TOKEN: "secret" });
  runMigrations(db);
  const low = "0x1111111111111111111111111111111111111111";
  const high = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  upsertWalletAdditionalBoostBps(db, high, 50000n, 1);
  upsertWalletAdditionalBoostBps(db, low, 100000n, 1);
  upsertWalletAdditionalBoostBps(db, "0x2222222222222222222222222222222222222222", 0n, 1);

  const server = createApiServer({ db, config, health: null });
  t.after(() => closeApiTestServer(server, db));
  const baseUrl = await startServer(server);

  const response = await fetch(`${baseUrl}/admin/boost/wallets`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, [
    { address: /* checksummed low */, additionalBoostBps: "100000" },
    { address: /* checksummed high */, additionalBoostBps: "50000" },
  ]);
});
```

Use `getAddress` from `ethers` in the test for expected addresses. Import `runMigrations` if not already imported in this file — if migrations run via `openDatabase` helpers used elsewhere for admin, follow the same seed pattern as nearby tests (`seedReadyAdminDatabase` is heavier than needed; direct `runMigrations` + upserts is fine if `openDatabase` alone does not migrate — check how other tests open DBs).

Also assert public access when token is configured but no `Authorization` header (covered above). Optionally add:

```ts
test("GET /admin/boost/wallets returns empty array when none", async (t) => {
  // migrate empty wallet_boost; GET → []
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/api.test.ts --test-name-pattern="GET /admin/boost/wallets"`

Expected: FAIL with `401` or `404` (path not public / not handled).

- [ ] **Step 3: Allowlist the path in `server.ts`**

In `src/api/server.ts`, extend `isPublicAdminRead`:

```ts
const isPublicAdminRead =
  request.method === "GET" &&
  (url.pathname === "/admin/boost/changes" ||
    url.pathname === "/admin/boost/wallets" ||
    /^\/admin\/vship\/settlements\/[^/]+$/.test(url.pathname));
```

- [ ] **Step 4: Handle the route in `admin.ts`**

Import `listWalletBoosts` and add before the final `return false`:

```ts
if (request.method === "GET" && pathname === "/admin/boost/wallets") {
  writeJson(
    response,
    200,
    listWalletBoosts(db).map((row) => ({
      address: row.address,
      additionalBoostBps: row.additionalBoostBps.toString(),
    })),
  );
  return true;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test test/api.test.ts --test-name-pattern="GET /admin/boost/wallets"`

Expected: PASS.

- [ ] **Step 6: Commit** (only if the user asked for commits)

```bash
git add src/api/admin.ts src/api/server.ts test/api.test.ts
git commit -m "$(cat <<'EOF'
feat: expose public GET /admin/boost/wallets

EOF
)"
```

---

### Task 3: Admin UI panel (Load + Remove)

**Files:**
- Modify: `public/admin.html`
- Modify: `public/admin.js`
- Modify: `public/dashboard.css`

**Interfaces:**
- Consumes: `GET /admin/boost/wallets` (no key); `PUT /admin/boost/wallets/:address` via `fetchJsonWithApiKey`
- Produces: on-demand table with Remove that reloads the list on success

- [ ] **Step 1: Add panel markup in `admin.html`**

Insert a new section **above** the “Boost changes” panel (so operators see active boosts before history):

```html
<section class="panel account-panel">
  <div class="panel-heading account-heading">
    <div>
      <h2>Wallet additional boosts</h2>
      <p class="panel-copy">GET /admin/boost/wallets — no API key; Remove uses key</p>
    </div>
    <button class="button button-secondary" id="load-wallet-boosts-button" type="button">
      Load
    </button>
  </div>
  <p class="error-text" id="wallet-boosts-error" hidden></p>
  <div class="empty-state" id="wallet-boosts-result">No request yet.</div>
</section>
```

- [ ] **Step 2: Add minimal table CSS in `dashboard.css`**

```css
.wallet-boosts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.wallet-boosts-table th,
.wallet-boosts-table td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.wallet-boosts-table th {
  color: var(--muted);
  font-size: 0.8rem;
}

.wallet-boosts-table code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 3: Wire load + remove in `admin.js`**

Extend `elements`:

```js
loadWalletBoostsButton: document.getElementById("load-wallet-boosts-button"),
walletBoostsError: document.getElementById("wallet-boosts-error"),
walletBoostsResult: document.getElementById("wallet-boosts-result"),
```

Add helpers and handlers:

```js
function renderWalletBoosts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    elements.walletBoostsResult.textContent = "No wallets with additional boost.";
    elements.walletBoostsResult.className = "empty-state";
    return;
  }

  const table = document.createElement("table");
  table.className = "wallet-boosts-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Address</th>
        <th>Additional boost bps</th>
        <th></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.dataset.address = row.address;
    tr.innerHTML = `
      <td><code></code></td>
      <td></td>
      <td><button class="button button-secondary" type="button">Remove</button></td>
    `;
    tr.querySelector("code").textContent = row.address;
    tr.children[1].textContent = row.additionalBoostBps;
    tr.querySelector("button").addEventListener("click", () => {
      void removeWalletBoost(row.address);
    });
    tbody.appendChild(tr);
  }

  elements.walletBoostsResult.className = "";
  elements.walletBoostsResult.replaceChildren(table);
}

async function loadWalletBoosts() {
  clearError(elements.walletBoostsError);
  setBusy(elements.loadWalletBoostsButton, "Loading");
  try {
    const body = await fetchJson("/admin/boost/wallets");
    renderWalletBoosts(body);
  } catch (error) {
    setError(elements.walletBoostsError, error.message);
  } finally {
    clearBusy(elements.loadWalletBoostsButton);
  }
}

async function removeWalletBoost(address) {
  clearError(elements.walletBoostsError);
  try {
    await fetchJsonWithApiKey(
      `/admin/boost/wallets/${encodeURIComponent(address)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additionalBoostBps: "0" }),
      },
    );
    await loadWalletBoosts();
  } catch (error) {
    setError(elements.walletBoostsError, error.message);
  }
}

elements.loadWalletBoostsButton.addEventListener("click", () => {
  void loadWalletBoosts();
});
```

- [ ] **Step 4: Manual smoke check**

With the API running and `ADMIN_API_TOKEN` set:

1. Open `/admin`, click **Load** — table appears without entering a key.
2. Enter API key, click **Remove** on a row — list reloads without that wallet.
3. Clear the API key, click **Remove** — see “Enter an API key first.”

- [ ] **Step 5: Commit** (only if the user asked for commits)

```bash
git add public/admin.html public/admin.js public/dashboard.css
git commit -m "$(cat <<'EOF'
feat: admin panel for wallet additional boosts

EOF
)"
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/evolution.md`
- Modify: `docs/overview.md` only if it lists admin endpoints (keep in sync if so)

- [ ] **Step 1: Update architecture**

In the admin API bullet list, add:

- `GET /admin/boost/wallets` — public list of wallets with non-zero `additionalBoostBps` (decimal strings), sorted by address

Note that Remove continues to use authenticated `PUT .../wallets/:address` with `"0"`.

Update the public-read sentence in architecture if it enumerates paths (include `/admin/boost/wallets` next to changes/settlements).

- [ ] **Step 2: Append evolution entry**

```md
- Date: 2026-08-11
- Area: admin wallet boost list
- Changed: added public `GET /admin/boost/wallets` and an on-demand admin panel with Remove (PUT additional boost to 0).
- Why: operators need a quick view of active additional boosts and a one-click clear without hunting addresses.
```

- [ ] **Step 3: Run full verification**

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Commit** (only if the user asked for commits)

```bash
git add docs/architecture.md docs/evolution.md docs/overview.md
git commit -m "$(cat <<'EOF'
docs: document admin wallet boost list

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Public `GET /admin/boost/wallets` | 2 |
| `{ address, additionalBoostBps }` strings | 2 |
| Filter `> 0`, sort address ASC | 1–2 |
| Remove via PUT `"0"` + API key | 3 |
| Load on demand panel + table | 3 |
| Reload list after Remove | 3 |
| API tests for list filter | 1–2 |
| architecture + evolution | 4 |
| No DELETE / no row delete on zero | 1–3 (by design) |

## Plan self-review

- No TBD/placeholder steps.
- `listWalletBoosts` signature consistent across Tasks 1–2.
- Public allowlist in `server.ts` required so GET does not demand Bearer auth.
- Commits are optional pending explicit user request (repo rule).
