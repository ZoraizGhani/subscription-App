import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { isDuplicateWebhook } from "../models/webhook.server";
import {
  contractIdFromBillingAttempt,
  recordBillingAttempt,
  syncSubscriptionContract,
} from "../models/subscription.server";
import type { BillingAttemptWebhookPayload } from "../models/webhookPayloads";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, admin } =
    await authenticate.webhook(request);

  if (await isDuplicateWebhook({ webhookId, shop, topic })) {
    return new Response();
  }

  const attempt = (payload ?? {}) as BillingAttemptWebhookPayload;

  await recordBillingAttempt({ shop, status: "FAILURE", payload: attempt });

  // Refresh the contract so lastPaymentStatus/status reflect the failure. Retry
  // scheduling (dunning) reads ShopSettings and is not built yet.
  const contractId = contractIdFromBillingAttempt(attempt);
  if (admin && contractId) {
    await syncSubscriptionContract({
      graphql: admin.graphql,
      shop,
      contractId,
    });
  }

  return new Response();
};