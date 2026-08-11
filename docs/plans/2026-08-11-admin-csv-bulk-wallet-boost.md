# Admin CSV Bulk Wallet Boost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `/admin` panel that uploads a strict `wallet,boost` CSV and applies each row via existing `PUT /admin/boost/wallets/:address`.

**Architecture:** Pure client-side feature. Parse and validate the whole file in `public/admin.js`, then sequentially call the existing authenticated single-wallet PUT. No new API, DB, or settle code.

**Tech Stack:** Vanilla `public/admin.html` + `admin.js`, existing admin Bearer PUT path, dashboard CSS.

**Spec:** `docs/superpowers/specs/2026-08-11-admin-csv-bulk-wallet-boost-design.md`

## Global Constraints

- No new backend routes or DB helpers.
- Work on the **current branch** — do not create a new branch.
- CSV header must be exactly `wallet,boost` (two columns, no aliases).
- Validate entire file before any PUT; validation failure → zero PUTs.
- Case-insensitive duplicate wallets → fail whole file.
- After PUTs start: continue on live failures; show per-row results.
- Reuse top-of-page API key via `fetchJsonWithApiKey`.
- Blank data lines fail the file; allow a single trailing empty line from a final newline only.
- Empty file or header-only → fail (nothing to apply).

## File map

| File | Responsibility |
|------|----------------|
| `public/admin.html` | New “Bulk wallet boost CSV” panel markup |
| `public/admin.js` | Parse/validate CSV, sequential PUTs, progress + summary UI |
| `docs/evolution.md` | Short ship note |

Reuse existing `.wallet-boosts-table` styles for the result table (no CSS file change required unless layout looks broken).

---

### Task 1: Admin panel markup

**Files:**
- Modify: `public/admin.html`

**Interfaces:**
- Consumes: existing admin layout (`panel`, `button`, `error-text`, `empty-state`, `lookup-row`)
- Produces: DOM ids for Task 2 — `bulk-boost-file`, `bulk-boost-button`, `bulk-boost-error`, `bulk-boost-result`

- [ ] **Step 1: Insert panel after the single wallet-boost grid section**

Place a full-width `section.panel.account-panel` **after** the closing `</section>` of the `grid grid-two` block (base + single wallet boost), and **before** the “Wallet additional boosts” list panel:

```html
      <section class="panel account-panel">
        <div class="panel-heading account-heading">
          <div>
            <h2>Bulk wallet boost CSV</h2>
            <p class="panel-copy">
              Strict header <code>wallet,boost</code> — sequential PUT /admin/boost/wallets/:address (API key required)
            </p>
          </div>
        </div>
        <div class="lookup-form">
          <label for="bulk-boost-file">CSV file</label>
          <div class="lookup-row">
            <input
              id="bulk-boost-file"
              name="bulkBoostFile"
              type="file"
              accept=".csv,text/csv"
            >
            <button class="button" id="bulk-boost-button" type="button">Apply</button>
          </div>
          <p class="error-text" id="bulk-boost-error" hidden></p>
        </div>
        <div class="empty-state" id="bulk-boost-result">No request yet.</div>
      </section>
```

- [ ] **Step 2: Smoke-check the page loads**

With the indexer/admin static server running (or open via whatever local process serves `/admin`), confirm the new panel appears between the single-wallet form and the wallet-boosts list. No Apply logic yet — button does nothing until Task 2.

- [ ] **Step 3: Commit**

```bash
git add public/admin.html
git commit -m "$(cat <<'EOF'
feat: add bulk wallet boost CSV panel markup

EOF
)"
```

---

### Task 2: Parse, validate, apply loop

**Files:**
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `fetchJsonWithApiKey`, `setBusy` / `clearBusy`, `setError` / `clearError`; DOM from Task 1
- Produces:
  - `parseWalletBoostCsv(text: string): { rows: Array<{ lineNumber: number; wallet: string; boost: string }> }`
    — throws `Error` with operator-facing message on any validation failure
  - `applyBulkWalletBoostCsv(): Promise<void>` — full apply flow

- [ ] **Step 1: Wire element refs**

Add to the `elements` object:

```js
  bulkBoostFile: document.getElementById("bulk-boost-file"),
  bulkBoostButton: document.getElementById("bulk-boost-button"),
  bulkBoostError: document.getElementById("bulk-boost-error"),
  bulkBoostResult: document.getElementById("bulk-boost-result"),
```

- [ ] **Step 2: Add `parseWalletBoostCsv`**

Insert after the busy helpers (before `submitBaseBoost`):

```js
function parseWalletBoostCsv(text) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trim()) {
    throw new Error("CSV is empty.");
  }

  let lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  if (lines.length < 2) {
    throw new Error("CSV must include header wallet,boost and at least one data row.");
  }

  if (lines[0].trim() !== "wallet,boost") {
    throw new Error('CSV header must be exactly "wallet,boost".');
  }

  const rows = [];
  const seen = new Set();

  for (let i = 1; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i];
    if (line.trim() === "") {
      throw new Error(`CSV line ${lineNumber}: blank lines are not allowed.`);
    }

    const parts = line.split(",");
    if (parts.length !== 2) {
      throw new Error(`CSV line ${lineNumber}: expected exactly two columns (wallet,boost).`);
    }

    const wallet = parts[0].trim();
    const boost = parts[1].trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      throw new Error(`CSV line ${lineNumber}: invalid wallet address.`);
    }
    if (!/^\d+$/.test(boost)) {
      throw new Error(`CSV line ${lineNumber}: boost must be a non-negative integer string.`);
    }

    const key = wallet.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`CSV line ${lineNumber}: duplicate wallet ${wallet}.`);
    }
    seen.add(key);

    rows.push({ lineNumber, wallet, boost });
  }

  if (rows.length === 0) {
    throw new Error("CSV must include at least one data row.");
  }

  return { rows };
}
```

