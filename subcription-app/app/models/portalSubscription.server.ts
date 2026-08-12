import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { syncSubscriptionContract } from "./subscription.server";

export class PortalOwnershipError extends Error {}

interface ContractLine {
  title: string;
  variantTitle?: string | null;
  quantity: number;
  productId?: string | null;
}

function firstLine(linesJson: string | null): ContractLine | null {
  if (!linesJson) return null;
  try {
    const lines = JSON.parse(linesJson) as ContractLine[];
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

function firstLineTitle(linesJson: string | null): string {
  return firstLine(linesJson)?.title ?? "Subscription";
}

function firstLineProductId(linesJson: string | null): string | null {
  return firstLine(linesJson)?.productId ?? null;
}

const ORDER_FULFILLMENT_STATUS_QUERY = `#graphql
  query PortalOrderFulfillmentStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id displayFulfillmentStatus statusPageUrl }
    }
  }
`;

interface OrderLiveDetails {
  fulfillmentStatus: string;
  receiptUrl: string | null;
}

/**
 * Fulfillment status and the receipt link aren't mirrored anywhere -- Shopify
 * is the only source for either, so they're always fetched live. A failure
 * here (or an order Shopify no longer has) just leaves those orders' status
 * and receipt link blank rather than breaking whichever page called this.
 */
async function getOrderFulfillmentStatuses({
  shop,
  orderShopifyIds,
}: {
  shop: string;
  orderShopifyIds: string[];
}): Promise<Map<string, OrderLiveDetails>> {
  const detailsByOrder = new Map<string, OrderLiveDetails>();
  if (orderShopifyIds.length === 0) return detailsByOrder;

  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(ORDER_FULFILLMENT_STATUS_QUERY, {
      variables: { ids: orderShopifyIds },
    });
    const body = (await response.json()) as {
      data?: { nodes: ({ id: string; displayFulfillmentStatus: string; statusPageUrl: string | null } | null)[] };
    };
    for (const node of body.data?.nodes ?? []) {
      if (node) {
        detailsByOrder.set(node.id, { fulfillmentStatus: node.displayFulfillmentStatus, receiptUrl: node.statusPageUrl });
      }
    }
  } catch {
    // Live status is a convenience -- the caller still renders fine without it.
  }

  return detailsByOrder;
}

const PRODUCT_IMAGE_QUERY = `#graphql
  query PortalProductImage($id: ID!) {
    product(id: $id) {
      featuredImage { url altText }
    }
  }
`;

export async function getPortalOverview({
  shop,
  customerShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
}) {
  const contracts = await db.subscriptionContract.findMany({
    where: { shop, customerShopifyId },
    orderBy: { createdAt: "desc" },
  });

  const contractIds = contracts.map((c) => c.shopifyId);

  const [orders, lifetimeOrderCount] = await Promise.all([
    db.subscriptionOrder.findMany({
      where: { shop, contractShopifyId: { in: contractIds } },
      orderBy: { processedAt: "desc" },
      take: 5,
    }),
    db.subscriptionOrder.count({ where: { shop, contractShopifyId: { in: contractIds } } }),
  ]);

  const fulfillmentStatusByOrder = await getOrderFulfillmentStatuses({
    shop,
    orderShopifyIds: orders.map((o) => o.orderShopifyId),
  });

  const activeContracts = contracts.filter((c) => c.status === "ACTIVE");

  let correctedDates = new Map<string, Date | null>();
  let activeProductImageUrl: string | null = null;
  try {
    const { admin } = await unauthenticated.admin(shop);
    correctedDates = new Map(
      await Promise.all(
        activeContracts.map(async (c) => [c.shopifyId, await correctedNextBillingDate({ admin, contract: c })] as const),
      ),
    );

    const activeProductId = activeContracts[0] ? firstLineProductId(activeContracts[0].linesJson) : null;
    if (activeProductId) {
      const response = await admin.graphql(PRODUCT_IMAGE_QUERY, { variables: { id: activeProductId } });
      const body = (await response.json()) as {
        data?: { product: { featuredImage: { url: string } | null } | null };
      };
      activeProductImageUrl = body.data?.product?.featuredImage?.url ?? null;
    }
  } catch {
    // Live correction/image lookup is a best-effort accuracy improvement --
    // if the admin client itself can't be obtained, fall through to the
    // mirrored dates and no image.
  }

  const nextCharge = activeContracts
    .map((c) => correctedDates.get(c.shopifyId) ?? c.nextBillingDate)
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    activeCount: activeContracts.length,
    nextChargeDate: nextCharge ?? null,
    lifetimeOrders: lifetimeOrderCount,
    activeSubscription: activeContracts[0]
      ? {
          contractShopifyId: activeContracts[0].shopifyId,
          productTitle: firstLineTitle(activeContracts[0].linesJson),
          productImageUrl: activeProductImageUrl,
          nextBillingDate: correctedDates.get(activeContracts[0].shopifyId) ?? activeContracts[0].nextBillingDate,
          status: activeContracts[0].status,
        }
      : null,
    recentOrders: orders.map((o) => ({
      orderShopifyId: o.orderShopifyId,
      orderName: o.orderName,
      processedAt: o.processedAt,
      totalPrice: o.totalPrice,
      currencyCode: o.currencyCode,
      fulfillmentStatus: fulfillmentStatusByOrder.get(o.orderShopifyId)?.fulfillmentStatus ?? null,
    })),
  };
}

