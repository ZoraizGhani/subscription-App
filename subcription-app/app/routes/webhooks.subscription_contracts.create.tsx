import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { isDuplicateWebhook } from "../models/webhook.server";
import { syncSubscriptionContract } from "../models/subscription.server";
import type { SubscriptionContractWebhookPayload } from "../models/webhookPayloads";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, admin } =
    await authenticate.webhook(request);

  if (await isDuplicateWebhook({ webhookId, shop, topic })) {
    return new Response();
  }

  // `admin` is undefined if the app has since been uninstalled from the shop.
  const contract = (payload ?? {}) as SubscriptionContractWebhookPayload;
  const contractId = contract.admin_graphql_api_id;
  if (!admin || !contractId) {
    console.warn(`${topic}: skipped for ${shop} (no admin client or contract id)`);
    return new Response();
  }

  await syncSubscriptionContract({
    graphql: admin.graphql,
    shop,
    contractId,
  });

  return new Response();
};