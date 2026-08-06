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

function firstLineTitle(linesJson: string | null): string {
  if (!linesJson) return "Subscription";
  try {
    const lines = JSON.parse(linesJson) as ContractLine[];
    return lines[0]?.title ?? "Subscription";
  } catch {
    return "Subscription";
  }
}

function firstLineProductId(linesJson: string | null): string | null {
  if (!linesJson) return null;
  try {
    const lines = JSON.parse(linesJson) as ContractLine[];
    return lines[0]?.productId ?? null;
  } catch {
    return null;
  }
}

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

  const orders = await db.subscriptionOrder.findMany({
    where: { shop, contractShopifyId: { in: contracts.map((c) => c.shopifyId) } },
    orderBy: { processedAt: "desc" },
    take: 5,
  });

  const activeContracts = contracts.filter((c) => c.status === "ACTIVE");
  const nextCharge = activeContracts
    .map((c) => c.nextBillingDate)
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    activeCount: activeContracts.length,
    nextChargeDate: nextCharge ?? null,
    lifetimeOrders: orders.length,
    activeSubscription: activeContracts[0]
      ? {
          contractShopifyId: activeContracts[0].shopifyId,
          productTitle: firstLineTitle(activeContracts[0].linesJson),
          nextBillingDate: activeContracts[0].nextBillingDate,
          status: activeContracts[0].status,
        }
      : null,
    recentOrders: orders.map((o) => ({
      orderShopifyId: o.orderShopifyId,
      orderName: o.orderName,
      processedAt: o.processedAt,
      totalPrice: o.totalPrice,
      currencyCode: o.currencyCode,
    })),
  };
}

const PRODUCT_HANDLES_QUERY = `#graphql
  query PortalProductHandles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id handle }
    }
  }
`;

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
  if (productIds.length) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const response = await admin.graphql(PRODUCT_HANDLES_QUERY, { variables: { ids: productIds } });
      const body = (await response.json()) as {
        data?: { nodes: ({ id: string; handle: string } | null)[] };
      };
      for (const node of body.data?.nodes ?? []) {
        if (node) handleByProductId.set(node.id, node.handle);
      }
    } catch {
      // Product links are a convenience -- if this lookup fails, the list
      // still renders fine without a storefront link.
    }
  }

  return contracts.map((c) => {
    const productId = firstLineProductId(c.linesJson);
    return {
      contractShopifyId: c.shopifyId,
      productTitle: firstLineTitle(c.linesJson),
      productHandle: productId ? (handleByProductId.get(productId) ?? null) : null,
      status: c.status,
      totalAmount: c.totalAmount,
      currencyCode: c.currencyCode,
      nextBillingDate: c.nextBillingDate,
      billingInterval: c.billingInterval,
      billingIntervalCount: c.billingIntervalCount,
      cancellationReason: c.cancellationReason,
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

  return orders.map((o) => ({
    orderShopifyId: o.orderShopifyId,
    orderName: o.orderName,
    processedAt: o.processedAt,
    totalPrice: o.totalPrice,
    currencyCode: o.currencyCode,
    productTitle: o.contractShopifyId ? titleByContract.get(o.contractShopifyId) : null,
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

  const refreshedCycle = await findNextUnbilledCycle(admin, contractShopifyId);
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

  const hoursUntilDue = (new Date(nextCycle.date).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntilDue > 24) {
    throw new Error(
      "Ship Now only works within 24 hours of your next scheduled charge -- it's too early to charge this order yet.",
    );
  }

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

  const refreshedCycle = await findNextUnbilledCycle(admin, contractShopifyId);
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
      customer { defaultAddress { countryCodeV2 } }
      customerPaymentMethod {
        instrument {
          ... on CustomerCreditCard { brand lastDigits }
        }
      }
      deliveryMethod {
        ... on SubscriptionDeliveryMethodShipping {
          address { address1 city provinceCode countryCodeV2 }
        }
      }
      lines(first: 1) {
        nodes { id productId variantId variantTitle }
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
  await assertOwnedActiveContract({ shop, customerShopifyId, contractShopifyId });

  const { admin } = await unauthenticated.admin(shop);
  const contractResponse = await admin.graphql(MANAGE_OPTIONS_QUERY, {
    variables: { id: contractShopifyId },
  });
  const contractBody = (await contractResponse.json()) as {
    data?: {
      subscriptionContract: {
        nextBillingDate: string | null;
        billingPolicy: { interval: string; intervalCount: number } | null;
        customer: { defaultAddress: { countryCodeV2: string | null } | null } | null;
        customerPaymentMethod: {
          instrument: { brand?: string; lastDigits?: string } | null;
        } | null;
        deliveryMethod: {
          address?: { address1: string; city: string; provinceCode: string | null; countryCodeV2: string };
        } | null;
        lines: { nodes: { id: string; productId: string | null; variantId: string | null }[] };
      } | null;
    };
  };
  const contract = contractBody.data?.subscriptionContract;
  const line = contract?.lines.nodes[0];
  if (!line || !line.productId) {
    throw new Error("This subscription has no product line to manage.");
  }
  const country = contract?.customer?.defaultAddress?.countryCodeV2 ?? null;

  const cardInstrument = contract?.customerPaymentMethod?.instrument;
  const paymentMethodDisplay =
    cardInstrument?.brand && cardInstrument.lastDigits
      ? `${cardInstrument.brand} •••• ${cardInstrument.lastDigits}`
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
              contextualPricing: { price: { amount: string; currencyCode: string } };
            };
          }[];
        };
      } | null;
    };
  };
  const product = productBody.data?.product;

  return {
    lineId: line.id,
    currentVariantId: line.variantId,
    productTitle: product?.title ?? "",
    variants: (product?.variants.edges ?? []).map((e) => ({
      id: e.node.id,
      title: e.node.title,
      price: e.node.contextualPricing.price.amount,
      currencyCode: e.node.contextualPricing.price.currencyCode,
      availableForSale: e.node.availableForSale,
    })),
    billingInterval: contract?.billingPolicy?.interval ?? "DAY",
    billingIntervalCount: contract?.billingPolicy?.intervalCount ?? 1,
    nextBillingDate: contract?.nextBillingDate ?? null,
    paymentMethodDisplay,
    shippingAddressDisplay,
  };
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
      } | null;
    };
  };
  const contractInfo = contractCurrencyBody.data?.subscriptionContract;
  const country = contractInfo?.customer?.defaultAddress?.countryCodeV2 ?? null;

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