- [ ] **Step 3: Add result renderer + apply handler**

```js
function renderBulkBoostResults(results) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const summary = document.createElement("p");
  summary.textContent = `Done: ${ok} succeeded, ${failed} failed (${results.length} total).`;

  const table = document.createElement("table");
  table.className = "wallet-boosts-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Line</th>
        <th>Wallet</th>
        <th>Boost</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const row of results) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td></td>
      <td><code></code></td>
      <td></td>
      <td></td>
    `;
    tr.children[0].textContent = String(row.lineNumber);
    tr.querySelector("code").textContent = row.wallet;
    tr.children[2].textContent = row.boost;
    tr.children[3].textContent = row.ok ? "ok" : row.error;
    tbody.appendChild(tr);
  }

  elements.bulkBoostResult.className = "";
  elements.bulkBoostResult.replaceChildren(summary, table);
}

async function applyBulkWalletBoostCsv() {
  clearError(elements.bulkBoostError);
  const file = elements.bulkBoostFile.files?.[0];
  if (!file) {
    setError(elements.bulkBoostError, "Choose a CSV file first.");
    return;
  }

  setBusy(elements.bulkBoostButton, "Applying");
  try {
    // Fail fast on missing key before reading/parsing would still be ok,
    // but fetchJsonWithApiKey throws the same message — probe key first.
    if (!getApiKey()) {
      throw new Error("Enter an API key first.");
    }

    const text = await file.text();
    const { rows } = parseWalletBoostCsv(text);

    const results = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      elements.bulkBoostButton.textContent = `Applying ${i + 1}/${rows.length}`;
      try {
        await fetchJsonWithApiKey(
          `/admin/boost/wallets/${encodeURIComponent(row.wallet)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ additionalBoostBps: row.boost }),
          },
        );
        results.push({
          lineNumber: row.lineNumber,
          wallet: row.wallet,
          boost: row.boost,
          ok: true,
        });
      } catch (error) {
        results.push({
          lineNumber: row.lineNumber,
          wallet: row.wallet,
          boost: row.boost,
          ok: false,
          error: error.message,
        });
      }
    }

    renderBulkBoostResults(results);
  } catch (error) {
    setError(elements.bulkBoostError, error.message);
  } finally {
    clearBusy(elements.bulkBoostButton);
  }
}
```

- [ ] **Step 4: Bind the Apply button**

```js
elements.bulkBoostButton.addEventListener("click", () => {
  void applyBulkWalletBoostCsv();
});
```

- [ ] **Step 5: Manual verification**

With `ADMIN_API_TOKEN` set and indexer running:

1. **Valid CSV** — apply 2–3 wallets; summary shows all `ok`; Load wallet-boosts list to confirm values.
2. **Bad header** (`address,bps`) — error, no PUTs (boost-changes / list unchanged for those wallets).
3. **Duplicate wallet** (same address twice, different case) — error before any PUT.
4. **Blank line in middle** — error before any PUT.
5. **Live failure continue** — use wrong API key after a successful parse is awkward; instead temporarily stop the server mid-run or use an invalid-but-format-ok address that fails server `getAddress`… actually client regex requires 40 hex. Easier: run with wrong key — first row fails 401, rest also fail 401, summary shows all failed with error text (proves continue). Then re-run with correct key.

- [ ] **Step 6: Commit**

```bash
git add public/admin.js
git commit -m "$(cat <<'EOF'
feat: apply wallet boosts from strict CSV on admin page

EOF
)"
```

---

### Task 3: Evolution note

**Files:**
- Modify: `docs/evolution.md`

**Interfaces:**
- Consumes: shipped Task 1–2 behavior
- Produces: dated evolution entry under `## 2026-08-11`

- [ ] **Step 1: Prepend under `## 2026-08-11`**

```markdown
- Area: admin bulk wallet boost CSV
- Changed: added an `/admin` panel that validates a strict `wallet,boost` CSV
  then sequentially PUTs each row via the existing wallet boost endpoint,
  continuing on live failures with a per-row summary.
- Why: operators need to apply many additional boosts without a new bulk API
  or hand-entering each wallet.
```

- [ ] **Step 2: Commit**

```bash
git add docs/evolution.md
git commit -m "$(cat <<'EOF'
docs: note admin CSV bulk wallet boost

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Client loop over existing PUT | Task 2 |
| Strict `wallet,boost` header | Task 2 `parseWalletBoostCsv` |
| Full-file validate before PUT | Task 2 |
| Duplicate wallets fail file | Task 2 |
| Continue on live fail + per-row summary | Task 2 |
| API key required | Task 2 |
| Panel near single wallet form | Task 1 |
| Progress `Applying i/n` | Task 2 |
| evolution note | Task 3 |
| No new backend | Global / file map |
| No new branch | Global Constraints |

## Self-review notes

- No placeholders left.
- Blank-line rule matches spec: fail blank data lines; strip only a single trailing empty split from final newline.
- Result table reuses `.wallet-boosts-table` — no CSS task unless manual check shows breakage.
