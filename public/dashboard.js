const USDC_DECIMALS = 6;
const SHARE_DECIMALS = 18;

const elements = {
  refreshOverview: document.getElementById("refresh-overview"),
  healthDot: document.getElementById("health-dot"),
  healthSummary: document.getElementById("health-summary"),
  lastRefresh: document.getElementById("last-refresh"),
  healthPill: document.getElementById("health-pill"),
  healthMetrics: document.getElementById("health-metrics"),
  healthError: document.getElementById("health-error"),
  vaultPill: document.getElementById("vault-pill"),
  vaultMetrics: document.getElementById("vault-metrics"),
  vaultError: document.getElementById("vault-error"),
  accountPill: document.getElementById("account-pill"),
  lookupForm: document.getElementById("lookup-form"),
  addressInput: document.getElementById("address-input"),
  lookupButton: document.getElementById("lookup-button"),
  accountError: document.getElementById("account-error"),
  accountEmpty: document.getElementById("account-empty"),
  accountResults: document.getElementById("account-results"),
};

async function fetchJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  return body;
}

function groupDigits(value) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatRawDecimal(value, decimals, suffix) {
  if (value === null || value === undefined) {
    return "Not captured yet";
  }

  const raw = String(value);
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = groupDigits(padded.slice(0, -decimals));
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  const formatted = fraction ? `${whole}.${fraction}` : whole;

  return `${negative ? "-" : ""}${formatted} ${suffix}`;
}

function formatInteger(value) {
  if (value === null || value === undefined) {
    return "Unknown";
  }

  return groupDigits(String(value));
}

function formatTimestamp(value) {
  if (value === null || value === undefined) {
    return "Not captured yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function rawText(value) {
  return value === null || value === undefined ? "raw: null" : `raw: ${value}`;
}

function setError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

function setPill(element, text, className = "") {
  element.className = `pill${className ? ` ${className}` : ""}`;
  element.textContent = text;
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
        rawValue.textContent = rawText(raw);
        item.append(rawValue);
      }

      return item;
    }),
  );
}

function renderHealth(data) {
  const synced = data.syncedToSafeHead === true;
  const safeHeadKnown = data.safeHeadKnown === true;

  elements.healthDot.classList.toggle("synced", synced);
  elements.healthDot.classList.remove("error");
  elements.healthSummary.textContent = synced
    ? "Indexer is synced to the safe head"
    : safeHeadKnown
      ? "Indexer is catching up"
      : "Waiting for crawler safe head";

  if (synced) {
    setPill(elements.healthPill, "Synced");
  } else if (safeHeadKnown) {
    setPill(elements.healthPill, "Catching up", "pill-warning");
  } else {
    setPill(elements.healthPill, "Safe head unknown", "pill-warning");
  }

  renderMetricList(elements.healthMetrics, [
    { label: "Status", value: data.status ?? "Unknown" },
    { label: "Cursor block", value: formatInteger(data.cursorBlock), raw: data.cursorBlock },
    { label: "Safe head", value: formatInteger(data.safeHead), raw: data.safeHead },
    { label: "Safe head known", value: data.safeHeadKnown ? "Yes" : "No" },
    { label: "Synced to safe head", value: data.syncedToSafeHead ? "Yes" : "No" },
  ]);
}

function renderVault(data) {
  const hasSnapshot = data.totalAssetsRaw !== null && data.sharePriceScaledRaw !== null;
  setPill(elements.vaultPill, hasSnapshot ? "Valued" : "No snapshot", hasSnapshot ? "" : "pill-warning");

  renderMetricList(elements.vaultMetrics, [
    {
      label: "Total assets",
      value: formatRawDecimal(data.totalAssetsRaw, USDC_DECIMALS, "USDC"),
      raw: data.totalAssetsRaw,
    },
    {
      label: "Total supply",
      value: formatRawDecimal(data.totalSupplyRaw, SHARE_DECIMALS, "shares"),
      raw: data.totalSupplyRaw,
    },
    {
      label: "Share price",
      value: formatRawDecimal(data.sharePriceScaledRaw, USDC_DECIMALS, "USDC/share"),
      raw: data.sharePriceScaledRaw,
    },
    {
      label: "Performance fee shares",
      value: formatRawDecimal(
        data.cumulativePerformanceFeeSharesRaw,
        SHARE_DECIMALS,
        "shares",
      ),
      raw: data.cumulativePerformanceFeeSharesRaw,
    },
    {
      label: "Performance fee value",
      value: formatRawDecimal(data.cumulativePerformanceFeeValueRaw, USDC_DECIMALS, "USDC"),
      raw: data.cumulativePerformanceFeeValueRaw,
    },
    { label: "Valuation block", value: formatInteger(data.valuationBlock), raw: data.valuationBlock },
    { label: "Valuation time", value: formatTimestamp(data.valuationTime), raw: data.valuationTime },
  ]);
}

