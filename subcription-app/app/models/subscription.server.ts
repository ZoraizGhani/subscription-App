import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import type {
  BillingAttemptWebhookPayload,
  OrderWebhookPayload,
} from "./webhookPayloads";

/**
 * Subscription webhook payloads only carry ids and a status, so handlers read
 * the contract back from the Admin API and mirror the result into our database.
 */
const SUBSCRIPTION_CONTRACT_QUERY = `#graphql
  query SubscriptionContractForSync($id: ID!) {
    subscriptionContract(id: $id) {
      id
      status
      currencyCode
      nextBillingDate
      lastPaymentStatus
      customer {
        id
        email
        displayName
      }
      originOrder {
        id
      }
      billingPolicy {
        interval
        intervalCount
      }
      lines(first: 50) {
        nodes {
          id
          title
          variantTitle
          variantId
          quantity
          sellingPlanId
          sellingPlanName
          currentPrice {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

interface ContractLine {
  id: string;
  title: string;
  variantTitle: string | null;
  variantId: string | null;
  quantity: number;
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  currentPrice: { amount: string; currencyCode: string } | null;
}

interface ContractNode {
  id: string;
  status: string;
  currencyCode: string;
  nextBillingDate: string | null;
  lastPaymentStatus: string | null;
  customer: { id: string; email: string | null; displayName: string | null } | null;
  originOrder: { id: string } | null;
  billingPolicy: { interval: string; intervalCount: number } | null;
  lines: { nodes: ContractLine[] };
}

/**
 * Fetch a contract from Shopify and upsert our mirror of it. Returns null when
 * the contract is gone (deleted, or the app lost access to it).
 */
export async function syncSubscriptionContract({
  graphql,
  shop,
  contractId,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  contractId: string;
}) {
  const response = await graphql(SUBSCRIPTION_CONTRACT_QUERY, {
    variables: { id: contractId },
  });

  const body = (await response.json()) as {
    data?: { subscriptionContract: ContractNode | null };
    errors?: unknown;
  };

  if (body.errors) {
    throw new Error(
      `subscriptionContract query failed for ${contractId}: ${JSON.stringify(body.errors)}`,
    );
  }

  const contract = body.data?.subscriptionContract;
  if (!contract) {
    return null;
  }

  const lines = contract.lines.nodes;
  const totalAmount = lines.reduce(
    (sum, line) => sum + Number(line.currentPrice?.amount ?? 0) * line.quantity,
    0,
  );

  // Read the current mirror so status timestamps are stamped once, on the
  // transition, instead of being refreshed by every later sync of the same status.
  const existing = await db.subscriptionContract.findUnique({
    where: { shopifyId: contract.id },
    select: { pausedAt: true, cancelledAt: true },
  });

  const stamp = (isCurrent: boolean, previous: Date | null | undefined) =>
    isCurrent ? (previous ?? new Date()) : null;

  const fields = {
    shop,
    shopifyId: contract.id,
    customerShopifyId: contract.customer?.id ?? null,
    customerEmail: contract.customer?.email ?? null,
    customerName: contract.customer?.displayName ?? null,
    status: contract.status,
    currencyCode: contract.currencyCode,
    nextBillingDate: contract.nextBillingDate
      ? new Date(contract.nextBillingDate)
      : null,
    billingInterval: contract.billingPolicy?.interval ?? null,
    billingIntervalCount: contract.billingPolicy?.intervalCount ?? null,
    originOrderShopifyId: contract.originOrder?.id ?? null,
    lastPaymentStatus: contract.lastPaymentStatus ?? null,
    totalAmount,
    linesJson: JSON.stringify(lines),
    pausedAt: stamp(contract.status === "PAUSED", existing?.pausedAt),
    cancelledAt: stamp(contract.status === "CANCELLED", existing?.cancelledAt),
  };

  return db.subscriptionContract.upsert({
    where: { shopifyId: contract.id },
    update: fields,
    create: fields,
  });
}

/**
 * Billing attempt payloads normally carry the contract as a GID, but fall back to
 * building one from the numeric id so a payload shape change can't drop the link.
 */
export function contractIdFromBillingAttempt(
  payload: BillingAttemptWebhookPayload,
) {
  if (payload.admin_graphql_api_subscription_contract_id) {
    return payload.admin_graphql_api_subscription_contract_id;
  }
  if (payload.subscription_contract_id) {
    return `gid://shopify/SubscriptionContract/${payload.subscription_contract_id}`;
  }
  return null;
}

