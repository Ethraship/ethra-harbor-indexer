const USDC_DECIMALS = 6;
const DEFAULT_WINDOW_DAYS = 7;

const elements = {
  refresh: document.getElementById("refresh"),
  updatedAt: document.getElementById("updated-at"),
  pageError: document.getElementById("page-error"),
  totalAssets: document.getElementById("total-assets"),
  totalEarned: document.getElementById("total-earned"),
  totalWallets: document.getElementById("total-wallets"),
  assetsWindow: document.getElementById("assets-window"),
  volumeWindow: document.getElementById("volume-window"),
  assetsChart: document.getElementById("assets-chart"),
  volumeChart: document.getElementById("volume-chart"),
  topWallets: document.getElementById("top-wallets"),
  rangeButtons: [...document.querySelectorAll("[data-window-days]")],
};

let selectedWindowDays = DEFAULT_WINDOW_DAYS;
let assetsChart = null;
let volumeChart = null;

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

function formatUsd(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return "—";
  }

  const raw = String(rawValue);
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(USDC_DECIMALS + 1, "0");
  const whole = groupDigits(padded.slice(0, -USDC_DECIMALS) || "0");
  const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, "");
  const amount = fraction ? `${whole}.${fraction.slice(0, 2)}` : whole;

  return `${negative ? "-" : ""}$${amount}`;
}

function formatAxisUsd(value) {
  if (!Number.isFinite(value) || value === 0) {
    return "$0";
  }

  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absolute >= 1_000) {
    return `$${(value / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}k`;
  }

  return `$${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 2)}`;
}

function formatCount(value) {
  return groupDigits(String(value ?? 0));
}

function formatShortDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function toNumber(rawValue) {
  const raw = String(rawValue ?? "0");
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, -USDC_DECIMALS);
  const fraction = padded.slice(-USDC_DECIMALS);
  const value = Number(`${whole}.${fraction}`);
  return negative ? -value : value;
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index",
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        labels: {
          boxWidth: 10,
          boxHeight: 10,
          color: "#6b7380",
          font: {
            family: "Manrope, sans-serif",
            weight: "600",
            size: 11,
          },
        },
      },
      tooltip: {
        backgroundColor: "#1c2430",
        titleFont: { family: "Manrope, sans-serif", weight: "700", size: 12 },
        bodyFont: { family: "Manrope, sans-serif", weight: "600", size: 12 },
        padding: 10,
        callbacks: {
          label(context) {
            const value = context.parsed.y;
            return `${context.dataset.label}: ${formatAxisUsd(value)}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: "#6b7380",
          font: { family: "Manrope, sans-serif", weight: "600", size: 11 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 6,
        },
      },
      y: {
        beginAtZero: true,
        grid: { color: "#edf0f4" },
        ticks: {
          color: "#6b7380",
          font: { family: "Manrope, sans-serif", weight: "600", size: 11 },
          callback(value) {
            return formatAxisUsd(Number(value));
          },
        },
      },
    },
  };
}

function renderAssetsChart(points) {
  const labels = points.map((point) => formatShortDay(point.day));
  const values = points.map((point) => toNumber(point.totalAssetsRaw));

  if (assetsChart) {
    assetsChart.destroy();
  }

  assetsChart = new Chart(elements.assetsChart, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Total assets",
          data: values,
          borderColor: "#6f74c2",
          backgroundColor: "rgba(139, 143, 212, 0.22)",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2.5,
        },
      ],
    },
    options: {
      ...chartDefaults(),
      plugins: {
        ...chartDefaults().plugins,
        legend: { display: false },
      },
    },
  });
}

function renderVolumeChart(points) {
  const labels = points.map((point) => formatShortDay(point.day));
  const deposits = points.map((point) => toNumber(point.depositedRaw));
  const withdraws = points.map((point) => toNumber(point.withdrawnRaw));

  if (volumeChart) {
    volumeChart.destroy();
  }

  volumeChart = new Chart(elements.volumeChart, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Deposits",
          data: deposits,
          backgroundColor: "#8b8fd4",
          borderRadius: 4,
          maxBarThickness: 18,
        },
        {
          label: "Withdrawals",
          data: withdraws,
          backgroundColor: "#c4b5a5",
          borderRadius: 4,
          maxBarThickness: 18,
        },
      ],
    },
    options: chartDefaults(),
  });
}

function renderTopWallets(wallets) {
  if (!wallets.length) {
    elements.topWallets.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-row";
    empty.textContent = "No active wallet positions yet.";
    elements.topWallets.append(empty);
    return;
  }

  elements.topWallets.replaceChildren(
    ...wallets.map((wallet, index) => {
      const row = document.createElement("div");
      row.className = "wallet-row";
      row.style.animationDelay = `${Math.min(index, 12) * 30}ms`;

      const rank = document.createElement("div");
      rank.className = "wallet-rank";
      rank.textContent = String(index + 1);

      const address = document.createElement("div");
      address.className = "wallet-address";
      address.textContent = wallet.address;

      const value = document.createElement("div");
      value.className = "wallet-value";
      value.textContent = formatUsd(wallet.netValueRaw);

      row.append(rank, address, value);
      return row;
    }),
  );
}

function setError(message) {
  elements.pageError.textContent = message;
  elements.pageError.hidden = false;
}

function clearError() {
  elements.pageError.textContent = "";
  elements.pageError.hidden = true;
}

function syncRangeButtons() {
  for (const button of elements.rangeButtons) {
    const days = Number(button.getAttribute("data-window-days"));
    button.classList.toggle("is-active", days === selectedWindowDays);
  }
}

async function loadOverview() {
  elements.refresh.disabled = true;
  clearError();
  syncRangeButtons();

  try {
    const data = await fetchJson(`/overview/stats?windowDays=${selectedWindowDays}`);
    const windowLabel = `Last ${data.windowDays ?? selectedWindowDays} days`;

    elements.totalAssets.textContent = formatUsd(data.totals.totalAssetsRaw);
    elements.totalEarned.textContent = formatUsd(data.totals.totalEarnedRaw);
    elements.totalWallets.textContent = formatCount(data.totals.totalWallets);
    elements.assetsWindow.textContent = windowLabel;
    elements.volumeWindow.textContent = windowLabel;

    renderAssetsChart(data.assetsOverTime ?? []);
    renderVolumeChart(data.volumeOverTime ?? []);
    renderTopWallets(data.topWallets ?? []);

    elements.updatedAt.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
      timeStyle: "medium",
    }).format(new Date())}`;
  } catch (error) {
    setError(error.message);
    elements.updatedAt.textContent = "Update failed";
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", () => {
  void loadOverview();
});

for (const button of elements.rangeButtons) {
  button.addEventListener("click", () => {
    selectedWindowDays = Number(button.getAttribute("data-window-days"));
    void loadOverview();
  });
}

void loadOverview();
