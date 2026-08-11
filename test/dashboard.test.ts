import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  className = "";
  disabled = false;
  hidden = false;
  textContent = "";
  value = "";

  readonly classList = {
    add: (..._classes: string[]) => {},
    remove: (..._classes: string[]) => {},
    toggle: (_className: string, _force?: boolean) => false,
  };

  constructor(tagName = "div") {
    this.tagName = tagName;
  }

  addEventListener(_eventName: string, _listener: unknown) {}

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  getElementById(id: string) {
    const existing = this.elements.get(id);
    if (existing) {
      return existing;
    }

    const element = new FakeElement(id);
    this.elements.set(id, element);
    return element;
  }
}

function walk(element: FakeElement, visit: (element: FakeElement) => void) {
  visit(element);
  for (const child of element.children) {
    walk(child, visit);
  }
}

function findMetric(root: FakeElement, label: string) {
  let metric: FakeElement | null = null;

  walk(root, (element) => {
    if (element.className === "metric" && element.children[0]?.textContent === label) {
      metric = element;
    }
  });

  assert.ok(metric, `missing metric: ${label}`);
  return metric;
}

function metricValue(root: FakeElement, label: string) {
  return findMetric(root, label).children[1]?.textContent;
}

function metricRaw(root: FakeElement, label: string) {
  return findMetric(root, label).children[2]?.textContent;
}

test("dashboard renders estimated account earnings and explicit null freshness", () => {
  const document = new FakeDocument();
  const script = readFileSync(join(process.cwd(), "public/dashboard.js"), "utf8");
  const context = {
    console,
    Date,
    document,
    fetch: async (path: string) => ({
      ok: true,
      json: async () =>
        path === "/health"
          ? {
              cursorBlock: 100,
              safeHead: 100,
              safeHeadKnown: true,
              status: "ok",
              syncedToSafeHead: true,
            }
          : {
              cumulativePerformanceFeeSharesRaw: "0",
              cumulativePerformanceFeeValueRaw: "0",
              sharePriceScaledRaw: "1000000",
              totalAssetsRaw: "1000000",
              totalSupplyRaw: "1000000000000000000",
              valuationBlock: 100,
              valuationTime: 1,
            },
    }),
    Intl,
  };

  vm.createContext(context);
  vm.runInContext(
    `${script}\nglobalThis.__dashboardTest = { renderAccount, renderVault };`,
    context,
  );

  const dashboard = (
    context as typeof context & {
      __dashboardTest: {
        renderAccount: (data: unknown) => void;
        renderVault: (data: unknown) => void;
      };
    }
  ).__dashboardTest;

  dashboard.renderAccount({
    activeDeposit: {
      shares: "1000000000000000000",
      valueRaw: "1000000",
    },
    address: "0x1111111111111111111111111111111111111111",
    blockContext: {
      blocksSincePerformanceFeeMint: 890,
      currentBlock: null,
      lastPerformanceFeeMintBlock: 48750000,
      lastProcessedLogBlock: 48750890,
    },
    earnedPerformanceFee: {
      shares: "500000000000000000",
      valueRaw: "120",
    },
    estimatedNetLifetimeEarned: {
      performanceFeeRateBps: "5000",
      raw: "150",
    },
    estimatedPerformanceFee: {
      raw: "150",
    },
    boost: {
      baseBoostBps: "40000",
      additionalBoostBps: "100000",
      totalBoostBps: "140000",
    },
    vship: {
      crystallizedRaw: "80000000",
      pendingRaw: "280000000",
      totalRaw: "360000000",
      feeWatermarkRaw: "1000000",
      priceUsdRaw: "50000",
      priceUsdDecimals: 6,
    },
    grossLifetimeEarned: {
      raw: "300",
    },
    lifetimeDeposited: {
      raw: "1000000",
    },
    lifetimeEarned: {
      raw: "300",
    },
    lifetimeWithdrawn: {
      raw: "0",
    },
    valuationBlock: 48750890,
    valuationTime: 1784291127,
  });

  const results = document.getElementById("account-results");
  assert.equal(metricValue(results, "Estimated net earned"), "0.00015 USDC");
  assert.equal(metricRaw(results, "Estimated net earned"), "raw: 150");
  assert.equal(metricValue(results, "Gross generated yield"), "0.0003 USDC");
  assert.equal(metricValue(results, "Estimated performance fee"), "0.00015 USDC");
  assert.equal(metricValue(results, "Crystallized fee value"), "0.00012 USDC");
  assert.equal(metricValue(results, "Performance fee rate"), "50%");
  assert.equal(metricValue(results, "Base boost"), "4×");
  assert.equal(metricValue(results, "Additional boost"), "10×");
  assert.equal(metricValue(results, "Total boost"), "14×");
  assert.equal(metricRaw(results, "Total boost"), "raw: 140000");
  assert.equal(metricValue(results, "Crystallized"), "80 vSHIP");
  assert.equal(metricValue(results, "Pending"), "280 vSHIP");
  assert.equal(metricValue(results, "Total"), "360 vSHIP");
  assert.equal(metricValue(results, "Fee watermark"), "1 USDC");
  assert.equal(metricValue(results, "vSHIP price"), "0.05 USD");
  assert.equal(metricValue(results, "Current block"), "Unknown");
  assert.equal(metricRaw(results, "Current block"), "raw: null");
  assert.equal(metricValue(results, "Last processed log"), "48,750,890");
  assert.equal(metricValue(results, "Blocks since fee mint"), "890");

  dashboard.renderVault({
    blockContext: {
      currentBlock: 48700120,
      lastProcessedLogBlock: 48700110,
    },
    cumulativePerformanceFeeSharesRaw: "0",
    cumulativePerformanceFeeValueRaw: "0",
    sharePriceScaledRaw: "1000000",
    totalAssetsRaw: "1000000",
    totalSupplyRaw: "1000000000000000000",
    valuationBlock: 48700100,
    valuationTime: 1712345600,
  });

  const vaultMetrics = document.getElementById("vault-metrics");
  assert.equal(metricValue(vaultMetrics, "Current block"), "48,700,120");
  assert.equal(metricValue(vaultMetrics, "Last processed log"), "48,700,110");
  assert.equal(metricValue(vaultMetrics, "Valuation block"), "48,700,100");
});

test("dashboard formats valuation times as Unix milliseconds", () => {
  const document = new FakeDocument();
  const script = readFileSync(join(process.cwd(), "public/dashboard.js"), "utf8");
  const context = {
    console,
    Date,
    document,
    fetch: async () => ({
      ok: true,
      json: async () => ({}),
    }),
    Intl,
  };

  vm.createContext(context);
  vm.runInContext(
    `${script}\nglobalThis.__dashboardTest = { formatTimestamp };`,
    context,
  );

  const dashboard = (
    context as typeof context & {
      __dashboardTest: {
        formatTimestamp: (value: number) => string;
      };
    }
  ).__dashboardTest;
  const valuationTimeMs = 1784291127583;

  assert.equal(
    dashboard.formatTimestamp(valuationTimeMs),
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(valuationTimeMs)),
  );
});
