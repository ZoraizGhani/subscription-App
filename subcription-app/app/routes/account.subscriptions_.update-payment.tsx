import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import { getPortalPaymentMethodUpdateUrl } from "../models/portalSubscription.server";

/**
 * Plain GET redirect, not a fetcher/action -- the "update your payment
 * method" link on a failed-payment banner just navigates here directly, and
 * this sends the browser straight on to Shopify's own hosted card-update
 * page. Falls back to the subscriptions list (with the reason in the query
 * string) rather than a raw error page if the URL couldn't be generated.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);
  const url = new URL(request.url);
  const contractShopifyId = url.searchParams.get("contractId") ?? "";

  if (!customer?.customerShopifyId || !contractShopifyId) {
    return redirect("/account/subscriptions");
  }

  try {
    const updateUrl = await getPortalPaymentMethodUpdateUrl({
      shop: session.shop,
      customerShopifyId: customer.customerShopifyId,
      contractShopifyId,
    });
    return redirect(updateUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open the payment update page.";
    return redirect(`/account/subscriptions?paymentUpdateError=${encodeURIComponent(message)}`);
  }
};
