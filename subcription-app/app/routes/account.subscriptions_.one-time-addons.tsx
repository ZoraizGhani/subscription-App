import type { LoaderFunctionArgs } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import { listPortalOneTimeAddonOptions, PortalOwnershipError } from "../models/portalSubscription.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);
  const url = new URL(request.url);
  const contractShopifyId = url.searchParams.get("contractId") ?? "";

  if (!customer?.customerShopifyId) {
    return Response.json({ error: "No linked subscription." }, { status: 400 });
  }

  try {
    const options = await listPortalOneTimeAddonOptions({
      shop: session.shop,
      customerShopifyId: customer.customerShopifyId,
      contractShopifyId,
    });
    return Response.json(options);
  } catch (error) {
    if (error instanceof PortalOwnershipError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Something went wrong." },
      { status: 500 },
    );
  }
};