export async function recordBillingAttempt({
  shop,
  status,
  payload,
}: {
  shop: string;
  status: "SUCCESS" | "FAILURE";
  payload: BillingAttemptWebhookPayload;
}) {
  const shopifyId = payload.admin_graphql_api_id ?? null;
  const contractShopifyId = contractIdFromBillingAttempt(payload);

  // Only link to a contract we already mirror, otherwise the relation write fails.
  const contract = contractShopifyId
    ? await db.subscriptionContract.findUnique({
        where: { shopifyId: contractShopifyId },
        select: { shopifyId: true, currencyCode: true },
      })
    : null;

  const data = {
    shop,
    shopifyId,
    contractShopifyId: contract?.shopifyId ?? null,
    status,
    orderShopifyId: payload.admin_graphql_api_order_id ?? null,
    amount: payload.amount != null ? Number(payload.amount) : null,
    currencyCode: payload.currency ?? contract?.currencyCode ?? null,
    errorCode: payload.error_code ?? null,
    errorMessage: payload.error_message ?? null,
    attemptedAt: payload.created_at ? new Date(payload.created_at) : new Date(),
  };

  if (!shopifyId) {
    return db.billingAttempt.create({ data });
  }

  return db.billingAttempt.upsert({
    where: { shopifyId },
    update: data,
    create: data,
  });
}

const ORDER_SUBSCRIPTION_LINES_QUERY = `#graphql
  query OrderSubscriptionLines($id: ID!) {
    order(id: $id) {
      id
      lineItems(first: 50) {
        nodes {
          id
          contract {
            id
          }
          sellingPlan {
            sellingPlanId
            name
          }
        }
      }
    }
  }
`;

/**
 * `orders/create` fires for every order, and the payload does not reliably say
 * whether a line came from a subscription. Ask the Admin API instead: a line item
 * that belongs to a subscription exposes the contract it was billed against.
 *
 * Returns the contract GID, or null for a plain one-time order.
 */
export async function findOrderContractId({
  graphql,
  orderId,
}: {
  graphql: AdminGraphqlClient;
  orderId: string;
}) {
  const response = await graphql(ORDER_SUBSCRIPTION_LINES_QUERY, {
    variables: { id: orderId },
  });

  const body = (await response.json()) as {
    data?: {
      order: {
        lineItems: { nodes: { contract: { id: string } | null }[] };
      } | null;
    };
  };

  const nodes = body.data?.order?.lineItems.nodes ?? [];
  return nodes.find((node) => node.contract?.id)?.contract?.id ?? null;
}

/**
 * Record an order that came from a subscription. Callers must confirm the order
 * actually has subscription lines -- see findOrderContractId.
 */
export async function recordSubscriptionOrder({
  shop,
  payload,
  contractShopifyId,
}: {
  shop: string;
  payload: OrderWebhookPayload;
  contractShopifyId: string | null;
}) {
  const orderShopifyId =
    payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`;

  const data = {
    shop,
    orderShopifyId,
    orderName: payload.name ?? null,
    contractShopifyId,
    totalPrice: payload.total_price != null ? Number(payload.total_price) : null,
    currencyCode: payload.currency ?? null,
    processedAt: payload.processed_at ? new Date(payload.processed_at) : new Date(),
  };

  return db.subscriptionOrder.upsert({
    where: { orderShopifyId },
    update: data,
    create: data,
  });
}