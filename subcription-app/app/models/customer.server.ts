import db from "../db.server";

export interface SubscribedCustomer {
  customerShopifyId: string;
  name: string;
  email: string;
  subscriptionCount: number;
  lifetimeValue: number;
  since: Date;
}

/**
 * Customers who have at least one subscription contract, aggregated from our
 * webhook-synced mirrors (SubscriptionContract, SubscriptionOrder) -- not a
 * live Admin API call. "Lifetime value" is the sum of their actual recurring
 * orders billed so far, not the contract's per-cycle price.
 */
export async function listSubscribedCustomers({
  shop,
  search,
}: {
  shop: string;
  search?: string;
}): Promise<SubscribedCustomer[]> {
  const contracts = await db.subscriptionContract.findMany({
    where: { shop, customerShopifyId: { not: null } },
    select: {
      shopifyId: true,
      customerShopifyId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
    },
  });

  if (contracts.length === 0) {
    return [];
  }

  const orders = await db.subscriptionOrder.findMany({
    where: { shop, contractShopifyId: { in: contracts.map((c) => c.shopifyId) } },
    select: { contractShopifyId: true, totalPrice: true },
  });

  const contractToCustomer = new Map(contracts.map((c) => [c.shopifyId, c.customerShopifyId as string]));

  // Orders always settle in the shop's own base currency regardless of what
  // the customer saw at checkout, so these totals are already all in the same
  // unit -- the caller labels them with the shop's currency, fetched once.
  const valueByCustomer = new Map<string, number>();
  for (const order of orders) {
    const customerId = order.contractShopifyId ? contractToCustomer.get(order.contractShopifyId) : null;
    if (!customerId || order.totalPrice == null) continue;
    valueByCustomer.set(customerId, (valueByCustomer.get(customerId) ?? 0) + order.totalPrice);
  }

  interface Accumulator {
    name: string;
    email: string;
    count: number;
    since: Date;
  }
  const byCustomer = new Map<string, Accumulator>();
  for (const contract of contracts) {
    const id = contract.customerShopifyId as string;
    const existing = byCustomer.get(id);
    if (existing) {
      existing.count += 1;
      if (contract.createdAt < existing.since) existing.since = contract.createdAt;
    } else {
      byCustomer.set(id, {
        name: contract.customerName ?? "Unknown",
        email: contract.customerEmail ?? "",
        count: 1,
        since: contract.createdAt,
      });
    }
  }

  let results: SubscribedCustomer[] = Array.from(byCustomer.entries()).map(
    ([customerShopifyId, data]) => ({
      customerShopifyId,
      name: data.name,
      email: data.email,
      subscriptionCount: data.count,
      lifetimeValue: valueByCustomer.get(customerShopifyId) ?? 0,
      since: data.since,
    }),
  );

  if (search) {
    const term = search.toLowerCase();
    const matchingCustomerIds = new Set(
      contracts
        .filter((c) => c.shopifyId.split("/").pop() === search || c.shopifyId.toLowerCase().includes(term))
        .map((c) => c.customerShopifyId),
    );
    results = results.filter(
      (r) =>
        r.name.toLowerCase().includes(term) ||
        r.email.toLowerCase().includes(term) ||
        matchingCustomerIds.has(r.customerShopifyId),
    );
  }

  results.sort((a, b) => b.since.getTime() - a.since.getTime());
  return results;
}