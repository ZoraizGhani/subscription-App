import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

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

const INTERVAL_SHORT: Record<string, string> = { DAY: "d", WEEK: "w", MONTH: "mo", YEAR: "yr" };

function firstLineTitle(linesJson: string | null): string {
  if (!linesJson) return "Subscription";
  try {
    const lines = JSON.parse(linesJson) as { title?: string }[];
    return lines[0]?.title ?? "Subscription";
  } catch {
    return "Subscription";
  }
}

export interface CustomerSubscriptionRow {
  contractShopifyId: string;
  contractNumber: string;
  productTitle: string;
  status: string;
  frequencyLabel: string;
  nextBillingDate: Date | null;
  totalAmount: number | null;
  currencyCode: string;
  cancellationReason: string | null;
  createdAt: Date;
}

export interface CustomerBillingAttemptRow {
  id: string;
  status: string;
  amount: number | null;
  currencyCode: string | null;
  errorMessage: string | null;
  attemptedAt: Date;
}

export interface CustomerOrderRow {
  orderShopifyId: string;
  orderName: string | null;
  processedAt: Date | null;
  totalPrice: number | null;
  currencyCode: string | null;
  productTitle: string | null;
}

export interface CustomerDetail {
  customerShopifyId: string;
  name: string;
  email: string;
  since: Date;
  lifetimeValue: number;
  subscriptionCount: number;
  phone: string | null;
  tags: string[];
  note: string | null;
  defaultAddress: string | null;
  paymentMethods: string[];
  subscriptions: CustomerSubscriptionRow[];
  billingHistory: CustomerBillingAttemptRow[];
  orders: CustomerOrderRow[];
}

const CUSTOMER_PROFILE_QUERY = `#graphql
  query AdminCustomerProfile($id: ID!) {
    customer(id: $id) {
      defaultPhoneNumber {
        phoneNumber
      }
      tags
      note
      defaultAddress {
        address1
        address2
        city
        provinceCode
        zip
        countryCodeV2
      }
      paymentMethods(first: 5, showRevoked: false) {
        edges {
          node {
            instrument {
              ... on CustomerCreditCard { brand lastDigits }
            }
          }
        }
      }
    }
  }
`;

interface RawCustomerProfile {
  defaultPhoneNumber: { phoneNumber: string | null } | null;
  tags: string[];
  note: string | null;
  defaultAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    countryCodeV2: string | null;
  } | null;
  paymentMethods: {
    edges: { node: { instrument: { brand?: string; lastDigits?: string } | null } }[];
  };
}

/**
 * Everything the admin Customer detail screen needs for one subscriber:
 * their contracts, recent recurring orders, and billing attempts from our
 * mirrors, plus profile fields (address, tags, note, payment methods) read
 * live from Shopify since those aren't mirrored anywhere. Returns null when
 * this shop has no contract for that customer -- the caller should 404.
 */
export async function getCustomerDetail({
  shop,
  customerShopifyId,
  graphql,
}: {
  shop: string;
  customerShopifyId: string;
  graphql: AdminGraphqlClient;
}): Promise<CustomerDetail | null> {
  const contracts = await db.subscriptionContract.findMany({
    where: { shop, customerShopifyId },
    orderBy: { createdAt: "desc" },
  });

  if (contracts.length === 0) {
    return null;
  }

  const contractIds = contracts.map((c) => c.shopifyId);

  const [orders, billingAttempts] = await Promise.all([
    db.subscriptionOrder.findMany({
      where: { shop, contractShopifyId: { in: contractIds } },
      orderBy: { processedAt: "desc" },
      take: 20,
    }),
    db.billingAttempt.findMany({
      where: { shop, contractShopifyId: { in: contractIds } },
      orderBy: { attemptedAt: "desc" },
      take: 20,
    }),
  ]);

  const lifetimeValue = orders.reduce((sum, order) => sum + (order.totalPrice ?? 0), 0);
  const since = contracts.reduce(
    (earliest, c) => (c.createdAt < earliest ? c.createdAt : earliest),
    contracts[0].createdAt,
  );

  let phone: string | null = null;
  let tags: string[] = [];
  let note: string | null = null;
  let defaultAddress: string | null = null;
  let paymentMethods: string[] = [];

  try {
    const response = await graphql(CUSTOMER_PROFILE_QUERY, { variables: { id: customerShopifyId } });
    const body = (await response.json()) as { data?: { customer: RawCustomerProfile | null } };
    const customer = body.data?.customer;
    if (customer) {
      phone = customer.defaultPhoneNumber?.phoneNumber ?? null;
      tags = customer.tags ?? [];
      note = customer.note;
      const address = customer.defaultAddress;
      defaultAddress = address
        ? [address.address1, address.address2, address.city, address.provinceCode, address.zip, address.countryCodeV2]
            .filter(Boolean)
            .join(", ")
        : null;
      paymentMethods = (customer.paymentMethods.edges ?? [])
        .map((edge) => edge.node.instrument)
        .filter((instrument): instrument is { brand?: string; lastDigits?: string } => instrument != null)
        .map((instrument) =>
          instrument.brand && instrument.lastDigits ? `${instrument.brand} •••• ${instrument.lastDigits}` : "On file",
        );
    }
  } catch {
    // Live profile fields are a convenience -- if the customer was deleted
    // from Shopify or the call fails, the mirrored subscription data below
    // still renders fine without them.
  }

  const productTitleByContract = new Map(contracts.map((c) => [c.shopifyId, firstLineTitle(c.linesJson)]));

  return {
    customerShopifyId,
    name: contracts[0].customerName ?? "Unknown",
    email: contracts[0].customerEmail ?? "",
    since,
    lifetimeValue,
    subscriptionCount: contracts.length,
    phone,
    tags,
    note,
    defaultAddress,
    paymentMethods,
    subscriptions: contracts.map((c) => ({
      contractShopifyId: c.shopifyId,
      contractNumber: `#${c.shopifyId.split("/").pop()}`,
      productTitle: firstLineTitle(c.linesJson),
      status: c.status,
      frequencyLabel:
        c.billingIntervalCount != null
          ? `Every ${c.billingIntervalCount}${INTERVAL_SHORT[c.billingInterval ?? ""] ?? ""}`
          : "--",
      nextBillingDate: c.nextBillingDate,
      totalAmount: c.totalAmount,
      currencyCode: c.currencyCode,
      cancellationReason: c.cancellationReason,
      createdAt: c.createdAt,
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
      productTitle: order.contractShopifyId ? productTitleByContract.get(order.contractShopifyId) ?? null : null,
    })),
  };
}