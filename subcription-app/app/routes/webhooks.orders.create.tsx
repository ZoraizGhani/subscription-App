import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { isDuplicateWebhook } from "../models/webhook.server";
import {
  findOrderContractId,
  recordSubscriptionOrder,
  tagOrderAsSubscription,
} from "../models/subscription.server";
import type { OrderWebhookPayload } from "../models/webhookPayloads";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, admin } =
    await authenticate.webhook(request);

  if (await isDuplicateWebhook({ webhookId, shop, topic })) {
    return new Response();
  }

  const order = (payload ?? {}) as OrderWebhookPayload;
  const orderId = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;

  if (!admin) {
    console.warn(`${topic}: skipped for ${shop} (no admin client)`);
    return new Response();
  }

  // Every order fires this webhook. Only recurring ones are ours to track.
  const contractShopifyId = await findOrderContractId({
    graphql: admin.graphql,
    orderId,
  });

  if (!contractShopifyId) {
    return new Response();
  }

  await Promise.all([
    recordSubscriptionOrder({ shop, payload: order, contractShopifyId }),
    tagOrderAsSubscription({ graphql: admin.graphql, orderId }),
  ]);

  return new Response();
};