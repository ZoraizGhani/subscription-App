import db from "../db.server";

export interface SubscriptionListRow {
  contractShopifyId: string;
  contractNumber: string;
  customerName: string;
  productTitle: string;
  frequencyLabel: string;
  nextBillingDate: Date | null;
  mrr: number;
  status: string;
}

export interface SubscriptionListResult {
  rows: SubscriptionListRow[];
  counts: { all: number; active: number; paused: number; cancelled: number; failed: number };
}

const INTERVAL_DAYS: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };
const INTERVAL_SHORT: Record<string, string> = { DAY: "d", WEEK: "w", MONTH: "mo", YEAR: "yr" };

/**
 * Contracts for the shop's Subscriptions list, with tab counts computed
 * before the status filter (so switching tabs doesn't change the other
 * counts) and search applied after. `createdFrom`/`createdTo` and
 * `cancelledFrom`/`cancelledTo` are the dashboard's "New vs. cancelled" chart
 * drilling down into a specific bucket -- when set, counts are computed from
 * that narrowed set too, since a date-filtered view showing shop-wide tab
 * counts would be misleading.
 */
export async function listSubscriptionContracts({
  shop,
  search,
  status,
  createdFrom,
  createdTo,
  cancelledFrom,
  cancelledTo,
}: {
  shop: string;
  search?: string;
  status?: string;
  createdFrom?: string;
  createdTo?: string;
  cancelledFrom?: string;
  cancelledTo?: string;
}): Promise<SubscriptionListResult> {
  const where: Record<string, unknown> = { shop };
  if (createdFrom || createdTo) {
    where.createdAt = {
      ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
      ...(createdTo ? { lt: new Date(createdTo) } : {}),
    };
  }
  if (cancelledFrom || cancelledTo) {
    where.cancelledAt = {
      ...(cancelledFrom ? { gte: new Date(cancelledFrom) } : {}),
      ...(cancelledTo ? { lt: new Date(cancelledTo) } : {}),
    };
  }

  const all = await db.subscriptionContract.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  // Shopify keeps a contract's own `status` as ACTIVE while it retries a
  // failed charge -- it essentially never actually transitions to FAILED --
  // so "payment failed" has to be read off `lastPaymentStatus` (the most
  // recent billing attempt's real outcome) instead, scoped to still-ACTIVE
  // contracts since a cancelled one's stale failure doesn't need surfacing.
  const isPaymentFailed = (c: (typeof all)[number]) => c.status === "ACTIVE" && c.lastPaymentStatus === "FAILED";

  const counts = {
    all: all.length,
    active: all.filter((c) => c.status === "ACTIVE").length,
    paused: all.filter((c) => c.status === "PAUSED").length,
    cancelled: all.filter((c) => c.status === "CANCELLED").length,
    failed: all.filter(isPaymentFailed).length,
  };

  let filtered = status ? (status === "FAILED" ? all.filter(isPaymentFailed) : all.filter((c) => c.status === status)) : all;

  if (search) {
    const term = search.toLowerCase();
    filtered = filtered.filter((c) => {
      const numericId = c.shopifyId.split("/").pop() ?? "";
      return (
        (c.customerName ?? "").toLowerCase().includes(term) ||
        (c.customerEmail ?? "").toLowerCase().includes(term) ||
        numericId === search ||
        c.shopifyId.toLowerCase().includes(term)
      );
    });
  }

  // The contract's totalAmount is in presentment currency (what the customer
  // saw at checkout, e.g. localized via Shopify Markets), which can differ
  // from what was actually charged. The most recent real order for that
  // contract is the authoritative amount, in the shop's settlement currency.
  const latestOrderAmount = new Map<string, number>();
  if (filtered.length > 0) {
    const orders = await db.subscriptionOrder.findMany({
      where: { shop, contractShopifyId: { in: filtered.map((c) => c.shopifyId) } },
      orderBy: { processedAt: "desc" },
      select: { contractShopifyId: true, totalPrice: true },
    });
    for (const order of orders) {
      if (!order.contractShopifyId || order.totalPrice == null) continue;
      if (!latestOrderAmount.has(order.contractShopifyId)) {
        latestOrderAmount.set(order.contractShopifyId, order.totalPrice);
      }
    }
  }

  const rows: SubscriptionListRow[] = filtered.map((contract) => {
    const lines = contract.linesJson
      ? (JSON.parse(contract.linesJson) as { title?: string }[])
      : [];
    const days =
      (INTERVAL_DAYS[contract.billingInterval ?? "MONTH"] ?? 30) *
      (contract.billingIntervalCount ?? 1);
    // Falls back to the contract's presentment amount only when no real order
    // has happened yet -- the best available estimate before a first charge.
    const perCycleAmount = latestOrderAmount.get(contract.shopifyId) ?? contract.totalAmount;
    const mrr = perCycleAmount != null ? perCycleAmount * (30 / days) : 0;
    const intervalShort = INTERVAL_SHORT[contract.billingInterval ?? ""] ?? "";

    return {
      contractShopifyId: contract.shopifyId,
      contractNumber: `#${contract.shopifyId.split("/").pop()}`,
      customerName: contract.customerName ?? "Unknown",
      productTitle: lines[0]?.title ?? "Unknown product",
      frequencyLabel:
        contract.billingIntervalCount != null
          ? `Every ${contract.billingIntervalCount}${intervalShort}`
          : "--",
      nextBillingDate: contract.nextBillingDate,
      mrr,
      status: contract.status,
    };
  });

  return { rows, counts };
}