const PRODUCT_HANDLES_QUERY = `#graphql
  query PortalProductHandles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        featuredImage { url }
      }
    }
  }
`;

const CONTRACT_SUMMARY_QUERY = `#graphql
  query PortalContractSummaries($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on SubscriptionContract {
        id
        customerPaymentMethod {
          instrument {
            ... on CustomerCreditCard { brand lastDigits }
          }
        }
        deliveryMethod {
          ... on SubscriptionDeliveryMethodShipping {
            address { city }
          }
        }
      }
    }
  }
`;

interface ContractSummaryNode {
  id: string;
  customerPaymentMethod: { instrument: { brand?: string; lastDigits?: string } | null } | null;
  deliveryMethod: { address?: { city: string | null } } | null;
}

export async function listPortalSubscriptions({
  shop,
  customerShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
}) {
  const contracts = await db.subscriptionContract.findMany({
    where: { shop, customerShopifyId },
    orderBy: { createdAt: "desc" },
  });

  const productIds = Array.from(
    new Set(contracts.map((c) => firstLineProductId(c.linesJson)).filter((id): id is string => id != null)),
  );

  const handleByProductId = new Map<string, string>();
  const imageByProductId = new Map<string, string>();
  const summaryByContractId = new Map<string, { shipToDisplay: string | null; paymentMethodDisplay: string | null }>();
  let correctedDates = new Map<string, Date | null>();
  try {
    const { admin } = await unauthenticated.admin(shop);

    if (productIds.length) {
      const response = await admin.graphql(PRODUCT_HANDLES_QUERY, { variables: { ids: productIds } });
      const body = (await response.json()) as {
        data?: { nodes: ({ id: string; handle: string; featuredImage: { url: string } | null } | null)[] };
      };
      for (const node of body.data?.nodes ?? []) {
        if (!node) continue;
        handleByProductId.set(node.id, node.handle);
        if (node.featuredImage?.url) imageByProductId.set(node.id, node.featuredImage.url);
      }
    }

    // Ship-to/payment summaries are only shown for active contracts, so only
    // fetch what the UI will actually render.
    const activeContractIds = contracts.filter((c) => c.status === "ACTIVE").map((c) => c.shopifyId);
    if (activeContractIds.length) {
      const response = await admin.graphql(CONTRACT_SUMMARY_QUERY, { variables: { ids: activeContractIds } });
      const body = (await response.json()) as { data?: { nodes: (ContractSummaryNode | null)[] } };
      for (const node of body.data?.nodes ?? []) {
        if (!node) continue;
        const instrument = node.customerPaymentMethod?.instrument;
        summaryByContractId.set(node.id, {
          shipToDisplay: node.deliveryMethod?.address?.city ?? null,
          paymentMethodDisplay:
            instrument?.brand && instrument.lastDigits ? `${instrument.brand} •••• ${instrument.lastDigits}` : null,
        });
      }
    }

    // Shopify's own contract.nextBillingDate doesn't reliably advance once a
    // cycle has been charged out-of-band (e.g. via Ship Now) -- see
    // findNextUnbilledCycle's doc comment. Recompute it live for active
    // contracts so "next shipment" doesn't show a stale, already-billed date.
    correctedDates = new Map(
      await Promise.all(
        contracts
          .filter((c) => c.status === "ACTIVE")
          .map(async (c) => [c.shopifyId, await correctedNextBillingDate({ admin, contract: c })] as const),
      ),
    );
  } catch {
    // Best-effort accuracy improvements -- if the admin client itself can't
    // be obtained, the list still renders fine with the mirrored data.
  }

  return contracts.map((c) => {
    const line = firstLine(c.linesJson);
    const summary = summaryByContractId.get(c.shopifyId);
    return {
      contractShopifyId: c.shopifyId,
      productTitle: line?.title ?? "Subscription",
      productHandle: line?.productId ? (handleByProductId.get(line.productId) ?? null) : null,
      productImageUrl: line?.productId ? (imageByProductId.get(line.productId) ?? null) : null,
      quantity: line?.quantity ?? null,
      variantTitle: line?.variantTitle ?? null,
      status: c.status,
      totalAmount: c.totalAmount,
      currencyCode: c.currencyCode,
      nextBillingDate: correctedDates.get(c.shopifyId) ?? c.nextBillingDate,
      billingInterval: c.billingInterval,
      billingIntervalCount: c.billingIntervalCount,
      cancellationReason: c.cancellationReason,
      shipToDisplay: summary?.shipToDisplay ?? null,
      paymentMethodDisplay: summary?.paymentMethodDisplay ?? null,
    };
  });
}

export async function listPortalOrders({
  shop,
  customerShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
}) {
  const contracts = await db.subscriptionContract.findMany({
    where: { shop, customerShopifyId },
    select: { shopifyId: true, linesJson: true },
  });
  const titleByContract = new Map(
    contracts.map((c) => [c.shopifyId, firstLineTitle(c.linesJson)]),
  );

  const orders = await db.subscriptionOrder.findMany({
    where: { shop, contractShopifyId: { in: contracts.map((c) => c.shopifyId) } },
    orderBy: { processedAt: "desc" },
  });

  const fulfillmentStatusByOrder = await getOrderFulfillmentStatuses({
    shop,
    orderShopifyIds: orders.map((o) => o.orderShopifyId),
  });

  return orders.map((o) => ({
    orderShopifyId: o.orderShopifyId,
    orderName: o.orderName,
    processedAt: o.processedAt,
    totalPrice: o.totalPrice,
    currencyCode: o.currencyCode,
    productTitle: o.contractShopifyId ? titleByContract.get(o.contractShopifyId) : null,
    fulfillmentStatus: fulfillmentStatusByOrder.get(o.orderShopifyId)?.fulfillmentStatus ?? null,
    receiptUrl: fulfillmentStatusByOrder.get(o.orderShopifyId)?.receiptUrl ?? null,
  }));
}

