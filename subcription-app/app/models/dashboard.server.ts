import db from "../db.server";

const INTERVAL_DAYS: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };
const DAY_MS = 24 * 60 * 60 * 1000;

function monthlyAmount(
  contract: { billingInterval: string | null; billingIntervalCount: number | null; totalAmount: number | null },
  latestOrderAmount?: number,
) {
  const days = (INTERVAL_DAYS[contract.billingInterval ?? "MONTH"] ?? 30) * (contract.billingIntervalCount ?? 1);
  const perCycleAmount = latestOrderAmount ?? contract.totalAmount;
  return perCycleAmount != null ? perCycleAmount * (30 / days) : 0;
}

function firstLineTitle(linesJson: string | null): string {
  if (!linesJson) return "Subscription";
  try {
    const lines = JSON.parse(linesJson) as { title?: string }[];
    return lines[0]?.title ?? "Subscription";
  } catch {
    return "Subscription";
  }
}

function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface DashboardMetrics {
  mrr: number;
  mrrDeltaPct: number | null;
  activeSubs: number;
  activeSubsDeltaPct: number | null;
  churnRate: number;
  churnDeltaPts: number | null;
  avgLtv: number;
  avgLtvDeltaPct: number | null;
  failedPayments: number;
}

/**
 * "N days ago" figures are reconstructed from createdAt/cancelledAt on the
 * mirror, not from stored historical snapshots (none exist) -- a contract
 * counts as active-as-of a past date if it existed and hadn't been cancelled
 * yet by then. Paused/resumed history isn't tracked at all, so this slightly
 * overcounts past-active contracts that are paused today. Good enough for a
 * trend arrow, not precise accounting.
 *
 * `windowDays` sets both what "current" period means and how far back the
 * prior comparison period reaches (e.g. windowDays=7 compares this week
 * against the 7 days before that).
 */
export async function getDashboardMetrics({
  shop,
  windowDays = 30,
}: {
  shop: string;
  windowDays?: number;
}): Promise<DashboardMetrics> {
  const now = new Date();
  const cutoff30 = new Date(now.getTime() - windowDays * DAY_MS);
  const cutoff60 = new Date(now.getTime() - windowDays * 2 * DAY_MS);

  const allContracts = await db.subscriptionContract.findMany({
    where: { shop },
    select: {
      shopifyId: true,
      status: true,
      billingInterval: true,
      billingIntervalCount: true,
      totalAmount: true,
      customerShopifyId: true,
      createdAt: true,
      cancelledAt: true,
    },
  });

  const orders = await db.subscriptionOrder.findMany({
    where: { shop },
    select: { contractShopifyId: true, totalPrice: true, processedAt: true },
    orderBy: { processedAt: "desc" },
  });

  const latestOrderAmountByContract = new Map<string, number>();
  for (const order of orders) {
    if (!order.contractShopifyId || order.totalPrice == null) continue;
    if (!latestOrderAmountByContract.has(order.contractShopifyId)) {
      latestOrderAmountByContract.set(order.contractShopifyId, order.totalPrice);
    }
  }

  const wasActiveAsOf = (contract: (typeof allContracts)[number], asOf: Date) =>
    contract.createdAt <= asOf && (!contract.cancelledAt || contract.cancelledAt > asOf);

  const activeNow = allContracts.filter((c) => c.status === "ACTIVE");
  const activeAsOf30 = allContracts.filter((c) => wasActiveAsOf(c, cutoff30));
  const activeAsOf60 = allContracts.filter((c) => wasActiveAsOf(c, cutoff60));

  const mrrOf = (contracts: typeof allContracts) =>
    contracts.reduce((sum, c) => sum + monthlyAmount(c, latestOrderAmountByContract.get(c.shopifyId)), 0);

  const mrr = mrrOf(activeNow);
  const mrr30 = mrrOf(activeAsOf30);

  const cancelledLast30 = allContracts.filter((c) => c.cancelledAt && c.cancelledAt > cutoff30).length;
  const cancelledPrior30 = allContracts.filter(
    (c) => c.cancelledAt && c.cancelledAt > cutoff60 && c.cancelledAt <= cutoff30,
  ).length;

  const churnRate = activeAsOf30.length > 0 ? (cancelledLast30 / activeAsOf30.length) * 100 : 0;
  const churnPrior = activeAsOf60.length > 0 ? (cancelledPrior30 / activeAsOf60.length) * 100 : 0;

  const revenueByCustomer = (asOf?: Date) => {
    const byCustomer = new Map<string, number>();
    const contractToCustomer = new Map(allContracts.map((c) => [c.shopifyId, c.customerShopifyId]));
    for (const order of orders) {
      if (asOf && order.processedAt && order.processedAt > asOf) continue;
      const customerId = order.contractShopifyId ? contractToCustomer.get(order.contractShopifyId) : null;
      if (!customerId || order.totalPrice == null) continue;
      byCustomer.set(customerId, (byCustomer.get(customerId) ?? 0) + order.totalPrice);
    }
    return byCustomer;
  };

  const avgOf = (byCustomer: Map<string, number>) =>
    byCustomer.size > 0 ? Array.from(byCustomer.values()).reduce((a, b) => a + b, 0) / byCustomer.size : 0;

  const avgLtv = avgOf(revenueByCustomer());
  const avgLtv30 = avgOf(revenueByCustomer(cutoff30));

  const failedPayments = allContracts.filter((c) => c.status === "FAILED").length;

  return {
    mrr,
    mrrDeltaPct: percentDelta(mrr, mrr30),
    activeSubs: activeNow.length,
    activeSubsDeltaPct: percentDelta(activeNow.length, activeAsOf30.length),
    churnRate,
    churnDeltaPts: churnRate - churnPrior,
    avgLtv,
    avgLtvDeltaPct: percentDelta(avgLtv, avgLtv30),
    failedPayments,
  };
}