function makeMetricSection(title, metrics) {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  const list = document.createElement("div");

  heading.textContent = title;
  list.className = "metric-list";
  renderMetricList(list, metrics);

  section.append(heading, list);
  return section;
}

function renderAccount(data) {
  elements.accountEmpty.hidden = true;
  elements.accountResults.hidden = false;
  setPill(elements.accountPill, "Loaded");

  elements.accountResults.replaceChildren(
    makeMetricSection("Position", [
      { label: "Address", value: data.address },
      {
        label: "Active shares",
        value: formatRawDecimal(data.activeDeposit.shares, SHARE_DECIMALS, "shares"),
        raw: data.activeDeposit.shares,
      },
      {
        label: "Active value",
        value: formatRawDecimal(data.activeDeposit.valueRaw, USDC_DECIMALS, "USDC"),
        raw: data.activeDeposit.valueRaw,
      },
      { label: "Valuation block", value: formatInteger(data.valuationBlock), raw: data.valuationBlock },
      { label: "Valuation time", value: formatTimestamp(data.valuationTime), raw: data.valuationTime },
    ]),
    makeMetricSection("Lifetime", [
      {
        label: "Deposited",
        value: formatRawDecimal(data.lifetimeDeposited.raw, USDC_DECIMALS, "USDC"),
        raw: data.lifetimeDeposited.raw,
      },
      {
        label: "Withdrawn",
        value: formatRawDecimal(data.lifetimeWithdrawn.raw, USDC_DECIMALS, "USDC"),
        raw: data.lifetimeWithdrawn.raw,
      },
      {
        label: "Earned",
        value: formatRawDecimal(data.lifetimeEarned.raw, USDC_DECIMALS, "USDC"),
        raw: data.lifetimeEarned.raw,
      },
      {
        label: "Fee shares",
        value: formatRawDecimal(data.earnedPerformanceFee.shares, SHARE_DECIMALS, "shares"),
        raw: data.earnedPerformanceFee.shares,
      },
      {
        label: "Fee value",
        value: formatRawDecimal(data.earnedPerformanceFee.valueRaw, USDC_DECIMALS, "USDC"),
        raw: data.earnedPerformanceFee.valueRaw,
      },
    ]),
  );
}

async function loadOverview() {
  elements.refreshOverview.disabled = true;
  clearError(elements.healthError);
  clearError(elements.vaultError);
  setPill(elements.healthPill, "Loading", "pill-muted");
  setPill(elements.vaultPill, "Loading", "pill-muted");

  const [healthResult, vaultResult] = await Promise.allSettled([
    fetchJson("/health"),
    fetchJson("/vault"),
  ]);

  if (healthResult.status === "fulfilled") {
    renderHealth(healthResult.value);
  } else {
    elements.healthDot.classList.add("error");
    elements.healthSummary.textContent = "Health request failed";
    setPill(elements.healthPill, "Error", "pill-error");
    setError(elements.healthError, healthResult.reason.message);
  }

  if (vaultResult.status === "fulfilled") {
    renderVault(vaultResult.value);
  } else {
    setPill(elements.vaultPill, "Error", "pill-error");
    setError(elements.vaultError, vaultResult.reason.message);
  }

  elements.lastRefresh.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
    timeStyle: "medium",
  }).format(new Date())}`;
  elements.refreshOverview.disabled = false;
}

async function lookupAccount(address) {
  elements.lookupButton.disabled = true;
  elements.lookupButton.textContent = "Loading";
  setPill(elements.accountPill, "Loading", "pill-muted");
  clearError(elements.accountError);

  try {
    const account = await fetchJson(`/accounts/${encodeURIComponent(address)}`);
    renderAccount(account);
  } catch (error) {
    elements.accountResults.hidden = true;
    elements.accountEmpty.hidden = false;
    setPill(elements.accountPill, "Error", "pill-error");
    setError(elements.accountError, error.message);
  } finally {
    elements.lookupButton.disabled = false;
    elements.lookupButton.textContent = "Get Details";
  }
}

elements.refreshOverview.addEventListener("click", () => {
  void loadOverview();
});

elements.lookupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const address = elements.addressInput.value.trim();

  if (!address) {
    setPill(elements.accountPill, "Idle", "pill-muted");
    setError(elements.accountError, "Enter a wallet address.");
    return;
  }

  void lookupAccount(address);
});

void loadOverview();