async function assertOwnedActiveContract({
  shop,
  customerShopifyId,
  contractShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
}) {
  const contract = await db.subscriptionContract.findUnique({
    where: { shopifyId: contractShopifyId },
  });
  if (!contract || contract.shop !== shop || contract.customerShopifyId !== customerShopifyId) {
    throw new PortalOwnershipError("This subscription doesn't belong to your account.");
  }
  return contract;
}

const BILLING_CYCLES_QUERY = `#graphql
  query PortalBillingCyclesWindow($id: ID!, $startIndex: Int!, $endIndex: Int!) {
    subscriptionBillingCycles(
      contractId: $id
      first: 25
      billingCyclesIndexRangeSelector: { startIndex: $startIndex, endIndex: $endIndex }
    ) {
      edges {
        node {
          cycleIndex
          status
          skipped
          billingAttemptExpectedDate
        }
      }
    }
  }
`;

/**
 * contract.nextBillingDate does NOT reliably advance after a cycle is charged
 * out-of-band via subscriptionBillingCycleCharge (confirmed against the live
 * API -- it can keep pointing at an already-billed cycle), so the only
 * trustworthy way to find the real next actionable cycle is to scan
 * subscriptionBillingCycles directly for the first one that's still UNBILLED
 * and not skipped.
 *
 * Shopify also caps how far ahead it will compute cycles for a contract, and
 * that cap depends on the contract's own interval (confirmed live: a 25-cycle
 * window works for a 1-day-interval contract but fails with "Upcoming
 * billing cycle selected past limit" for a longer-interval one where 25
 * cycles would reach years into the future). admin.graphql() throws on that
 * error rather than returning it in the response body, so the retry has to
 * wrap the call itself, not inspect the parsed result.
 */
export async function findNextUnbilledCycle(
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"],
  contractShopifyId: string,
) {
  const MAX_INDEX = 500;
  let windowSize = 25;
  let start = 1;

  while (start <= MAX_INDEX) {
    let body: {
      data?: {
        subscriptionBillingCycles: {
          edges: {
            node: {
              cycleIndex: number;
              status: string;
              skipped: boolean;
              billingAttemptExpectedDate: string;
            };
          }[];
        };
      } | null;
      errors?: { message: string }[];
    };

    try {
      const response = await admin.graphql(BILLING_CYCLES_QUERY, {
        variables: { id: contractShopifyId, startIndex: start, endIndex: start + windowSize - 1 },
      });
      body = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("past limit") && windowSize > 1) {
        windowSize = Math.max(1, Math.floor(windowSize / 2));
        continue;
      }
      throw error;
    }

    if (body.errors?.some((e) => e.message.includes("past limit"))) {
      if (windowSize === 1) break;
      windowSize = Math.max(1, Math.floor(windowSize / 2));
      continue;
    }

    const edges = body.data?.subscriptionBillingCycles?.edges ?? [];
    if (!edges.length) break;

    const next = edges.find((e) => e.node.status === "UNBILLED" && !e.node.skipped);
    if (next) {
      return { index: next.node.cycleIndex, date: next.node.billingAttemptExpectedDate };
    }

    start += edges.length;
  }

  throw new Error("Could not find an upcoming billing cycle for this subscription.");
}

/**
 * Read-model version of the same correction skipPortalNextOrder/shipPortalOrderNow
 * already apply after their own mutations: resolves the contract's TRUE next
 * unbilled cycle via a live scan (see findNextUnbilledCycle's doc comment for
 * why the mirrored/raw field can't be trusted), and self-heals the Postgres
 * mirror if it's out of sync so later reads don't have to re-scan. Only
 * meaningful for ACTIVE contracts; anything else just echoes back its stored
 * date since there's no "next actionable cycle" to resolve. Never throws --
 * a scan failure (rate limit, contract just changed state, etc.) falls back
 * to the possibly-stale mirrored date rather than breaking the page.
 */
async function correctedNextBillingDate({
  admin,
  contract,
}: {
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  contract: { shopifyId: string; status: string; nextBillingDate: Date | null };
}): Promise<Date | null> {
  if (contract.status !== "ACTIVE") return contract.nextBillingDate;

  try {
    const real = await findNextUnbilledCycle(admin, contract.shopifyId);
    const realDate = new Date(real.date);
    if (!contract.nextBillingDate || realDate.getTime() !== contract.nextBillingDate.getTime()) {
      await db.subscriptionContract.update({
        where: { shopifyId: contract.shopifyId },
        data: { nextBillingDate: realDate },
      });
    }
    return realDate;
  } catch {
    return contract.nextBillingDate;
  }
}

/**
 * Re-scans for the cycle that should now be next after skipping/charging
 * `previousIndex`. Shopify doesn't always finish recomputing cycle
 * availability synchronously with the mutation response -- scanning again
 * immediately can occasionally land one cycle further out than it should
 * (confirmed live: a skip of cycle 6 briefly reported cycle 8 as next,
 * skipping straight past the legitimately still-unbilled cycle 7). Retries a
 * few times with a short delay whenever the result isn't the immediate next
 * index, rather than trusting the first scan unconditionally.
 */
