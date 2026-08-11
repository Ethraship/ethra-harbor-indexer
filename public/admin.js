const elements = {
  apiKeyInput: document.getElementById("api-key-input"),
  baseBoostForm: document.getElementById("base-boost-form"),
  baseBoostInput: document.getElementById("base-boost-input"),
  baseBoostButton: document.getElementById("base-boost-button"),
  baseBoostError: document.getElementById("base-boost-error"),
  baseBoostResult: document.getElementById("base-boost-result"),
  walletBoostForm: document.getElementById("wallet-boost-form"),
  walletAddressInput: document.getElementById("wallet-address-input"),
  walletBoostInput: document.getElementById("wallet-boost-input"),
  walletBoostButton: document.getElementById("wallet-boost-button"),
  walletBoostError: document.getElementById("wallet-boost-error"),
  walletBoostResult: document.getElementById("wallet-boost-result"),
  loadWalletBoostsButton: document.getElementById("load-wallet-boosts-button"),
  walletBoostsError: document.getElementById("wallet-boosts-error"),
  walletBoostsResult: document.getElementById("wallet-boosts-result"),
  loadChangesButton: document.getElementById("load-changes-button"),
  changesError: document.getElementById("changes-error"),
  changesResult: document.getElementById("changes-result"),
  settlementsForm: document.getElementById("settlements-form"),
  settlementsAddressInput: document.getElementById("settlements-address-input"),
  settlementsButton: document.getElementById("settlements-button"),
  settlementsError: document.getElementById("settlements-error"),
  settlementsResult: document.getElementById("settlements-result"),
};

function setError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function getApiKey() {
  return elements.apiKeyInput.value.trim();
}

async function fetchJson(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers ?? {}),
  };
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  return body;
}

async function fetchJsonWithApiKey(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Enter an API key first.");
  }

  return fetchJson(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

function setBusy(button, busyText) {
  button.disabled = true;
  button.dataset.idleText = button.dataset.idleText || button.textContent;
  button.textContent = busyText;
}

function clearBusy(button) {
  button.disabled = false;
  button.textContent = button.dataset.idleText || button.textContent;
}

async function submitBaseBoost() {
  clearError(elements.baseBoostError);
  setBusy(elements.baseBoostButton, "Saving");

  try {
    const body = await fetchJsonWithApiKey("/admin/boost/base", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseBoostBps: elements.baseBoostInput.value.trim(),
      }),
    });
    elements.baseBoostResult.textContent = formatJson(body);
  } catch (error) {
    setError(elements.baseBoostError, error.message);
  } finally {
    clearBusy(elements.baseBoostButton);
  }
}

async function submitWalletBoost() {
  clearError(elements.walletBoostError);
  setBusy(elements.walletBoostButton, "Saving");

  try {
    const address = elements.walletAddressInput.value.trim();
    if (!address) {
      throw new Error("Enter a wallet address.");
    }

    const body = await fetchJsonWithApiKey(
      `/admin/boost/wallets/${encodeURIComponent(address)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          additionalBoostBps: elements.walletBoostInput.value.trim(),
        }),
      },
    );
    elements.walletBoostResult.textContent = formatJson(body);
  } catch (error) {
    setError(elements.walletBoostError, error.message);
  } finally {
    clearBusy(elements.walletBoostButton);
  }
}

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
      void removeWalletBoost(row.address, tr.querySelector("button"));
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

async function removeWalletBoost(address, button) {
  clearError(elements.walletBoostsError);
  setBusy(button, "Removing");
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
  } finally {
    if (document.body.contains(button)) {
      clearBusy(button);
    }
  }
}

async function loadBoostChanges() {
  clearError(elements.changesError);
  setBusy(elements.loadChangesButton, "Loading");

  try {
    const body = await fetchJson("/admin/boost/changes");
    elements.changesResult.textContent = formatJson(body);
  } catch (error) {
    setError(elements.changesError, error.message);
  } finally {
    clearBusy(elements.loadChangesButton);
  }
}

async function loadSettlements() {
  clearError(elements.settlementsError);
  setBusy(elements.settlementsButton, "Loading");

  try {
    const address = elements.settlementsAddressInput.value.trim();
    if (!address) {
      throw new Error("Enter a wallet address.");
    }

    const body = await fetchJson(
      `/admin/vship/settlements/${encodeURIComponent(address)}`,
    );
    elements.settlementsResult.textContent = formatJson(body);
  } catch (error) {
    setError(elements.settlementsError, error.message);
  } finally {
    clearBusy(elements.settlementsButton);
  }
}

elements.baseBoostForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitBaseBoost();
});

elements.walletBoostForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitWalletBoost();
});

elements.loadWalletBoostsButton.addEventListener("click", () => {
  void loadWalletBoosts();
});

elements.loadChangesButton.addEventListener("click", () => {
  void loadBoostChanges();
});

elements.settlementsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadSettlements();
});