export interface MonthlyFlow {
  label: string;
  created: number;
  cancelled: number;
  /** ISO bucket boundaries, for drilling down into which contracts landed here. */
  startDate: string;
  endDate: string;
}

export type FlowBucketUnit = "day" | "week" | "month";

function bucketStart(date: Date, unit: FlowBucketUnit, offsetFromNow: number, now: Date): Date {
  if (unit === "day") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return new Date(start.getTime() - offsetFromNow * DAY_MS);
  }
  if (unit === "week") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return new Date(start.getTime() - offsetFromNow * 7 * DAY_MS);
  }
  return new Date(now.getFullYear(), now.getMonth() - offsetFromNow, 1);
}

function bucketLabel(date: Date, unit: FlowBucketUnit): string {
  if (unit === "month") return date.toLocaleDateString("en-US", { month: "short" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function bucketIndex(date: Date, windowStart: Date, unit: FlowBucketUnit): number {
  if (unit === "day") return Math.floor((date.getTime() - windowStart.getTime()) / DAY_MS);
  if (unit === "week") return Math.floor((date.getTime() - windowStart.getTime()) / (7 * DAY_MS));
  return (date.getFullYear() - windowStart.getFullYear()) * 12 + (date.getMonth() - windowStart.getMonth());
}

/** Buckets contract creations and cancellations into `count` buckets of
 * `unit` size, oldest first, ending with the current (partial) bucket. */
export async function getNewVsCancelledSeries({
  shop,
  unit = "month",
  count = 6,
}: {
  shop: string;
  unit?: FlowBucketUnit;
  count?: number;
}): Promise<MonthlyFlow[]> {
  const now = new Date();
  const windowStart = bucketStart(now, unit, count - 1, now);

  const contracts = await db.subscriptionContract.findMany({
    where: {
      shop,
      OR: [{ createdAt: { gte: windowStart } }, { cancelledAt: { gte: windowStart } }],
    },
    select: { createdAt: true, cancelledAt: true },
  });

  const buckets: MonthlyFlow[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = bucketStart(now, unit, i, now);
    // The most recent bucket is the current, still-filling one -- it ends
    // now rather than at the next bucket's start.
    const end = i === 0 ? now : bucketStart(now, unit, i - 1, now);
    buckets.push({
      label: bucketLabel(start, unit),
      created: 0,
      cancelled: 0,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
  }

  for (const contract of contracts) {
    const createdIdx = bucketIndex(contract.createdAt, windowStart, unit);
    if (createdIdx >= 0 && createdIdx < count) buckets[createdIdx].created += 1;
    if (contract.cancelledAt) {
      const cancelledIdx = bucketIndex(contract.cancelledAt, windowStart, unit);
      if (cancelledIdx >= 0 && cancelledIdx < count) buckets[cancelledIdx].cancelled += 1;
    }
  }

  return buckets;
}

export interface NeedsAttentionRow {
  contractShopifyId: string;
  contractNumber: string;
  customerName: string;
}

export async function getNeedsAttention({ shop }: { shop: string }): Promise<NeedsAttentionRow[]> {
  // Shopify keeps a contract's own `status` as ACTIVE while it retries a
  // failed charge -- it essentially never actually transitions to FAILED,
  // so that field can't be used to detect payment trouble. `lastPaymentStatus`
  // is the one that actually reflects the most recent billing attempt's
  // outcome (see the subscription_billing_attempts/failure webhook handler),
  // scoped to still-ACTIVE contracts since a cancelled one's stale failure
  // doesn't need review.
  const contracts = await db.subscriptionContract.findMany({
    where: { shop, status: "ACTIVE", lastPaymentStatus: "FAILED" },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { shopifyId: true, customerName: true },
  });

  return contracts.map((c) => ({
    contractShopifyId: c.shopifyId,
    contractNumber: `#${c.shopifyId.split("/").pop()}`,
    customerName: c.customerName ?? "Unknown",
  }));
}

export interface RenewalRow {
  contractShopifyId: string;
  customerName: string;
  productTitle: string;
  nextBillingDate: Date;
  amount: number | null;
  currencyCode: string;
  status: string;
}

export async function getUpcomingRenewals({
  shop,
  windowDays = 7,
}: {
  shop: string;
  windowDays?: number;
}): Promise<RenewalRow[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * DAY_MS);

  const contracts = await db.subscriptionContract.findMany({
    where: { shop, status: "ACTIVE", nextBillingDate: { gte: now, lte: windowEnd } },
    orderBy: { nextBillingDate: "asc" },
    take: 10,
  });

  if (contracts.length === 0) return [];

  const orders = await db.subscriptionOrder.findMany({
    where: { shop, contractShopifyId: { in: contracts.map((c) => c.shopifyId) } },
    orderBy: { processedAt: "desc" },
    select: { contractShopifyId: true, totalPrice: true },
  });
  const latestOrderAmountByContract = new Map<string, number>();
  for (const order of orders) {
    if (!order.contractShopifyId || order.totalPrice == null) continue;
    if (!latestOrderAmountByContract.has(order.contractShopifyId)) {
      latestOrderAmountByContract.set(order.contractShopifyId, order.totalPrice);
    }
  }

  return contracts.map((c) => ({
    contractShopifyId: c.shopifyId,
    customerName: c.customerName ?? "Unknown",
    productTitle: firstLineTitle(c.linesJson),
    nextBillingDate: c.nextBillingDate as Date,
    amount: latestOrderAmountByContract.get(c.shopifyId) ?? c.totalAmount,
    currencyCode: c.currencyCode,
    status: c.status,
  }));
}