export interface SubscriptionLineItem {
  title: string;
  variantTitle: string | null;
  quantity: number;
}

export interface SubscriptionBillingAttemptRow {
  id: string;
  status: string;
  amount: number | null;
  currencyCode: string | null;
  errorMessage: string | null;
  attemptedAt: Date;
}

export interface SubscriptionOrderRow {
  orderShopifyId: string;
  orderName: string | null;
  processedAt: Date | null;
  totalPrice: number | null;
  currencyCode: string | null;
}

export interface SubscriptionContractDetail {
  contractShopifyId: string;
  contractNumber: string;
  status: string;
  customerShopifyId: string | null;
  customerName: string;
  customerEmail: string;
  currencyCode: string;
  nextBillingDate: Date | null;
  frequencyLabel: string;
  totalAmount: number | null;
  lastPaymentStatus: string | null;
  createdAt: Date;
  pausedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  lines: SubscriptionLineItem[];
  billingHistory: SubscriptionBillingAttemptRow[];
  orders: SubscriptionOrderRow[];
}

/**
 * Everything the admin Subscription detail screen needs for one contract,
 * read entirely from our webhook-synced mirrors -- no live Admin API call,
 * since the mirror already carries line items, billing history, and order
 * history for a single contract. Returns null when the contract doesn't
 * belong to this shop, so the caller can 404.
 */
export async function getSubscriptionContractDetail({
  shop,
  contractShopifyId,
}: {
  shop: string;
  contractShopifyId: string;
}): Promise<SubscriptionContractDetail | null> {
  const contract = await db.subscriptionContract.findUnique({ where: { shopifyId: contractShopifyId } });
  if (!contract || contract.shop !== shop) {
    return null;
  }

  const [orders, billingAttempts] = await Promise.all([
    db.subscriptionOrder.findMany({ where: { shop, contractShopifyId }, orderBy: { processedAt: "desc" } }),
    db.billingAttempt.findMany({ where: { shop, contractShopifyId }, orderBy: { attemptedAt: "desc" } }),
  ]);

  const lines = contract.linesJson
    ? (JSON.parse(contract.linesJson) as { title?: string; variantTitle?: string | null; quantity?: number }[])
    : [];

  return {
    contractShopifyId: contract.shopifyId,
    contractNumber: `#${contract.shopifyId.split("/").pop()}`,
    status: contract.status,
    customerShopifyId: contract.customerShopifyId,
    customerName: contract.customerName ?? "Unknown",
    customerEmail: contract.customerEmail ?? "",
    currencyCode: contract.currencyCode,
    nextBillingDate: contract.nextBillingDate,
    frequencyLabel:
      contract.billingIntervalCount != null
        ? `Every ${contract.billingIntervalCount}${INTERVAL_SHORT[contract.billingInterval ?? ""] ?? ""}`
        : "--",
    totalAmount: contract.totalAmount,
    lastPaymentStatus: contract.lastPaymentStatus,
    createdAt: contract.createdAt,
    pausedAt: contract.pausedAt,
    cancelledAt: contract.cancelledAt,
    cancellationReason: contract.cancellationReason,
    lines: lines.map((line) => ({
      title: line.title ?? "Subscription",
      variantTitle: line.variantTitle ?? null,
      quantity: line.quantity ?? 1,
    })),
    billingHistory: billingAttempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      amount: attempt.amount,
      currencyCode: attempt.currencyCode,
      errorMessage: attempt.errorMessage,
      attemptedAt: attempt.attemptedAt,
    })),
    orders: orders.map((order) => ({
      orderShopifyId: order.orderShopifyId,
      orderName: order.orderName,
      processedAt: order.processedAt,
      totalPrice: order.totalPrice,
      currencyCode: order.currencyCode,
    })),
  };
}