async function findImmediateNextCycle(
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"],
  contractShopifyId: string,
  previousIndex: number,
) {
  let cycle = await findNextUnbilledCycle(admin, contractShopifyId);
  for (let attempt = 0; attempt < 3 && cycle.index !== previousIndex + 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    cycle = await findNextUnbilledCycle(admin, contractShopifyId);
  }
  return cycle;
}

const SKIP_CYCLE_MUTATION = `#graphql
  mutation PortalSkipBillingCycle($input: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycleSkip(billingCycleInput: $input) {
      billingCycle { skipped }
      userErrors { field message }
    }
  }
`;

export async function skipPortalNextOrder({
  shop,
  customerShopifyId,
  contractShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
}) {
  const contract = await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);
  const nextCycle = await findNextUnbilledCycle(admin, contractShopifyId);

  const response = await admin.graphql(SKIP_CYCLE_MUTATION, {
    variables: { input: { contractId: contractShopifyId, selector: { index: nextCycle.index } } },
  });
  const body = (await response.json()) as {
    data?: {
      subscriptionBillingCycleSkip: {
        billingCycle: { skipped: boolean } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const result = body.data?.subscriptionBillingCycleSkip;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length || !result?.billingCycle) {
    throw new Error(`subscriptionBillingCycleSkip failed: ${JSON.stringify(userErrors)}`);
  }

  const refreshedCycle = await findImmediateNextCycle(admin, contractShopifyId, nextCycle.index);
  await db.subscriptionContract.update({
    where: { shopifyId: contract.shopifyId },
    data: { nextBillingDate: new Date(refreshedCycle.date) },
  });

  return { nextBillingDate: refreshedCycle.date };
}

const SHIP_NOW_MUTATION = `#graphql
  mutation PortalShipNow($id: ID!, $selector: SubscriptionBillingCycleSelector!) {
    subscriptionBillingCycleCharge(subscriptionContractId: $id, billingCycleSelector: $selector, actor: CUSTOMER) {
      subscriptionBillingAttempt { id ready errorMessage }
      userErrors { field message }
    }
  }
`;

const BILLING_ATTEMPT_QUERY = `#graphql
  query PortalBillingAttempt($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      ready
      errorMessage
      order { id name }
    }
  }
`;

/**
 * Forces the contract's next scheduled cycle to charge immediately instead of
 * waiting for Shopify's own billing schedule. Polls briefly for the result
 * since billing attempts process asynchronously.
 */
export async function shipPortalOrderNow({
  shop,
  customerShopifyId,
  contractShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);
  const nextCycle = await findNextUnbilledCycle(admin, contractShopifyId);

  const chargeResponse = await admin.graphql(SHIP_NOW_MUTATION, {
    variables: { id: contractShopifyId, selector: { index: nextCycle.index } },
  });
  const chargeBody = (await chargeResponse.json()) as {
    data?: {
      subscriptionBillingCycleCharge: {
        subscriptionBillingAttempt: { id: string; ready: boolean; errorMessage: string | null } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const chargeResult = chargeBody.data?.subscriptionBillingCycleCharge;
  const userErrors = chargeResult?.userErrors ?? [];
  const attempt = chargeResult?.subscriptionBillingAttempt;
  if (userErrors.length || !attempt) {
    throw new Error(`subscriptionBillingCycleCharge failed: ${JSON.stringify(userErrors)}`);
  }

  let orderName: string | null = null;
  let errorMessage: string | null = attempt.errorMessage;
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollResponse = await admin.graphql(BILLING_ATTEMPT_QUERY, { variables: { id: attempt.id } });
    const pollBody = (await pollResponse.json()) as {
      data?: {
        subscriptionBillingAttempt: {
          ready: boolean;
          errorMessage: string | null;
          order: { id: string; name: string } | null;
        } | null;
      };
    };
    const polled = pollBody.data?.subscriptionBillingAttempt;
    if (polled?.ready) {
      orderName = polled.order?.name ?? null;
      errorMessage = polled.errorMessage;
      break;
    }
  }

  const refreshedCycle = await findImmediateNextCycle(admin, contractShopifyId, nextCycle.index);
  await db.subscriptionContract.update({
    where: { shopifyId: contractShopifyId },
    data: { nextBillingDate: new Date(refreshedCycle.date) },
  });

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return { orderName, nextBillingDate: refreshedCycle.date };
}

const CANCEL_MUTATION = `#graphql
  mutation PortalCancelSubscription($id: ID!) {
    subscriptionContractCancel(subscriptionContractId: $id, actor: CUSTOMER) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Cancels a subscription contract on behalf of the logged-in portal customer.
 * Verifies the contract actually belongs to that customer before calling
 * Shopify -- the caller only ever supplies a contract id from the outside.
 */
export async function cancelPortalSubscription({
  shop,
  customerShopifyId,
  contractShopifyId,
  reason,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  reason: string;
}) {
  const contract = await db.subscriptionContract.findUnique({
    where: { shopifyId: contractShopifyId },
  });

  if (!contract || contract.shop !== shop || contract.customerShopifyId !== customerShopifyId) {
    throw new PortalOwnershipError("This subscription doesn't belong to your account.");
  }

  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(CANCEL_MUTATION, {
    variables: { id: contractShopifyId },
  });
  const body = (await response.json()) as {
    data?: {
      subscriptionContractCancel: {
        contract: { id: string; status: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };

  const result = body.data?.subscriptionContractCancel;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length || !result?.contract) {
    throw new Error(`subscriptionContractCancel failed: ${JSON.stringify(userErrors)}`);
  }

  await db.subscriptionContract.update({
    where: { shopifyId: contractShopifyId },
    data: {
      status: result.contract.status,
      cancelledAt: new Date(),
      cancellationReason: reason,
    },
  });
}

const MANAGE_OPTIONS_QUERY = `#graphql
  query PortalManageOptions($id: ID!) {
    subscriptionContract(id: $id) {
      nextBillingDate
      billingPolicy { interval intervalCount }
      customer {
        defaultAddress { countryCodeV2 }
        paymentMethods(first: 10, showRevoked: false) {
          edges {
            node {
              id
              instrument {
                ... on CustomerCreditCard { brand lastDigits }
              }
            }
          }
        }
      }
      customerPaymentMethod {
        id
        instrument {
          ... on CustomerCreditCard { brand lastDigits }
        }
      }
      deliveryMethod {
        ... on SubscriptionDeliveryMethodShipping {
          address {
            address1
            address2
            city
            provinceCode
            countryCodeV2
            zip
            firstName
            lastName
            phone
          }
        }
      }
      lines(first: 1) {
        nodes { id productId variantId variantTitle quantity }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query PortalProductVariants($id: ID!, $country: CountryCode) {
    product(id: $id) {
      title
      variants(first: 20) {
        edges {
          node {
            id
            title
            availableForSale
            image { url }
            contextualPricing(context: { country: $country }) {
              price { amount currencyCode }
            }
          }
        }
      }
    }
  }
`;

/**
 * ProductVariant.price is the shop's base currency, not what this customer is
 * actually charged -- a contract's currencyCode can be a market's presentment
 * currency (e.g. PKR) that's a completely different number. Always resolve
 * prices through contextualPricing keyed off the customer's own address,
 * never the raw base price, or subscription pricing silently breaks.
 */
export async function getPortalManageOptions({
  shop,
  customerShopifyId,
  contractShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
}) {
  const ownedContract = await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);
  const contractResponse = await admin.graphql(MANAGE_OPTIONS_QUERY, {
    variables: { id: contractShopifyId },
  });
  interface RawPaymentMethod {
    id: string;
    instrument: { brand?: string; lastDigits?: string } | null;
  }
  interface RawAddress {
    address1: string;
    address2: string | null;
    city: string;
    provinceCode: string | null;
    countryCodeV2: string;
    zip: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  }

  const contractBody = (await contractResponse.json()) as {
    data?: {
      subscriptionContract: {
        nextBillingDate: string | null;
        billingPolicy: { interval: string; intervalCount: number } | null;
        customer: {
          defaultAddress: { countryCodeV2: string | null } | null;
          paymentMethods: { edges: { node: RawPaymentMethod }[] };
        } | null;
        customerPaymentMethod: { id: string; instrument: RawPaymentMethod["instrument"] } | null;
        deliveryMethod: { address?: RawAddress } | null;
        lines: { nodes: { id: string; productId: string | null; variantId: string | null; quantity: number }[] };
      } | null;
    };
  };
  const contract = contractBody.data?.subscriptionContract;
  const line = contract?.lines.nodes[0];
  if (!line || !line.productId) {
    throw new Error("This subscription has no product line to manage.");
  }
  // The contract's own delivery address is what actually pins its billing
  // market/currency -- the customer's account-level default address can
  // differ (they may have other subscriptions, or changed it since), and
  // using it here would resolve contextualPricing into the wrong currency.
  const country =
    contract?.deliveryMethod?.address?.countryCodeV2 ?? contract?.customer?.defaultAddress?.countryCodeV2 ?? null;

  const describeInstrument = (instrument: RawPaymentMethod["instrument"]) =>
    instrument?.brand && instrument.lastDigits ? `${instrument.brand} •••• ${instrument.lastDigits}` : "On file";

  const currentPaymentMethodId = contract?.customerPaymentMethod?.id ?? null;
  const paymentMethods = (contract?.customer?.paymentMethods.edges ?? []).map((e) => ({
    id: e.node.id,
    display: describeInstrument(e.node.instrument),
    isCurrent: e.node.id === currentPaymentMethodId,
  }));
  const paymentMethodDisplay = contract?.customerPaymentMethod
    ? describeInstrument(contract.customerPaymentMethod.instrument)
    : null;

  const address = contract?.deliveryMethod?.address;
  const shippingAddressDisplay = address
    ? [address.address1, address.city, address.provinceCode, address.countryCodeV2]
        .filter(Boolean)
        .join(", ")
    : null;

  const productResponse = await admin.graphql(PRODUCT_VARIANTS_QUERY, {
    variables: { id: line.productId, country },
  });
  const productBody = (await productResponse.json()) as {
    data?: {
      product: {
        title: string;
        variants: {
          edges: {
            node: {
              id: string;
              title: string;
              availableForSale: boolean;
              image: { url: string } | null;
              contextualPricing: { price: { amount: string; currencyCode: string } };
            };
          }[];
        };
      } | null;
    };
  };
  const product = productBody.data?.product;

  // Same correction as the subscriptions list -- contract.nextBillingDate
  // from the GraphQL response above can't be trusted once a cycle's been
  // charged out-of-band (see findNextUnbilledCycle's doc comment).
  const correctedDate = await correctedNextBillingDate({ admin, contract: ownedContract });

  return {
    lineId: line.id,
    productId: line.productId,
    currentVariantId: line.variantId,
    quantity: line.quantity,
    productTitle: product?.title ?? "",
    variants: (product?.variants.edges ?? []).map((e) => ({
      id: e.node.id,
      title: e.node.title,
      price: e.node.contextualPricing.price.amount,
      currencyCode: e.node.contextualPricing.price.currencyCode,
      availableForSale: e.node.availableForSale,
      imageUrl: e.node.image?.url ?? null,
    })),
    billingInterval: contract?.billingPolicy?.interval ?? "DAY",
    billingIntervalCount: contract?.billingPolicy?.intervalCount ?? 1,
    nextBillingDate: correctedDate,
    paymentMethodDisplay,
    paymentMethods,
    shippingAddressDisplay,
    shippingAddress: address
      ? {
          address1: address.address1,
          address2: address.address2 ?? "",
          city: address.city,
          provinceCode: address.provinceCode ?? "",
          countryCode: address.countryCodeV2,
          zip: address.zip ?? "",
          firstName: address.firstName ?? "",
          lastName: address.lastName ?? "",
          phone: address.phone ?? "",
        }
      : null,
  };
}

const SWAPPABLE_PRODUCTS_QUERY = `#graphql
  query PortalSwappableProducts($ids: [ID!]!, $country: CountryCode) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredImage { url }
        variants(first: 20) {
          nodes {
            id
            title
            availableForSale
            contextualPricing(context: { country: $country }) {
              price { amount currencyCode }
            }
          }
        }
      }
    }
  }
`;

interface SwappableProductNode {
  id: string;
  title: string;
  featuredImage: { url: string } | null;
  variants: {
    nodes: {
      id: string;
      title: string;
      availableForSale: boolean;
      contextualPricing: { price: { amount: string; currencyCode: string } };
    }[];
  };
}

/**
 * Every other product configured for subscriptions through this app's own
 * selling-plans screen (not just any product that happens to have a Shopify
 * selling plan group from some other source) AND actually purchasable in
 * this contract's billing currency, for the manage-subscription modal's
 * "swap product" picker. Showing a product whose contextual price resolves
 * to a different currency for this customer would just dead-end at
 * swapPortalProductVariant's own currency-safety check, so it's filtered
 * out here instead.
 */
export async function listPortalSwappableProducts({
  shop,
  customerShopifyId,
  contractShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);

  const contractResponse = await admin.graphql(
    `#graphql
      query PortalSwapContractContext($id: ID!) {
        subscriptionContract(id: $id) {
          currencyCode
          customer { defaultAddress { countryCodeV2 } }
          deliveryMethod {
            ... on SubscriptionDeliveryMethodShipping {
              address { countryCodeV2 }
            }
          }
          lines(first: 1) { nodes { productId } }
        }
      }
    `,
    { variables: { id: contractShopifyId } },
  );
  const contractBody = (await contractResponse.json()) as {
    data?: {
      subscriptionContract: {
        currencyCode: string;
        customer: { defaultAddress: { countryCodeV2: string | null } | null } | null;
        deliveryMethod: { address?: { countryCodeV2: string } } | null;
        lines: { nodes: { productId: string | null }[] };
      } | null;
    };
  };
  const contract = contractBody.data?.subscriptionContract;
  const currencyCode = contract?.currencyCode ?? null;
  // Prefer the contract's own delivery address over the customer's
  // account-level default address -- see getPortalManageOptions for why.
  const country = contract?.deliveryMethod?.address?.countryCodeV2 ?? contract?.customer?.defaultAddress?.countryCodeV2 ?? null;
  const excludeProductId = contract?.lines.nodes[0]?.productId ?? null;

  const trackedGroups = await db.sellingPlanGroup.findMany({ where: { shop }, select: { productIds: true } });
  const trackedProductIds = new Set<string>();
  for (const group of trackedGroups) {
    for (const id of JSON.parse(group.productIds) as string[]) trackedProductIds.add(id);
  }
  trackedProductIds.delete(excludeProductId ?? "");
  if (trackedProductIds.size === 0) return [];

  const response = await admin.graphql(SWAPPABLE_PRODUCTS_QUERY, {
    variables: { ids: Array.from(trackedProductIds), country },
  });
  const body = (await response.json()) as {
    data?: { nodes: (SwappableProductNode | null)[] };
  };

  const byId = new Map<string, SwappableProductNode>();
  for (const product of body.data?.nodes ?? []) {
    if (product) byId.set(product.id, product);
  }

  return Array.from(byId.values())
    .map((product) => ({
      id: product.id,
      title: product.title,
      imageUrl: product.featuredImage?.url ?? null,
      variants: product.variants.nodes
        .filter((v) => v.availableForSale && (!currencyCode || v.contextualPricing.price.currencyCode === currencyCode))
        .map((v) => ({
          id: v.id,
          title: v.title,
          availableForSale: v.availableForSale,
          price: v.contextualPricing.price.amount,
        })),
    }))
    .filter((product) => product.variants.length > 0);
}

const CONTRACT_OPEN_DRAFT_MUTATION = `#graphql
  mutation PortalContractOpenDraft($id: ID!) {
    subscriptionContractUpdate(contractId: $id, actor: CUSTOMER) {
      draft { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_UPDATE_MUTATION = `#graphql
  mutation PortalDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
    subscriptionDraftUpdate(draftId: $draftId, input: $input) {
      draft { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_COMMIT_MUTATION = `#graphql
  mutation PortalDraftCommit($draftId: ID!) {
    subscriptionDraftCommit(draftId: $draftId) {
      contract { id }
      userErrors { field message }
    }
  }
`;

export type PortalAdmin = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

async function openPortalDraft(admin: PortalAdmin, contractShopifyId: string) {
  const response = await admin.graphql(CONTRACT_OPEN_DRAFT_MUTATION, {
    variables: { id: contractShopifyId },
  });
  const body = (await response.json()) as {
    data?: {
      subscriptionContractUpdate: {
        draft: { id: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const result = body.data?.subscriptionContractUpdate;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length || !result?.draft) {
    throw new Error(`subscriptionContractUpdate failed: ${JSON.stringify(userErrors)}`);
  }
  return result.draft.id;
}

async function commitPortalDraft(admin: PortalAdmin, draftId: string) {
  const response = await admin.graphql(DRAFT_COMMIT_MUTATION, { variables: { draftId } });
  const body = (await response.json()) as {
    data?: {
      subscriptionDraftCommit: {
        contract: { id: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const result = body.data?.subscriptionDraftCommit;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length || !result?.contract) {
    throw new Error(`subscriptionDraftCommit failed: ${JSON.stringify(userErrors)}`);
  }
}

const VALID_INTERVALS = new Set(["DAY", "WEEK", "MONTH", "YEAR"]);

export async function updatePortalDeliveryFrequency({
  shop,
  customerShopifyId,
  contractShopifyId,
  interval,
  intervalCount,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  interval: string;
  intervalCount: number;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  if (!VALID_INTERVALS.has(interval) || !Number.isInteger(intervalCount) || intervalCount < 1) {
    throw new Error("Invalid delivery frequency.");
  }

  const { admin } = await unauthenticated.admin(shop);
  const draftId = await openPortalDraft(admin, contractShopifyId);

  const updateResponse = await admin.graphql(DRAFT_UPDATE_MUTATION, {
    variables: {
      draftId,
      input: {
        billingPolicy: { interval, intervalCount },
        deliveryPolicy: { interval, intervalCount },
      },
    },
  });
  const updateBody = (await updateResponse.json()) as {
    data?: {
      subscriptionDraftUpdate: {
        draft: { id: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const updateErrors = updateBody.data?.subscriptionDraftUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`subscriptionDraftUpdate failed: ${JSON.stringify(updateErrors)}`);
  }

  await commitPortalDraft(admin, draftId);
  await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });
}

export async function updatePortalNextBillingDate({
  shop,
  customerShopifyId,
  contractShopifyId,
  nextBillingDate,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  nextBillingDate: string;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const parsed = new Date(nextBillingDate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid delivery date.");
  }

  const { admin } = await unauthenticated.admin(shop);
  const draftId = await openPortalDraft(admin, contractShopifyId);

  const updateResponse = await admin.graphql(DRAFT_UPDATE_MUTATION, {
    variables: { draftId, input: { nextBillingDate: parsed.toISOString() } },
  });
  const updateBody = (await updateResponse.json()) as {
    data?: { subscriptionDraftUpdate: { userErrors: { field: string[]; message: string }[] } };
  };
  const updateErrors = updateBody.data?.subscriptionDraftUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`subscriptionDraftUpdate failed: ${JSON.stringify(updateErrors)}`);
  }

  await commitPortalDraft(admin, draftId);
  await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });
}

const DRAFT_LINE_UPDATE_MUTATION = `#graphql
  mutation PortalDraftLineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
    subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
      draft { id }
      userErrors { field message }
    }
  }
`;

export async function updatePortalLineQuantity({
  shop,
  customerShopifyId,
  contractShopifyId,
  lineId,
  quantity,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  lineId: string;
  quantity: number;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Invalid quantity.");
  }

  const { admin } = await unauthenticated.admin(shop);
  const draftId = await openPortalDraft(admin, contractShopifyId);

  const updateResponse = await admin.graphql(DRAFT_LINE_UPDATE_MUTATION, {
    variables: { draftId, lineId, input: { quantity } },
  });
  const updateBody = (await updateResponse.json()) as {
    data?: { subscriptionDraftLineUpdate: { userErrors: { field: string[]; message: string }[] } };
  };
  const updateErrors = updateBody.data?.subscriptionDraftLineUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`subscriptionDraftLineUpdate failed: ${JSON.stringify(updateErrors)}`);
  }

  await commitPortalDraft(admin, draftId);
  await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });
}

const CUSTOMER_PAYMENT_METHODS_QUERY = `#graphql
  query PortalCustomerPaymentMethods($id: ID!) {
    customer(id: $id) {
      paymentMethods(first: 10, showRevoked: false) {
        edges { node { id } }
      }
    }
  }
`;

/**
 * Only lets the customer switch to a payment method they already have saved
 * with Shopify -- verified against their own customer record first, since
 * the caller only ever supplies an id from the outside. Adding a genuinely
 * new card isn't something this can do: raw card numbers must go through
 * Shopify's own hosted checkout, never our server, for PCI compliance.
 */
export async function updatePortalPaymentMethod({
  shop,
  customerShopifyId,
  contractShopifyId,
  paymentMethodId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  paymentMethodId: string;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);

  const ownedResponse = await admin.graphql(CUSTOMER_PAYMENT_METHODS_QUERY, {
    variables: { id: customerShopifyId },
  });
  const ownedBody = (await ownedResponse.json()) as {
    data?: { customer: { paymentMethods: { edges: { node: { id: string } }[] } } | null };
  };
  const ownedIds = new Set(
    (ownedBody.data?.customer?.paymentMethods.edges ?? []).map((e) => e.node.id),
  );
  if (!ownedIds.has(paymentMethodId)) {
    throw new Error("That payment method isn't on file for your account.");
  }

  const draftId = await openPortalDraft(admin, contractShopifyId);
  const updateResponse = await admin.graphql(DRAFT_UPDATE_MUTATION, {
    variables: { draftId, input: { paymentMethodId } },
  });
  const updateBody = (await updateResponse.json()) as {
    data?: { subscriptionDraftUpdate: { userErrors: { field: string[]; message: string }[] } };
  };
  const updateErrors = updateBody.data?.subscriptionDraftUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`subscriptionDraftUpdate failed: ${JSON.stringify(updateErrors)}`);
  }

  await commitPortalDraft(admin, draftId);
  await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });
}

export async function updatePortalShippingAddress({
  shop,
  customerShopifyId,
  contractShopifyId,
  address,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  address: {
    firstName: string;
    lastName: string;
    address1: string;
    address2: string;
    city: string;
    provinceCode: string;
    zip: string;
    countryCode: string;
    phone: string;
  };
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  if (!address.address1 || !address.city || !address.countryCode) {
    throw new Error("Address line, city, and country are required.");
  }

  const { admin } = await unauthenticated.admin(shop);
  const draftId = await openPortalDraft(admin, contractShopifyId);

  const updateResponse = await admin.graphql(DRAFT_UPDATE_MUTATION, {
    variables: {
      draftId,
      input: { deliveryMethod: { shipping: { address } } },
    },
  });
  const updateBody = (await updateResponse.json()) as {
    data?: { subscriptionDraftUpdate: { userErrors: { field: string[]; message: string }[] } };
  };
  const updateErrors = updateBody.data?.subscriptionDraftUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    throw new Error(`subscriptionDraftUpdate failed: ${JSON.stringify(updateErrors)}`);
  }

  await commitPortalDraft(admin, draftId);
  await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });
}

const PRODUCT_CHANGE_MUTATION = `#graphql
  mutation PortalProductChange($id: ID!, $lineId: ID!, $input: SubscriptionContractProductChangeInput!) {
    subscriptionContractProductChange(subscriptionContractId: $id, lineId: $lineId, input: $input, actor: CUSTOMER) {
      contract { id }
      userErrors { field message }
    }
  }
`;

export async function swapPortalProductVariant({
  shop,
  customerShopifyId,
  contractShopifyId,
  lineId,
  productVariantId,
}: {
  shop: string;
  customerShopifyId: string;
  contractShopifyId: string;
  lineId: string;
  productVariantId: string;
}) {
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);

  const contractCurrencyResponse = await admin.graphql(
    `#graphql
      query PortalContractCurrency($id: ID!) {
        subscriptionContract(id: $id) {
          currencyCode
          customer { defaultAddress { countryCodeV2 } }
          deliveryMethod {
            ... on SubscriptionDeliveryMethodShipping {
              address { countryCodeV2 }
            }
          }
        }
      }
    `,
    { variables: { id: contractShopifyId } },
  );
  const contractCurrencyBody = (await contractCurrencyResponse.json()) as {
    data?: {
      subscriptionContract: {
        currencyCode: string;
        customer: { defaultAddress: { countryCodeV2: string | null } | null } | null;
        deliveryMethod: { address?: { countryCodeV2: string } } | null;
      } | null;
    };
  };
  const contractInfo = contractCurrencyBody.data?.subscriptionContract;
  // Prefer the contract's own delivery address over the customer's
  // account-level default address -- see getPortalManageOptions for why.
  const country =
    contractInfo?.deliveryMethod?.address?.countryCodeV2 ?? contractInfo?.customer?.defaultAddress?.countryCodeV2 ?? null;

  // ProductVariant.price is the shop's base currency, which is NOT what this
  // customer is billed if the contract is in a market's presentment currency
  // (e.g. PKR) -- always resolve through contextualPricing for the customer's
  // own country, never the raw base price.
  const variantResponse = await admin.graphql(
    `#graphql
      query PortalVariantPrice($id: ID!, $country: CountryCode) {
        productVariant(id: $id) {
          availableForSale
          contextualPricing(context: { country: $country }) {
            price { amount currencyCode }
          }
        }
      }
    `,
    { variables: { id: productVariantId, country } },
  );
  const variantBody = (await variantResponse.json()) as {
    data?: {
      productVariant: {
        availableForSale: boolean;
        contextualPricing: { price: { amount: string; currencyCode: string } };
      } | null;
    };
  };
  const variant = variantBody.data?.productVariant;
  if (!variant) {
    throw new Error("That option is no longer available.");
  }
  if (!variant.availableForSale) {
    throw new Error("That option is currently out of stock.");
  }
  if (contractInfo && variant.contextualPricing.price.currencyCode !== contractInfo.currencyCode) {
    throw new Error("Could not confirm pricing for that option in your currency. Please try again.");
  }

  const response = await admin.graphql(PRODUCT_CHANGE_MUTATION, {
    variables: {
      id: contractShopifyId,
      lineId,
      input: { productVariantId, currentPrice: variant.contextualPricing.price.amount },
    },
  });
  const body = (await response.json()) as {
    data?: {
      subscriptionContractProductChange: {
        contract: { id: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const userErrors = body.data?.subscriptionContractProductChange?.userErrors ?? [];
  if (userErrors.length || !body.data?.subscriptionContractProductChange?.contract) {
    throw new Error(`subscriptionContractProductChange failed: ${JSON.stringify(userErrors)}`);
  }

  await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });
}
