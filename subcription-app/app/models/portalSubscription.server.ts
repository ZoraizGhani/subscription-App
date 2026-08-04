import { unauthenticated } from "../shopify.server";
import db from "../db.server";

export class PortalOwnershipError extends Error {}

interface ContractLine {
  title: string;
  variantTitle?: string | null;
  quantity: number;
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

  return contracts.map((c) => ({
    contractShopifyId: c.shopifyId,
    productTitle: firstLineTitle(c.linesJson),
    status: c.status,
    totalAmount: c.totalAmount,
    currencyCode: c.currencyCode,
    nextBillingDate: c.nextBillingDate,
    billingInterval: c.billingInterval,
    billingIntervalCount: c.billingIntervalCount,
    cancellationReason: c.cancellationReason,
  }));
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
