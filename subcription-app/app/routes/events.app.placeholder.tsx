import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Shopify's Events subscription feature is unrelated to this app's actual
 * webhooks (see routes/webhooks.*.tsx) and this app has no real use for it --
 * this handler exists only because shopify.app.toml's [events] block became
 * a required section for this app's config, and a subscription needs a real,
 * responding endpoint. Deliberately subscribed to a low-frequency, harmless
 * topic; the payload is discarded.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  return new Response();
};
