import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { syncSubscriptionContract } from "./subscription.server";

interface ContractLine {
  title: string;
  quantity: number;
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

export class QuickReviewNotFoundError extends Error {}

export interface QuickReviewData {
  contractShopifyId: string;
  contractNumber: string;
  customerName: string;
  productTitle: string;
  status: string;
  lineId: string | null;
  quantity: number;
  nextBillingDate: string | null;
  billingInterval: string;
  billingIntervalCount: number;
  totalAmount: number | null;
  currencyCode: string;
  hasPaymentMethod: boolean;
}

const QUICK_REVIEW_LIVE_QUERY = `#graphql
  query AdminQuickReview($id: ID!) {
    subscriptionContract(id: $id) {
      customerPaymentMethod { id }
      lines(first: 1) { nodes { id } }
    }
  }
`;

/**
 * Admin-side counterpart to the customer portal's manage options -- same
 * shape of data, but scoped by shop ownership only (no customer-ownership
 * check, since this is the merchant acting on their own contracts).
 */
export async function getQuickReviewData({
  graphql,
  shop,
  contractShopifyId,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  contractShopifyId: string;
}): Promise<QuickReviewData> {
  const contract = await db.subscriptionContract.findUnique({ where: { shopifyId: contractShopifyId } });
  if (!contract || contract.shop !== shop) {
    throw new QuickReviewNotFoundError("This subscription doesn't belong to your shop.");
  }

  const line = firstLine(contract.linesJson);

  const response = await graphql(QUICK_REVIEW_LIVE_QUERY, { variables: { id: contractShopifyId } });
  const body = (await response.json()) as {
    data?: {
      subscriptionContract: {
        customerPaymentMethod: { id: string } | null;
        lines: { nodes: { id: string }[] };
      } | null;
    };
  };
  const live = body.data?.subscriptionContract;

  return {
    contractShopifyId: contract.shopifyId,
    contractNumber: `#${contract.shopifyId.split("/").pop()}`,
    customerName: contract.customerName ?? "Unknown",
    productTitle: line?.title ?? "Subscription",
    status: contract.status,
    lineId: live?.lines.nodes[0]?.id ?? null,
    quantity: line?.quantity ?? 1,
    nextBillingDate: contract.nextBillingDate ? contract.nextBillingDate.toISOString() : null,
    billingInterval: contract.billingInterval ?? "DAY",
    billingIntervalCount: contract.billingIntervalCount ?? 1,
    totalAmount: contract.totalAmount,
    currencyCode: contract.currencyCode,
    hasPaymentMethod: Boolean(live?.customerPaymentMethod?.id),
  };
}

async function assertShopOwnsContract(shop: string, contractShopifyId: string) {
  const contract = await db.subscriptionContract.findUnique({ where: { shopifyId: contractShopifyId } });
  if (!contract || contract.shop !== shop) {
    throw new QuickReviewNotFoundError("This subscription doesn't belong to your shop.");
  }
  return contract;
}

const DRAFT_OPEN_MUTATION = `#graphql
  mutation AdminOpenDraft($id: ID!) {
    subscriptionContractUpdate(contractId: $id) {
      draft { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_COMMIT_MUTATION = `#graphql
  mutation AdminDraftCommit($draftId: ID!) {
    subscriptionDraftCommit(draftId: $draftId) {
      contract { id }
      userErrors { field message }
    }
  }
`;

async function openDraft(graphql: AdminGraphqlClient, contractShopifyId: string) {
  const response = await graphql(DRAFT_OPEN_MUTATION, { variables: { id: contractShopifyId } });
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

async function commitDraft(graphql: AdminGraphqlClient, draftId: string) {
  const response = await graphql(DRAFT_COMMIT_MUTATION, { variables: { draftId } });
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

const DRAFT_UPDATE_MUTATION = `#graphql
  mutation AdminDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
    subscriptionDraftUpdate(draftId: $draftId, input: $input) {
      draft { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_LINE_UPDATE_MUTATION = `#graphql
  mutation AdminDraftLineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
    subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
      draft { id }
      userErrors { field message }
    }
  }
`;

/**
 * Bundles next-delivery-date, frequency, and quantity into one draft/commit --
 * same reasoning as the customer portal's "saveChanges": whichever fields are
 * actually provided get applied, so the merchant can change just one thing
 * without needing to resend the others.
 */
export async function updateContractQuickEdit({
  graphql,
  shop,
  contractShopifyId,
  lineId,
  nextBillingDate,
  interval,
  intervalCount,
  quantity,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  contractShopifyId: string;
  lineId: string | null;
  nextBillingDate?: string;
  interval?: string;
  intervalCount?: number;
  quantity?: number;
}) {
  await assertShopOwnsContract(shop, contractShopifyId);

  const draftId = await openDraft(graphql, contractShopifyId);

  if (nextBillingDate || (interval && intervalCount)) {
    const input: Record<string, unknown> = {};
    if (nextBillingDate) input.nextBillingDate = nextBillingDate;
    if (interval && intervalCount) {
      input.billingPolicy = { interval, intervalCount };
      input.deliveryPolicy = { interval, intervalCount };
    }
    const response = await graphql(DRAFT_UPDATE_MUTATION, { variables: { draftId, input } });
    const body = (await response.json()) as {
      data?: { subscriptionDraftUpdate: { userErrors: { field: string[]; message: string }[] } };
    };
    const userErrors = body.data?.subscriptionDraftUpdate?.userErrors ?? [];
    if (userErrors.length) {
      throw new Error(`subscriptionDraftUpdate failed: ${JSON.stringify(userErrors)}`);
    }
  }

  if (quantity != null && lineId) {
    const response = await graphql(DRAFT_LINE_UPDATE_MUTATION, {
      variables: { draftId, lineId, input: { quantity } },
    });
    const body = (await response.json()) as {
      data?: { subscriptionDraftLineUpdate: { userErrors: { field: string[]; message: string }[] } };
    };
    const userErrors = body.data?.subscriptionDraftLineUpdate?.userErrors ?? [];
    if (userErrors.length) {
      throw new Error(`subscriptionDraftLineUpdate failed: ${JSON.stringify(userErrors)}`);
    }
  }

  await commitDraft(graphql, draftId);
  await syncSubscriptionContract({ graphql, shop, contractId: contractShopifyId });
}

const DISCOUNT_ADD_MUTATION = `#graphql
  mutation AdminDraftDiscountAdd($draftId: ID!, $input: SubscriptionManualDiscountInput!) {
    subscriptionDraftDiscountAdd(draftId: $draftId, input: $input) {
      draft { id }
      userErrors { field message }
    }
  }
`;

export async function applyContractDiscount({
  graphql,
  shop,
  contractShopifyId,
  percentage,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  contractShopifyId: string;
  percentage: number;
}) {
  await assertShopOwnsContract(shop, contractShopifyId);

  const draftId = await openDraft(graphql, contractShopifyId);
  const response = await graphql(DISCOUNT_ADD_MUTATION, {
    variables: {
      draftId,
      input: { title: `${percentage}% discount`, value: { percentage }, entitledLines: { all: true } },
    },
  });
  const body = (await response.json()) as {
    data?: { subscriptionDraftDiscountAdd: { userErrors: { field: string[]; message: string }[] } };
  };
  const userErrors = body.data?.subscriptionDraftDiscountAdd?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`subscriptionDraftDiscountAdd failed: ${JSON.stringify(userErrors)}`);
  }

  await commitDraft(graphql, draftId);
  await syncSubscriptionContract({ graphql, shop, contractId: contractShopifyId });
}

const PAUSE_MUTATION = `#graphql
  mutation AdminPauseContract($id: ID!) {
    subscriptionContractPause(subscriptionContractId: $id) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

export async function pauseContractAdmin({
  graphql,
  shop,
  contractShopifyId,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  contractShopifyId: string;
}) {
  await assertShopOwnsContract(shop, contractShopifyId);

  const response = await graphql(PAUSE_MUTATION, { variables: { id: contractShopifyId } });
  const body = (await response.json()) as {
    data?: {
      subscriptionContractPause: {
        contract: { id: string; status: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const result = body.data?.subscriptionContractPause;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length || !result?.contract) {
    throw new Error(`subscriptionContractPause failed: ${JSON.stringify(userErrors)}`);
  }

  await db.subscriptionContract.update({
    where: { shopifyId: contractShopifyId },
    data: { status: result.contract.status, pausedAt: new Date() },
  });
}

const PAYMENT_METHOD_QUERY = `#graphql
  query AdminContractPaymentMethod($id: ID!) {
    subscriptionContract(id: $id) {
      customerPaymentMethod { id }
    }
  }
`;

const RESEND_PAYMENT_LINK_MUTATION = `#graphql
  mutation AdminResendPaymentLink($id: ID!) {
    customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $id) {
      customer { id }
      userErrors { field message }
    }
  }
`;

/**
 * Re-resolves the customer's payment method live rather than trusting
 * whatever the quick-review load saw -- it could have been revoked or
 * replaced since.
 */
export async function resendPaymentLink({
  graphql,
  shop,
  contractShopifyId,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  contractShopifyId: string;
}) {
  await assertShopOwnsContract(shop, contractShopifyId);

  const response = await graphql(PAYMENT_METHOD_QUERY, { variables: { id: contractShopifyId } });
  const body = (await response.json()) as {
    data?: { subscriptionContract: { customerPaymentMethod: { id: string } | null } | null };
  };
  const paymentMethodId = body.data?.subscriptionContract?.customerPaymentMethod?.id;
  if (!paymentMethodId) {
    throw new Error("No payment method on file for this customer.");
  }

  const sendResponse = await graphql(RESEND_PAYMENT_LINK_MUTATION, { variables: { id: paymentMethodId } });
  const sendBody = (await sendResponse.json()) as {
    data?: {
      customerPaymentMethodSendUpdateEmail: {
        customer: { id: string } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const userErrors = sendBody.data?.customerPaymentMethodSendUpdateEmail?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`customerPaymentMethodSendUpdateEmail failed: ${JSON.stringify(userErrors)}`);
  }
}
