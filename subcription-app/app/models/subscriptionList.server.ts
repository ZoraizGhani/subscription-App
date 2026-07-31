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
 * counts) and search applied after.
 */
export async function listSubscriptionContracts({
  shop,
  search,
  status,
}: {
  shop: string;
  search?: string;
  status?: string;
}): Promise<SubscriptionListResult> {
  const all = await db.subscriptionContract.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  const counts = {
    all: all.length,
    active: all.filter((c) => c.status === "ACTIVE").length,
    paused: all.filter((c) => c.status === "PAUSED").length,
    cancelled: all.filter((c) => c.status === "CANCELLED").length,
    failed: all.filter((c) => c.status === "FAILED").length,
  };

  let filtered = status ? all.filter((c) => c.status === status) : all;

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